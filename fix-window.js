// One-off store repair: reset the backfill window to start just below the TRUE
// oldest stored tweet, so windowed backfill fetches genuinely-older data instead of
// re-scanning the existing index. Reads Upstash creds + STORE_KEY from env.
// STOP the app first (pm2 stop <name>) to avoid a save race, then run, then start.
// Usage: cd <appdir> && set -a && source .env && set +a && node fix-window.js
const zlib = require('zlib');
const U = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const T = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY = process.env.STORE_KEY || 'pv:index';
const CHUNK = 200 * 1024;
async function cmd(a) {
	const r = await fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
	const j = await r.json();
	if (j && j.error) throw new Error(j.error);
	return j ? j.result : null;
}
const d = t => t ? new Date(Number(t)).toISOString() : t;
(async () => {
	if (!U || !T) throw new Error('missing UPSTASH env — did you source .env?');
	const meta = await cmd(['GET', KEY + ':meta']); const n = parseInt(meta, 10);
	if (!(n > 0)) throw new Error('no store found for key ' + KEY);
	let gz = ''; for (let i = 0; i < n; i++) { gz += await cmd(['GET', KEY + ':' + i]); }
	const s = JSON.parse(zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8'));
	let mn = 0; for (const id in s.tweets) { const tt = s.tweets[id].t; if (tt && (!mn || tt < mn)) mn = tt; }
	if (!mn) throw new Error('no tweets in store; nothing to fix');
	console.log('key                =', KEY);
	console.log('count              =', Object.keys(s.tweets || {}).length);
	console.log('BEFORE windowUntil =', s.windowUntil, '->', s.windowUntil ? d(s.windowUntil * 1000) : 0);
	console.log('BEFORE oldestTime  =', d(s.oldestTime));
	console.log('true oldest tweet  =', d(mn));
	s.oldestTime = mn;
	s.windowUntil = Math.floor(mn / 1000) - 1;
	s.windowOldestRaw = 0;
	s.oldestCursor = '';
	s.backfillDone = false;
	s.backfillVersion = 2;
	const str = JSON.stringify(s);
	const ngz = zlib.gzipSync(Buffer.from(str, 'utf8')).toString('base64');
	const cn = Math.ceil(ngz.length / CHUNK) || 1;
	for (let i = 0; i < cn; i++) { await cmd(['SET', KEY + ':' + i, ngz.slice(i * CHUNK, (i + 1) * CHUNK)]); }
	await cmd(['SET', KEY + ':meta', String(cn)]);
	console.log('AFTER  windowUntil =', s.windowUntil, '->', d(s.windowUntil * 1000));
	console.log('saved OK, chunks   =', cn);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
