/*
 * Proof of VARIATIONAL — backend
 * Pulls REAL tweet data from twitterapi.io (no official X API needed).
 * Data is refreshed once every UPDATE_INTERVAL_HOURS (default 24h) and cached
 * to disk, so visitors always see the same daily snapshot and costs stay low.
 * Endpoints:
 *   GET /api/leaderboard            -> { totals, users[], window, updateIntervalHours, generatedAt, nextUpdateAt }
 *   GET /api/user?handle=NAME       -> { user, rank }   (also /api/scan)
 *   GET /api/health
 *   /u/<handle>                     -> serves the single-page app (profile deep-link)
 * Static frontend is served from ./public
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const KEY = process.env.TWITTERAPI_KEY || '';
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '7', 10);
const LEADERBOARD_PAGES = parseInt(process.env.LEADERBOARD_PAGES || '15', 10); // ~20 tweets/page
const SCAN_PAGES = parseInt(process.env.SCAN_PAGES || '6', 10);
const UPDATE_INTERVAL_HOURS = parseFloat(process.env.UPDATE_INTERVAL_HOURS || '24');
const CACHE_TTL_MS = Math.max(1, UPDATE_INTERVAL_HOURS) * 60 * 60 * 1000;
const TOP_LIMIT = parseInt(process.env.TOP_LIMIT || '50', 10);
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache.json');
// What counts as a Variational mention. Edit to taste.
const TERMS = process.env.QUERY_TERMS || '(variational OR @variational_io OR $VAR)';
const API = 'https://api.twitterapi.io';

if (!KEY) {
	console.warn('[warn] TWITTERAPI_KEY is not set. /api/* will return 503 until you set it. The frontend will fall back to preview mode.');
}

/* ---------------- twitterapi.io client ---------------- */
async function advancedSearch(query, { queryType = 'Latest', maxPages = 10 } = {}) {
	let cursor = '';
	let pages = 0;
	const tweets = [];
	do {
		const u = new URL(API + '/twitter/tweet/advanced_search');
		u.searchParams.set('query', query);
		u.searchParams.set('queryType', queryType);
		if (cursor) u.searchParams.set('cursor', cursor);
		const r = await fetch(u, { headers: { 'X-API-Key': KEY } });
		if (!r.ok) {
			const body = await r.text();
			throw new Error('twitterapi.io ' + r.status + ': ' + body.slice(0, 300));
		}
		const j = await r.json();
		if (Array.isArray(j.tweets)) tweets.push(...j.tweets);
		cursor = j.next_cursor || '';
		pages++;
		if (!j.has_next_page) break;
	} while (pages < maxPages && cursor);
	return tweets;
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
	const stripped = low
		.replace(/@\w+/g, ' ')
		.replace(/https?:\/\/\S+/g, ' ')
		.replace(/\$var\b/gi, ' ')
		.replace(/[^a-z0-9]+/gi, ' ')
		.trim();
	const reply = !!t.isReply && stripped.split(' ').filter(Boolean).length >= 2;
	return { atV, kw, varTag, reply, relevant: atV || kw || varTag };
}

function aggregate(tweets) {
	const byUser = Object.create(null);
	for (const t of tweets) {
		if (t.retweeted_tweet) continue; // plain retweets are excluded
		const c = classify(t);
		if (!c.relevant) continue;
		const a = t.author || {};
		const handle = a.userName || '';
		if (!handle) continue;
		const key = handle.toLowerCase();
		const u =
			byUser[key] ||
			(byUser[key] = {
				h: handle,
				name: a.name || handle,
				avatar: a.profilePicture || '',
				followers: a.followers || 0,
				verified: !!a.isBlueVerified,
				v: 0, l: 0, p: 0, atV: 0, kw: 0, varT: 0, rep: 0,
				first: null,
				series: [],
			});
		u.v += t.viewCount || 0;
		u.l += t.likeCount || 0;
		u.p += 1;
		if (c.atV) u.atV++;
		if (c.kw) u.kw++;
		if (c.varTag) u.varT++;
		if (c.reply) u.rep++;
		const ts = Date.parse(t.createdAt);
		if (!isNaN(ts)) {
			if (!u.first || ts < u.first) u.first = ts;
			u.series.push({ t: ts, v: t.viewCount || 0 });
		}
	}
	return Object.values(byUser);
}

function buildSeries(user) {
	const pts = user.series.slice().sort((a, b) => a.t - b.t);
	let acc = 0;
	const arr = pts.map((p) => (acc += p.v));
	delete user.series;
	user.chart = arr;
	return user;
}

function sinceClause() {
	const since = Math.floor((Date.now() - LOOKBACK_DAYS * 86400000) / 1000);
	return ' since_time:' + since;
}

/* ---------------- cached leaderboard (daily) ---------------- */
let cache = { at: 0, data: null, building: null };

try {
	if (fs.existsSync(CACHE_FILE)) {
		const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
		if (saved && saved.at && saved.data) {
			cache.at = saved.at;
			cache.data = saved.data;
			console.log('[cache] restored snapshot from ' + new Date(saved.at).toISOString());
		}
	}
} catch (e) {
	console.warn('[cache] could not read cache file:', e.message);
}

function stamp(data, at) {
	data.updateIntervalHours = UPDATE_INTERVAL_HOURS;
	data.generatedAt = new Date(at).toISOString();
	data.nextUpdateAt = new Date(at + CACHE_TTL_MS).toISOString();
	return data;
}

async function buildLeaderboard() {
	const query = TERMS + ' -filter:retweets' + sinceClause();
	const tweets = await advancedSearch(query, { queryType: 'Latest', maxPages: LEADERBOARD_PAGES });
	const users = aggregate(tweets).sort((a, b) => b.v - a.v);
	const totals = users.reduce((s, u) => ({ views: s.views + u.v, likes: s.likes + u.l }), { views: 0, likes: 0 });
	users.forEach(buildSeries);
	return {
		window: { lookbackDays: LOOKBACK_DAYS, sampledTweets: tweets.length },
		totals: { views: totals.views, likes: totals.likes, users: users.length },
		users: users.slice(0, TOP_LIMIT),
	};
}

async function getLeaderboard() {
	if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return stamp(cache.data, cache.at);
	if (cache.building) return cache.building;
	cache.building = buildLeaderboard()
		.then((data) => {
			const at = Date.now();
			cache = { at, data, building: null };
			try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ at, data })); } catch (e) { console.warn('[cache] write failed:', e.message); }
			console.log('[cache] refreshed at ' + new Date(at).toISOString());
			return stamp(data, at);
		})
		.catch((e) => {
			cache.building = null;
			if (cache.data) return stamp(cache.data, cache.at);
			throw e;
		});
	return cache.building;
}

async function scanHandle(handle) {
	const clean = handle.replace(/^@+/, '').trim();
	const query = 'from:' + clean + ' ' + TERMS + ' -filter:retweets' + sinceClause();
	const tweets = await advancedSearch(query, { queryType: 'Latest', maxPages: SCAN_PAGES });
	const users = aggregate(tweets);
	let user = users[0];
	if (!user) {
		user = { h: clean, name: clean, avatar: '', followers: 0, verified: false, v: 0, l: 0, p: 0, atV: 0, kw: 0, varT: 0, rep: 0, first: null, series: [] };
	}
	buildSeries(user);
	let rank = 1;
	try {
		const lb = await getLeaderboard();
		rank = lb.users.filter((u) => u.v > user.v).length + 1;
	} catch (_) {}
	return { user, rank };
}

if (KEY) {
	setInterval(() => {
		if (Date.now() - cache.at >= CACHE_TTL_MS) getLeaderboard().catch((e) => console.error('[refresh]', e.message));
	}, 60 * 60 * 1000).unref();
}

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res) {
	let p = decodeURIComponent(url.parse(req.url).pathname);
	if (p === '/') p = '/index.html';
	const file = path.join(__dirname, 'public', path.normalize(p).replace(/^([.][.][/\\])+/, ''));
	fs.readFile(file, (err, buf) => {
		if (err) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not found');
			return;
		}
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
		if (p === '/api/health') return sendJSON(res, 200, { ok: true, hasKey: !!KEY, updateIntervalHours: UPDATE_INTERVAL_HOURS });
		if (p === '/api/leaderboard') {
			if (!KEY) return sendJSON(res, 503, { error: 'no_api_key' });
			const data = await getLeaderboard();
			return sendJSON(res, 200, data);
		}
		if (p === '/api/scan' || p === '/api/user') {
			if (!KEY) return sendJSON(res, 503, { error: 'no_api_key' });
			const handle = (parsed.query.handle || '').toString();
			if (!handle) return sendJSON(res, 400, { error: 'missing_handle' });
			const data = await scanHandle(handle);
			return sendJSON(res, 200, data);
		}
		// clean profile deep-links like /u/handle -> serve the single-page app
		if (p.indexOf('/u/') === 0) { req.url = '/index.html'; return serveStatic(req, res); }
		return serveStatic(req, res);
	} catch (e) {
		console.error(e);
		return sendJSON(res, 502, { error: 'upstream', message: String(e && e.message || e) });
	}
});

server.listen(PORT, () => console.log('Proof of VARIATIONAL running on http://localhost:' + PORT + '  (updates every ' + UPDATE_INTERVAL_HOURS + 'h)' + (KEY ? '' : '  — PREVIEW mode, set TWITTERAPI_KEY for real data')));
