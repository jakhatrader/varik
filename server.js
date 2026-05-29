/*
 * Proof of VARIATIONAL — backend (accumulating full-history index)
 *
 * How it works (same idea as proofofhype):
 *  1. BACKFILL: walk X search history backward (newest→oldest) all the way to the
 *     FIRST ever Variational-related tweet, storing every one in a persistent index.
 *     This is a ONE-TIME cost. It runs in resumable chunks so it never times out.
 *  2. INCREMENTAL: every refresh, fetch only tweets NEWER than the newest one we
 *     already have. Cheap, runs forever.
 *  3. The leaderboard + every profile are computed from the accumulated index,
 *     so visitors and profile clicks cost ZERO API calls.
 *
 * PERSISTENCE (free external store): set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * and the index is stored in Upstash Redis (survives restarts/redeploys on free hosts
 * like Render). Without those vars it falls back to a local file (STORE_FILE), which is
 * wiped on ephemeral hosts — so for Render free tier, use Upstash.
 *
 * Endpoints:
 *   GET /api/leaderboard       -> { totals, users[], window, updateIntervalHours, generatedAt, nextUpdateAt }
 *   GET /api/user?handle=NAME  -> { user, rank }   (alias /api/scan) — served from the index
 *   GET /api/health            -> { ok, hasKey, store, indexed, backfillComplete, ... }
 *   /u/<handle>                -> serves the single-page app
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const PORT = parseInt(process.env.PORT || '3000', 10);
const KEY = process.env.TWITTERAPI_KEY || '';
// History floor. EMPTY = index everything back to the very first Variational tweet
// (i.e. from @variational_io's first post). Set a date like 2024-01-01 to limit it.
const SINCE_DATE = process.env.SINCE_DATE || '';
const UPDATE_INTERVAL_HOURS = parseFloat(process.env.UPDATE_INTERVAL_HOURS || '24');
const CACHE_TTL_MS = Math.max(0.1, UPDATE_INTERVAL_HOURS) * 3600 * 1000;
// Pages of history pulled per backfill chunk (~20 tweets/page). Resumable across runs.
const BACKFILL_PAGES_PER_RUN = parseInt(process.env.BACKFILL_PAGES_PER_RUN || '50', 10);
// While backfilling, run a new chunk this often (ms) so history fills in fast.
const BACKFILL_INTERVAL_MS = parseInt(process.env.BACKFILL_INTERVAL_MS || '15000', 10);
// Safety cap for the "new tweets" fetch each refresh.
const INCREMENTAL_MAX_PAGES = parseInt(process.env.INCREMENTAL_MAX_PAGES || '40', 10);
const POSTS_PER_USER = parseInt(process.env.POSTS_PER_USER || '25', 10);
const TOP_LIMIT = parseInt(process.env.TOP_LIMIT || '2000', 10);
const STORE_FILE = process.env.STORE_FILE || path.join(__dirname, 'store.json');
const TERMS = process.env.QUERY_TERMS || '(variational OR @variational_io OR $VAR)';
// Handles to exclude from the leaderboard/stats entirely (e.g. the project's own
// account). Their own posts are never indexed or counted.
const EXCLUDE_HANDLES = (process.env.EXCLUDE_HANDLES || 'variational_io')
	.toLowerCase().split(',').map((s) => s.trim().replace(/^@+/, '')).filter(Boolean);
const API = 'https://api.twitterapi.io';

// ---- external store (Upstash Redis REST) ----
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = process.env.STORE_KEY || 'pv:index';
const REDIS_CHUNK = 200 * 1024; // 200KB per key, keeps requests small

if (!KEY) console.warn('[warn] TWITTERAPI_KEY not set — /api/* returns 503 and the frontend shows PREVIEW mode.');
console.log('[store] backend = ' + (USE_REDIS ? 'Upstash Redis (persistent)' : 'local file (ephemeral on Render free)'));

/* ---------------- twitterapi.io client (single page) ---------------- */
async function searchPage(query, cursor) {
	const u = new URL(API + '/twitter/tweet/advanced_search');
	u.searchParams.set('query', query);
	u.searchParams.set('queryType', 'Latest');
	if (cursor) u.searchParams.set('cursor', cursor);
	const r = await fetch(u, { headers: { 'X-API-Key': KEY } });
	if (!r.ok) {
		const body = await r.text();
		throw new Error('twitterapi.io ' + r.status + ': ' + body.slice(0, 300));
	}
	const j = await r.json();
	return { tweets: Array.isArray(j.tweets) ? j.tweets : [], cursor: j.next_cursor || '', hasNext: !!j.has_next_page };
}

/* ---------------- classification ---------------- */
function classify(t) {
	const text = t.text || '';
	const low = text.toLowerCase();
	const mentions = ((t.entities && t.entities.user_mentions) || []).map((m) => (m.screen_name || '').toLowerCase());
	const tags = ((t.entities && t.entities.hashtags) || []).map((h) => (h.text || '').toLowerCase());
	const atV = mentions.includes('variational_io') || low.includes('@variational_io');
	const kw = /\bvariational\b/.test(low);
	const varTag = /\$var\b/i.test(text) || tags.includes('var');
	const stripped = low.replace(/@\w+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\$var\b/gi, ' ').replace(/[^a-z0-9]+/gi, ' ').trim();
	const reply = !!t.isReply && stripped.split(' ').filter(Boolean).length >= 2;
	return { atV, kw, varTag, reply, relevant: atV || kw || varTag };
}

// Convert a raw tweet into a compact index record (or null if not relevant).
function toRecord(t) {
	if (!t || t.retweeted_tweet) return null;
	const c = classify(t);
	if (!c.relevant) return null;
	const a = t.author || {};
	const handle = a.userName || '';
	const id = t.id || t.id_str || '';
	if (!handle || !id) return null;
	if (EXCLUDE_HANDLES.includes(handle.toLowerCase())) return null; // exclude the project's own account
	const ts = Date.parse(t.createdAt);
	return {
		id: String(id), h: handle, name: a.name || handle, av: a.profilePicture || '',
		fol: a.followers || 0, ver: !!a.isBlueVerified,
		v: t.viewCount || 0, l: t.likeCount || 0, rt: t.retweetCount || 0, rp: t.replyCount || 0,
		t: isNaN(ts) ? null : ts, text: (t.text || '').slice(0, 240),
		atV: c.atV ? 1 : 0, kw: c.kw ? 1 : 0, vt: c.varTag ? 1 : 0, re: c.reply ? 1 : 0,
		url: (typeof t.url === 'string' && /^https?:/.test(t.url)) ? t.url : ('https://x.com/' + handle + '/status/' + id),
	};
}

function sinceFloorClause() {
	if (!SINCE_DATE) return ''; // no floor => walk to the very first tweet
	const since = Math.floor(Date.parse(SINCE_DATE) / 1000);
	return isNaN(since) ? '' : (' since_time:' + since);
}

/* ---------------- persistent index ---------------- */
let store = { tweets: {}, oldestCursor: '', backfillDone: false, newestTime: 0, count: 0, updatedAt: 0 };

/* ---- Redis REST helpers ---- */
async function redisCmd(args) {
	const r = await fetch(REDIS_URL, {
		method: 'POST',
		headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
		body: JSON.stringify(args),
	});
	if (!r.ok) throw new Error('redis ' + r.status + ': ' + (await r.text()).slice(0, 200));
	const j = await r.json();
	if (j && j.error) throw new Error('redis: ' + j.error);
	return j ? j.result : null;
}

async function redisSaveBlob(str) {
	const gz = zlib.gzipSync(Buffer.from(str, 'utf8')).toString('base64');
	const n = Math.ceil(gz.length / REDIS_CHUNK) || 1;
	for (let i = 0; i < n; i++) {
		await redisCmd(['SET', REDIS_KEY + ':' + i, gz.slice(i * REDIS_CHUNK, (i + 1) * REDIS_CHUNK)]);
	}
	await redisCmd(['SET', REDIS_KEY + ':meta', String(n)]);
}

async function redisLoadBlob() {
	const meta = await redisCmd(['GET', REDIS_KEY + ':meta']);
	const n = parseInt(meta, 10);
	if (!(n > 0)) return null;
	let gz = '';
	for (let i = 0; i < n; i++) {
		const part = await redisCmd(['GET', REDIS_KEY + ':' + i]);
		if (part == null) return null;
		gz += part;
	}
	return zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8');
}

async function loadStore() {
	try {
		let str = null;
		if (USE_REDIS) str = await redisLoadBlob();
		else if (fs.existsSync(STORE_FILE)) str = fs.readFileSync(STORE_FILE, 'utf8');
		if (str) {
			const saved = JSON.parse(str);
			if (saved && saved.tweets) {
				store = Object.assign(store, saved);
				store.count = Object.keys(store.tweets).length;
				console.log('[store] restored ' + store.count + ' tweets (backfill ' + (store.backfillDone ? 'complete' : 'in progress') + ')');
			}
		}
	} catch (e) { console.warn('[store] load failed:', e.message); }
}

let saveTimer = null, savePending = false;
function saveStore() {
	store.count = Object.keys(store.tweets).length;
	store.updatedAt = Date.now();
	if (saveTimer) { savePending = true; return; } // debounce / coalesce
	saveTimer = setTimeout(async () => {
		try {
			const str = JSON.stringify(store);
			if (USE_REDIS) await redisSaveBlob(str);
			else fs.writeFileSync(STORE_FILE, str);
		} catch (e) { console.warn('[store] save failed:', e.message); }
		saveTimer = null;
		if (savePending) { savePending = false; saveStore(); }
	}, USE_REDIS ? 8000 : 1500);
}

function ingest(tweets) {
	let added = 0;
	for (const t of tweets) {
		const r = toRecord(t);
		if (!r) continue;
		if (!store.tweets[r.id]) added++;
		store.tweets[r.id] = r; // overwrite keeps view/like counts fresh
		if (r.t && r.t > store.newestTime) store.newestTime = r.t;
	}
	return added;
}

// Pull a chunk of older history (resumable). Returns tweets added.
async function backfillStep() {
	if (store.backfillDone) return 0;
	const query = TERMS + ' -filter:retweets' + sinceFloorClause();
	let cursor = store.oldestCursor || '';
	let pages = 0, added = 0;
	while (pages < BACKFILL_PAGES_PER_RUN) {
		const page = await searchPage(query, cursor);
		added += ingest(page.tweets);
		cursor = page.cursor;
		store.oldestCursor = cursor;
		pages++;
		if (!page.hasNext || !cursor) { store.backfillDone = true; break; }
	}
	if (added || store.backfillDone) saveStore();
	return added;
}

// Fetch only tweets newer than what we already have.
async function incrementalStep() {
	if (!store.newestTime) return 0; // nothing indexed yet; backfill will seed
	const since = Math.floor(store.newestTime / 1000);
	const query = TERMS + ' -filter:retweets since_time:' + since;
	let cursor = '', pages = 0, added = 0;
	while (pages < INCREMENTAL_MAX_PAGES) {
		const page = await searchPage(query, cursor);
		added += ingest(page.tweets);
		cursor = page.cursor;
		pages++;
		if (!page.hasNext || !cursor) break;
	}
	if (added) saveStore();
	return added;
}

/* ---------------- snapshot computation (from the index) ---------------- */
function newUser(r) {
	return { h: r.h, name: r.name, avatar: r.av, followers: r.fol, verified: r.ver, v: 0, l: 0, p: 0, atV: 0, kw: 0, varT: 0, rep: 0, _posts: [] };
}
function addToUser(u, r) {
	u.v += r.v; u.l += r.l; u.p += 1; u.atV += r.atV; u.kw += r.kw; u.varT += r.vt; u.rep += r.re;
	if (r.fol > u.followers) u.followers = r.fol;
	if (r.name) u.name = r.name;
	if (r.av && !u.avatar) u.avatar = r.av;
	if (r.ver) u.verified = true;
	u._posts.push(r);
}
function finalize(u, withSeries) {
	const timed = u._posts.filter((p) => p.t).sort((a, b) => a.t - b.t);
	let acc = 0; u.chart = timed.map((p) => (acc += p.v));
	u.first = timed.length ? timed[0].t : null;
	u.last = timed.length ? timed[timed.length - 1].t : null;
	u.posts = u._posts.slice().sort((a, b) => b.v - a.v).slice(0, POSTS_PER_USER)
		.map((p) => ({ text: p.text, v: p.v, l: p.l, rt: p.rt, rp: p.rp, date: p.t ? new Date(p.t).toISOString() : null, url: p.url, id: p.id }));
	// Per-profile time series: each timed post with its cumulative views, so the
	// profile chart can draw the running view total and link each vertical mark to
	// the actual tweet posted on that date.
	if (withSeries) {
		let a2 = 0;
		let pts = timed.map((p) => ({
			t: p.t,
			cv: (a2 += p.v),
			v: p.v,
			url: p.url || (p.id ? ('https://x.com/' + u.h + '/status/' + p.id) : ('https://x.com/' + u.h)),
			text: (p.text || '').slice(0, 120),
		}));
		// Cap the number of clickable marks so the payload stays small for very prolific accounts.
		const CAP = 600;
		if (pts.length > CAP) {
			const step = pts.length / CAP;
			const keep = [];
			for (let i = 0; i < CAP; i++) keep.push(pts[Math.floor(i * step)]);
			keep[keep.length - 1] = pts[pts.length - 1];
			pts = keep;
		}
		u.series = pts;
	}
	delete u._posts;
	return u;
}

function buildSnapshot() {
	const byUser = Object.create(null);
	for (const id in store.tweets) {
		const r = store.tweets[id];
		const key = r.h.toLowerCase();
		if (!byUser[key]) byUser[key] = newUser(r);
		addToUser(byUser[key], r);
	}
	const users = Object.values(byUser);
	const totals = users.reduce((s, u) => ({ views: s.views + u.v, likes: s.likes + u.l, posts: s.posts + u.p }), { views: 0, likes: 0, posts: 0 });
	users.sort((a, b) => b.v - a.v);
	const rankMap = Object.create(null);
	users.forEach((u, i) => { rankMap[u.h.toLowerCase()] = i + 1; });
	users.forEach(finalize);
	const data = {
		window: { lookbackDays: 0, allTime: true, sinceDate: SINCE_DATE || '', backfillComplete: store.backfillDone, indexedTweets: store.count, sampledTweets: store.count },
		totals: { views: totals.views, likes: totals.likes, posts: totals.posts, users: users.length },
		users: users.slice(0, TOP_LIMIT),
	};
	return { data, rankMap };
}

// Profile for a single handle, computed straight from the index (no API cost).
function profileFromStore(handle) {
	const clean = handle.replace(/^@+/, '').trim();
	const key = clean.toLowerCase();
	let u = null;
	for (const id in store.tweets) {
		const r = store.tweets[id];
		if (r.h.toLowerCase() !== key) continue;
		if (!u) u = newUser(r);
		addToUser(u, r);
	}
	if (!u) u = { h: clean, name: clean, avatar: '', followers: 0, verified: false, v: 0, l: 0, p: 0, atV: 0, kw: 0, varT: 0, rep: 0, _posts: [] };
	return finalize(u, true);
}

/* ---------------- cache + refresh loop ---------------- */
let cache = { at: 0, data: null, rankMap: null };
let refreshing = null;

function stamp(data, at) {
	data.updateIntervalHours = UPDATE_INTERVAL_HOURS;
	data.generatedAt = new Date(at).toISOString();
	data.nextUpdateAt = new Date(at + CACHE_TTL_MS).toISOString();
	return data;
}

async function refresh() {
	if (refreshing) return refreshing;
	refreshing = (async () => {
		try {
			await incrementalStep();
			await backfillStep();
		} catch (e) {
			console.error('[refresh] fetch error:', e.message);
		}
		const { data, rankMap } = buildSnapshot();
		cache = { at: Date.now(), data, rankMap };
		console.log('[refresh] index=' + store.count + ' users=' + data.totals.users + ' views=' + data.totals.views + ' backfill=' + (store.backfillDone ? 'done' : 'more'));
		return cache;
	})().finally(() => { refreshing = null; });
	return refreshing;
}

async function getLeaderboard() {
	if (cache.data) {
		if (Date.now() - cache.at >= CACHE_TTL_MS && !store.backfillDone) refresh(); // background
		return stamp(cache.data, cache.at);
	}
	await refresh();
	return stamp(cache.data, cache.at);
}

async function scanHandle(handle) {
	if (!cache.data) { try { await getLeaderboard(); } catch (_) {} }
	const user = profileFromStore(handle);
	const key = user.h.toLowerCase();
	const rank = (cache.rankMap && cache.rankMap[key]) || (cache.data ? cache.data.totals.users + 1 : 1);
	return { user, rank, source: 'index' };
}

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res) {
	let p = decodeURIComponent(url.parse(req.url).pathname);
	if (p === '/') p = '/index.html';
	const file = path.join(__dirname, 'public', path.normalize(p).replace(/^([.][.][/\\])+/, ''));
	fs.readFile(file, (err, buf) => {
		if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
		res.end(buf);
	});
}
function sendJSON(res, code, obj) {
	res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
	const parsed = url.parse(req.url, true);
	const p = parsed.pathname;
	try {
		if (p === '/api/health') return sendJSON(res, 200, { ok: true, hasKey: !!KEY, store: USE_REDIS ? 'redis' : 'file', indexed: store.count, backfillComplete: store.backfillDone, updateIntervalHours: UPDATE_INTERVAL_HOURS, sinceDate: SINCE_DATE || 'first post' });
		if (p === '/api/leaderboard') {
			if (!KEY) return sendJSON(res, 503, { error: 'no_api_key' });
			return sendJSON(res, 200, await getLeaderboard());
		}
		if (p === '/api/scan' || p === '/api/user') {
			if (!KEY) return sendJSON(res, 503, { error: 'no_api_key' });
			const handle = (parsed.query.handle || '').toString();
			if (!handle) return sendJSON(res, 400, { error: 'missing_handle' });
			return sendJSON(res, 200, await scanHandle(handle));
		}
		if (p.indexOf('/u/') === 0) { req.url = '/index.html'; return serveStatic(req, res); }
		return serveStatic(req, res);
	} catch (e) {
		console.error(e);
		return sendJSON(res, 502, { error: 'upstream', message: String((e && e.message) || e) });
	}
});

// Background indexer: while backfilling, keep pulling chunks quickly; once the
// full history is in, just refresh on the normal daily cadence.
(async () => {
	await loadStore();
	server.listen(PORT, () => console.log('Proof of VARIATIONAL on http://localhost:' + PORT + ' — indexing ' + (SINCE_DATE ? 'since ' + SINCE_DATE : 'from the first post') + ', updates every ' + UPDATE_INTERVAL_HOURS + 'h' + (KEY ? '' : ' — PREVIEW (set TWITTERAPI_KEY)')));
	if (KEY) {
		refresh();
		setInterval(() => {
			if (refreshing) return;
			if (!store.backfillDone) refresh();
			else if (Date.now() - cache.at >= CACHE_TTL_MS) refresh();
		}, BACKFILL_INTERVAL_MS).unref();
	}
})();
