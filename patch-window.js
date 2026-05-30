// Windowed-backfill patch. Adds until_time windowing so backfill can walk past
// the provider's cursor limit (~7 months) all the way to SINCE_DATE.
// Usage: node patch-window.js [path-to-server.js]   (default: /root/varik/server.js)
const fs = require('fs');
const FILE = process.argv[2] || '/root/varik/server.js';
let s = fs.readFileSync(FILE, 'utf8');
const orig = s;

if (s.includes('windowOldestRaw')) {
	console.log('SKIP: windowing already applied to ' + FILE);
	process.exit(0);
}

let ok = 0, fail = 0;
function rep(name, find, replace) {
	if (s.indexOf(find) === -1) { console.log('MISS: ' + name); fail++; return; }
	s = s.replace(find, replace);
	console.log('OK:   ' + name);
	ok++;
}

// 1) store init: add new fields
rep('store-init',
	"let store = { tweets: {}, oldestCursor: '', backfillDone: false, newestTime: 0, count: 0, updatedAt: 0 };",
	"let store = { tweets: {}, oldestCursor: '', backfillDone: false, newestTime: 0, oldestTime: 0, windowUntil: 0, windowOldestRaw: 0, backfillVersion: 0, count: 0, updatedAt: 0 };");

// 2) ingest: track oldestTime
rep('ingest-oldest',
	"\t\tif (r.t && r.t > store.newestTime) store.newestTime = r.t;\n\t}",
	"\t\tif (r.t && r.t > store.newestTime) store.newestTime = r.t;\n\t\tif (r.t && (!store.oldestTime || r.t < store.oldestTime)) store.oldestTime = r.t;\n\t}");

// 3) backfillStep: full windowed rewrite
const oldBackfill = "// Pull a chunk of older history (resumable). Returns tweets added.\nasync function backfillStep() {\n\tif (store.backfillDone) return 0;\n\tconst query = TERMS + ' -filter:retweets' + sinceFloorClause();\n\tlet cursor = store.oldestCursor || '';\n\tlet pages = 0, added = 0;\n\twhile (pages < BACKFILL_PAGES_PER_RUN) {\n\t\tconst page = await searchPage(query, cursor);\n\t\tadded += ingest(page.tweets);\n\t\tcursor = page.cursor;\n\t\tstore.oldestCursor = cursor;\n\t\tpages++;\n\t\tif (!page.hasNext || !cursor) { store.backfillDone = true; break; }\n\t}\n\tif (added || store.backfillDone) saveStore();\n\treturn added;\n}";
const newBackfill = "// Pull a chunk of older history (resumable, windowed). Returns tweets added.\n// Walks backward in time windows using until_time so we are not limited by the\n// provider's cursor depth (~7 months). Steps down to SINCE_DATE or the true bottom.\nasync function backfillStep() {\n\tif (store.backfillDone) return 0;\n\t// Seed oldest timestamp from existing data (stores created before windowing).\n\tif (!store.oldestTime) {\n\t\tfor (const id in store.tweets) { const tt = store.tweets[id].t; if (tt && (!store.oldestTime || tt < store.oldestTime)) store.oldestTime = tt; }\n\t}\n\t// If we already have data but no window opened yet, start just below our oldest tweet.\n\tif (!store.oldestCursor && !store.windowUntil && store.oldestTime) {\n\t\tstore.windowUntil = Math.floor(store.oldestTime / 1000) - 1;\n\t\tstore.windowOldestRaw = 0;\n\t}\n\tlet cursor = store.oldestCursor || '';\n\tlet pages = 0, added = 0;\n\twhile (pages < BACKFILL_PAGES_PER_RUN) {\n\t\tconst until = store.windowUntil || 0;\n\t\tconst query = TERMS + ' -filter:retweets' + sinceFloorClause() + (until ? ' until_time:' + until : '');\n\t\tconst freshWindow = !cursor;\n\t\tconst page = await searchPage(query, cursor);\n\t\tadded += ingest(page.tweets);\n\t\tfor (const t of page.tweets) { const ts = Date.parse(t.createdAt); if (!isNaN(ts) && (!store.windowOldestRaw || ts < store.windowOldestRaw)) store.windowOldestRaw = ts; }\n\t\tcursor = page.cursor;\n\t\tstore.oldestCursor = cursor;\n\t\tpages++;\n\t\tif (freshWindow && page.tweets.length === 0) { store.backfillDone = true; break; } // no older tweets exist -> real bottom\n\t\tif (!page.hasNext || !cursor) {\n\t\t\t// Current window exhausted -> open an older window below the oldest tweet seen.\n\t\t\tconst stepFromMs = store.windowOldestRaw || (until ? until * 1000 : store.oldestTime);\n\t\t\tstore.windowUntil = Math.floor(stepFromMs / 1000) - 1;\n\t\t\tstore.windowOldestRaw = 0;\n\t\t\tstore.oldestCursor = '';\n\t\t\tcursor = '';\n\t\t}\n\t}\n\tif (added || store.backfillDone) saveStore();\n\treturn added;\n}";
rep('backfillStep', oldBackfill, newBackfill);

// 4) loadStore: one-time migration to resume windowed backfill on existing stores
const oldLoad = "\t\t\t\tconsole.log('[store] restored ' + store.count + ' tweets (backfill ' + (store.backfillDone ? 'complete' : 'in progress') + ')');";
const newLoad = oldLoad + "\n\t\t\t\tif (store.backfillVersion !== 2) {\n\t\t\t\t\tstore.backfillVersion = 2;\n\t\t\t\t\tstore.backfillDone = false;\n\t\t\t\t\tstore.oldestCursor = '';\n\t\t\t\t\tstore.windowUntil = 0;\n\t\t\t\t\tstore.windowOldestRaw = 0;\n\t\t\t\t\tconsole.log('[store] enabled windowed backfill (v2) -- resuming history fetch past previous limit');\n\t\t\t\t}";
rep('loadStore-migration', oldLoad, newLoad);

if (fail) { console.log('\\nABORTED: ' + fail + ' target(s) not found, no changes written.'); process.exit(1); }
fs.writeFileSync(FILE, s);
console.log('\\nDONE: applied ' + ok + ' edits to ' + FILE);
