// patch-imgproxy.js — adds a same-origin image proxy (/img?u=<encoded>) to server.js
// so avatars (pbs.twimg.com / unavatar.io) can be captured by html2canvas without CORS taint.
// Usage: node patch-imgproxy.js server.js
// Idempotent: re-running reports SKIP if already applied.

const fs = require('fs');
const file = process.argv[2] || 'server.js';
let s = fs.readFileSync(file, 'utf8');
const orig = s;

const FN = `const __imgCache = new Map();
const __IMG_TTL_MS = 6 * 3600 * 1000;
const __IMG_MAX = 500;
function __imgHostOk(h) {
	h = h.toLowerCase();
	return h === 'unavatar.io' || h.slice(-12) === '.unavatar.io' || h === 'twimg.com' || h.slice(-10) === '.twimg.com';
}
async function serveImg(req, res, query) {
	const raw = (query && query.u) ? String(query.u) : '';
	let target;
	try { target = new URL(raw); } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad url'); return; }
	if (target.protocol !== 'https:' || !__imgHostOk(target.hostname)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
	const now = Date.now();
	const hit = __imgCache.get(target.href);
	if (hit && (now - hit.at) < __IMG_TTL_MS) {
		res.writeHead(200, { 'Content-Type': hit.type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=21600' });
		res.end(hit.buf); return;
	}
	try {
		const r = await fetch(target.href, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, redirect: 'follow' });
		if (!r.ok) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('upstream ' + r.status); return; }
		const buf = Buffer.from(await r.arrayBuffer());
		const type = r.headers.get('content-type') || 'image/jpeg';
		if (type.toLowerCase().indexOf('image/') !== 0) { res.writeHead(415, { 'Content-Type': 'text/plain' }); res.end('not an image'); return; }
		if (__imgCache.size >= __IMG_MAX) { __imgCache.delete(__imgCache.keys().next().value); }
		__imgCache.set(target.href, { type: type, buf: buf, at: now });
		res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=21600' });
		res.end(buf);
	} catch (e) {
		res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('fetch failed');
	}
}
`;

const edits = [
	{ label: 'serveImg() function', skipIf: 'function serveImg', find: 'function serveStatic(req, res) {', replace: FN + '\nfunction serveStatic(req, res) {' },
	{ label: '/img route', skipIf: "p === '/img'", find: "if (p.indexOf('/u/') === 0) { req.url = '/index.html'; return serveStatic(req, res); }", replace: "if (p === '/img') return serveImg(req, res, parsed.query);\n\t\tif (p.indexOf('/u/') === 0) { req.url = '/index.html'; return serveStatic(req, res); }" },
];

let applied = 0;
for (const e of edits) {
	if (orig.includes(e.skipIf)) { console.log('SKIP: ' + e.label + ' (already applied)'); }
	else if (s.includes(e.find)) { s = s.replace(e.find, e.replace); console.log('OK:   ' + e.label); applied++; }
	else { console.log('WARN: ' + e.label + ' \u2014 anchor not found'); }
}

if (s !== orig) { fs.writeFileSync(file, s); console.log('\nDONE: wrote ' + applied + ' edit(s) to ' + file); }
else { console.log('\nNo changes written.'); }
