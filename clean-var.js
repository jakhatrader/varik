// One-off cleanup: remove indexed tweets that matched ONLY via the $VAR cashtag
// (i.e. they do NOT mention @variational_io and do NOT contain the keyword
// "variational"). These are unrelated accounts (e.g. a different $VAR token)
// that polluted the leaderboard. Pair this with the server.js change that drops
// $VAR from the search query + relevance classifier.
//
// STOP the app first to avoid a save race:
//   pm2 stop varik
//   cd /root/varik && set -a && source .env && set +a
//   DRY=1 node clean-var.js     # preview what would be removed (no write)
//   node clean-var.js           # actually remove + save
//   pm2 start varik
const zlib = require('zlib');
const U = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const T = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY = process.env.STORE_KEY || 'pv:index';
const CHUNK = 200 * 1024;
const DRY = process.env.DRY === '1';
async function cmd(a) {
	const r = await fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
	const j = await r.json();
	if (j && j.error) throw new Error(j.error);
	return j ? j.result : null;
}
(async () => {
	if (!U || !T) throw new Error('missing UPSTASH env \u2014 did you source .env?');
	const meta = await cmd(['GET', KEY + ':meta']); const n = parseInt(meta, 10);
	if (!(n > 0)) throw new Error('no store found for key ' + KEY);
	let gz = ''; for (let i = 0; i < n; i++) { gz += await cmd(['GET', KEY + ':' + i]); }
	const s = JSON.parse(zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8'));
	const ids = Object.keys(s.tweets || {});
	let removed = 0; const handles = {};
	for (const id of ids) {
		const rec = s.tweets[id];
		const keep = rec.atV === 1 || rec.kw === 1; // keep real mentions / keyword hits
		if (!keep) { handles[rec.h] = (handles[rec.h] || 0) + 1; delete s.tweets[id]; removed++; }
	}
	s.count = Object.keys(s.tweets).length;
	console.log('key             =', KEY);
	console.log('before          =', ids.length);
	console.log('removed ($VAR)  =', removed);
	console.log('after           =', s.count);
	const top = Object.entries(handles).sort((a, b) => b[1] - a[1]).slice(0, 25);
	console.log('removed handles (top 25 by tweets):');
	top.forEach(([h, c]) => console.log('  @' + h + ' x' + c));
	if (DRY) { console.log('\nDRY run \u2014 nothing written.'); return; }
	const str = JSON.stringify(s);
	const ngz = zlib.gzipSync(Buffer.from(str, 'utf8')).toString('base64');
	const cn = Math.ceil(ngz.length / CHUNK) || 1;
	for (let i = 0; i < cn; i++) { await cmd(['SET', KEY + ':' + i, ngz.slice(i * CHUNK, (i + 1) * CHUNK)]); }
	await cmd(['SET', KEY + ':meta', String(cn)]);
	for (let i = cn; i < n; i++) { await cmd(['DEL', KEY + ':' + i]); } // drop stale trailing chunks
	console.log('\nsaved OK, chunks =', cn, '(was ' + n + ')');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
