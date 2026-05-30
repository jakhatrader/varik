// Fix: window seeding must use the TRUE oldest stored tweet, not store.oldestTime
// (which incrementalStep can raise to a recent value, causing backfill to open a
// window near "now" and re-scan the whole existing index instead of going older).
// Requires patch-window.js applied first.
// Usage: node patch-winfix.js [path-to-server.js]   (default /root/varik/server.js)
const fs = require('fs');
const FILE = process.argv[2] || '/root/varik/server.js';
let s = fs.readFileSync(FILE, 'utf8');

if (!s.includes('windowOldestRaw')) { console.log('ERROR: windowing patch (patch-window.js) not applied first to ' + FILE); process.exit(1); }
if (s.includes('__mn')) { console.log('SKIP: winfix already applied to ' + FILE); process.exit(0); }

const find = [
	'\t// Seed oldest timestamp from existing data (stores created before windowing).',
	'\tif (!store.oldestTime) {',
	'\t\tfor (const id in store.tweets) { const tt = store.tweets[id].t; if (tt && (!store.oldestTime || tt < store.oldestTime)) store.oldestTime = tt; }',
	'\t}',
	'\t// If we already have data but no window opened yet, start just below our oldest tweet.',
	'\tif (!store.oldestCursor && !store.windowUntil && store.oldestTime) {',
	'\t\tstore.windowUntil = Math.floor(store.oldestTime / 1000) - 1;',
	'\t\tstore.windowOldestRaw = 0;',
	'\t}',
].join('\n');

const replace = [
	'\t// Open/resume a window: when none is active, seed until_time just below the TRUE',
	'\t// oldest stored tweet (recompute from data; do NOT trust store.oldestTime, which',
	'\t// incrementalStep may have raised to a recent value).',
	'\tif (!store.oldestCursor && !store.windowUntil) {',
	'\t\tlet __mn = 0;',
	'\t\tfor (const id in store.tweets) { const tt = store.tweets[id].t; if (tt && (!__mn || tt < __mn)) __mn = tt; }',
	'\t\tif (__mn) { store.oldestTime = __mn; store.windowUntil = Math.floor(__mn / 1000) - 1; store.windowOldestRaw = 0; }',
	'\t}',
].join('\n');

if (s.indexOf(find) === -1) { console.log('MISS: seeding block not found in ' + FILE + ' — aborting, no changes written'); process.exit(1); }
if (s.indexOf(find) !== s.lastIndexOf(find)) { console.log('AMBIGUOUS: seeding block found multiple times — aborting'); process.exit(1); }
s = s.replace(find, replace);
fs.writeFileSync(FILE, s);
console.log('OK: window seeding hardened in ' + FILE);
