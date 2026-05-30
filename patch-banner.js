// Trim the top banner on vivalavar.xyz to ONLY the disclaimer text.
// Removes the "Optional referral..." label and the "Open Variational" link.
// Usage: node patch-banner.js public/index.html  (idempotent)
const fs = require('fs');
const file = process.argv[2] || 'public/index.html';
let s = fs.readFileSync(file, 'utf8');
const orig = s;

const re = /<div class="pov-ref-banner">[\s\S]*?<\/div>/;
const repl = '<div class="pov-ref-banner"><span>\ud83d\udcca Unofficial community tracker \u00b7 not affiliated with Variational</span></div>';

if (!re.test(s)) {
  console.log('WARN: banner (.pov-ref-banner) not found');
} else if (!s.includes('pov-boost">Optional referral') && !s.includes('class="pov-ref-link"')) {
  console.log('SKIP: banner already trimmed');
} else {
  s = s.replace(re, repl);
  console.log('OK: banner trimmed to disclaimer only');
}

if (s !== orig) {
  fs.writeFileSync(file, s);
  console.log('DONE: wrote ' + file);
} else {
  console.log('No changes written.');
}
