// Make vivalavar.xyz less "deceptive" for Safe Browsing while keeping the referral.
// Usage: node patch-trust.js public/index.html
// Idempotent: re-running reports SKIP for already-applied edits.
const fs = require('fs');
const file = process.argv[2] || 'public/index.html';
let s = fs.readFileSync(file, 'utf8');
const orig = s;

const edits = [
  { label: 'banner: unofficial disclaimer',
    find: '\ud83d\ude80 Trade on Var with referral code <strong>OMNIMUAR</strong>',
    replace: '\ud83d\udcca Unofficial community tracker \u00b7 not affiliated with Variational' },
  { label: 'banner: boost label',
    find: 'BONUS +15% POINTS BOOST',
    replace: 'Optional referral: OMNIMUAR (+15% points)' },
  { label: 'banner: "Claim it" button',
    find: '>Claim it \u2197<',
    replace: '>Open Variational \u2197<' },
  { label: 'nav: "Launch Var" button',
    find: '>Launch Var \u2197<',
    replace: '>Visit Variational \u2197<' },
  { label: 'profile: share-row button',
    find: '>Trade on Var (+15% boost)<',
    replace: '>Trade on Variational \u2197<' },
  { label: 'CTA: heading',
    find: '<h2>Start Trading on Var</h2>',
    replace: '<h2>About the Variational referral</h2>' },
  { label: 'CTA: paragraph (remove reward bait)',
    find: 'Trade perps on 500+ markets with zero fees and up to 50x leverage. Sign up with the referral code below to lock in your bonus.',
    replace: 'Proof of VARIATIONAL is an unofficial community tracker and is not affiliated with Variational. If you choose to trade on Variational, the optional referral code below applies a +15% points boost.' },
  { label: 'CTA: code label',
    find: 'CODE: OMNIMUAR ',
    replace: 'Optional code: OMNIMUAR ' },
  { label: 'CTA: button',
    find: '>Trade on Var with +15% boost \u2197<',
    replace: '>Open Variational \u2197<' },
  { label: 'referral links: rel=nofollow sponsored (all)',
    find: 'href="https://omni.variational.io/?ref=OMNIMUAR" target="_blank" rel="noopener"',
    replace: 'href="https://omni.variational.io/?ref=OMNIMUAR" target="_blank" rel="nofollow sponsored noopener"',
    all: true },
  { label: 'auto-tweets: share site URL, not referral (all)',
    find: "esc('https://omni.variational.io/?ref=OMNIMUAR')",
    replace: "esc('https://vivalavar.xyz')",
    all: true },
];

let applied = 0;
for (const e of edits) {
  if (s.includes(e.find)) {
    s = e.all ? s.split(e.find).join(e.replace) : s.replace(e.find, e.replace);
    console.log('OK:   ' + e.label);
    applied++;
  } else if (s.includes(e.replace)) {
    console.log('SKIP: ' + e.label + ' (already applied)');
  } else {
    console.log('WARN: ' + e.label + ' \u2014 pattern not found (live file may differ)');
  }
}

if (s !== orig) {
  fs.writeFileSync(file, s);
  console.log('\nDONE: wrote ' + applied + ' edits to ' + file);
} else {
  console.log('\nNo changes written.');
}
