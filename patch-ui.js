// Add to Proof-of-* sites: (1) site-domain label in the top-right header,
// (2) a "Save image" (📷) button that exports the card as PNG with the domain in the corner,
// (3) mobile responsiveness.
// Usage: node patch-ui.js <public/index.html> <domain>
//   e.g. node patch-ui.js public/index.html vivalavar.xyz
//        node patch-ui.js public/index.html ogbulk.xyz
// Idempotent: re-running reports SKIP for already-applied parts.

const INNER_JS = `(function(){
var DOMAIN='__DOMAIN__';
function brandText(){var b=document.querySelector('.pov-brand');return b?b.textContent.trim():DOMAIN;}
function safeName(){var el=document.getElementById('pName');var s=(el&&el.textContent)?el.textContent:'card';var o='';for(var i=0;i<s.length;i++){var c=s.charAt(i);if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c==='_'){o+=c;}}return o||'card';}
function makeBar(){var bar=document.createElement('div');bar.className='pov-shot-bar';var b=document.createElement('span');b.className='b';b.textContent=brandText();var d=document.createElement('span');d.className='d';d.textContent=DOMAIN;bar.appendChild(b);bar.appendChild(d);return bar;}
function shoot(node,fileBase,hideSel){
if(!node){return;}
if(typeof window.html2canvas!=='function'){alert('Image tool is still loading — try again in a moment.');return;}
var hidden=[];
if(hideSel){var els=node.querySelectorAll(hideSel);for(var i=0;i<els.length;i++){hidden.push([els[i],els[i].style.display]);els[i].style.display='none';}}
var bar=makeBar();node.insertBefore(bar,node.firstChild);
function cleanup(){if(bar.parentNode){bar.parentNode.removeChild(bar);}for(var j=0;j<hidden.length;j++){hidden[j][0].style.display=hidden[j][1];}}
window.html2canvas(node,{useCORS:true,scale:2,backgroundColor:null,logging:false}).then(function(canvas){
try{var a=document.createElement('a');a.download=fileBase+'.png';a.href=canvas.toDataURL('image/png');document.body.appendChild(a);a.click();a.remove();}catch(err){alert('Could not save image.');}
cleanup();
}).catch(function(){cleanup();alert('Could not generate image.');});
}
document.addEventListener('click',function(e){
var t=e.target;if(!t||!t.id){return;}
if(t.id==='pSaveImg'){shoot(document.querySelector('#profileView .pov-profile'),'proof-'+safeName(),'.pov-prof-h3,.pov-breakdown,.pov-posts,.pov-share-row');}
else if(t.id==='cSaveImg'){shoot(document.getElementById('card'),'proof-card',null);}
});
})();`;

if (process.argv[2] === '--emitjs') {
	process.stdout.write(INNER_JS.split('__DOMAIN__').join('example.com'));
	process.exit(0);
}

const fs = require('fs');
const file = process.argv[2];
const DOMAIN = process.argv[3];
if (!file || !DOMAIN) { console.error('Usage: node patch-ui.js <index.html> <domain>'); process.exit(1); }

let s = fs.readFileSync(file, 'utf8');
const orig = s;

const CSS = `
/* pov-uiaddons: domain label + screenshot card + mobile */
.pov-domain{display:inline-flex;align-items:center;padding:7px 13px;border-radius:11px;font-weight:800;font-size:13.5px;color:var(--text);background:var(--surface);border:1px solid var(--border);white-space:nowrap;line-height:1;}
.pov-domain:hover{text-decoration:none;border-color:var(--text-dim);transform:translateY(-1px);}
.pov-shotbtn{}
.pov-shot-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 18px;padding-bottom:13px;border-bottom:1px solid var(--border-soft);}
.pov-shot-bar .b{font-weight:900;font-size:16px;letter-spacing:.01em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap;}
.pov-shot-bar .d{font-weight:800;font-size:13px;color:var(--text);background:var(--surface);border:1px solid var(--border);padding:5px 11px;border-radius:9px;white-space:nowrap;}
@media (max-width:680px){
.notion-shell{padding:0 14px 72px;}
.pov-topbar{padding:14px 0 6px;gap:10px;}
.pov-brand{font-size:16px;gap:9px;}
.pov-logo-mark{width:28px;height:28px;}
.pov-nav{gap:7px;}
.pov-btn{padding:8px 12px;font-size:13px;}
.pov-domain{padding:6px 11px;font-size:12.5px;}
.pov-hero{padding:24px 0 4px;}
.pov-hero h1{font-size:clamp(28px,9vw,42px);}
.pov-tagline{font-size:14.5px;}
.pov-scan{margin-top:20px;}
.pov-share-row{flex-direction:column;gap:9px;}
.pov-share-row .pov-btn{min-width:0;width:100%;}
.pov-profile{padding:18px;}
.pov-prof-head{gap:13px;}
.pov-prof-avatar{width:64px;height:64px;font-size:26px;}
.pov-prof-chart{height:175px;}
.pov-card{padding:18px;}
.pov-card-stats{grid-template-columns:1fr;}
.pov-board th,.pov-board td{padding:10px 9px;font-size:13px;}
.pov-table-wrap{overflow-x:auto;}
.pov-board{min-width:520px;}
.pov-cta{padding:30px 16px;}
.pov-feat{gap:12px;}
.pov-shot-bar .b{font-size:14px;}
section{margin-top:34px;}
}
`;

const SCRIPT_TAG = '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>';
const INJECT_JS = '<script>\n/* pov-shot-js */\n' + INNER_JS.split('__DOMAIN__').join(DOMAIN) + '\n</script>';

const edits = [
	{
		label: 'CSS add-ons + html2canvas script',
		skipIf: 'pov-uiaddons',
		find: '</style></head>',
		replace: '\n' + CSS + '</style>\n' + SCRIPT_TAG + '\n</head>',
	},
	{
		label: 'domain label in header',
		skipIf: 'class="pov-domain"',
		find: '<nav class="pov-nav">',
		replace: '<nav class="pov-nav"><a class="pov-domain" href="https://' + DOMAIN + '" target="_blank" rel="noopener">' + DOMAIN + '</a>',
	},
	{
		label: 'Save image button (profile)',
		skipIf: 'id="pSaveImg"',
		find: '<a class="pov-btn pov-btn-primary" id="pShareX" href="#" target="_blank" rel="noopener">𝕏 Share this profile</a>',
		replace: '<a class="pov-btn pov-btn-primary" id="pShareX" href="#" target="_blank" rel="noopener">𝕏 Share this profile</a>\n\t\t\t\t\t<button class="pov-btn pov-btn-ghost pov-shotbtn" id="pSaveImg" type="button">📷 Save image</button>',
	},
	{
		label: 'Save image button (scan card)',
		skipIf: 'id="cSaveImg"',
		find: '<button class="pov-btn pov-btn-ghost" id="openProfileBtn" type="button">View full profile →</button>',
		replace: '<button class="pov-btn pov-btn-ghost" id="openProfileBtn" type="button">View full profile →</button>\n\t\t\t\t\t<button class="pov-btn pov-btn-ghost pov-shotbtn" id="cSaveImg" type="button">📷 Save image</button>',
	},
	{
		label: 'screenshot script before </body>',
		skipIf: 'pov-shot-js',
		find: '</body>',
		replace: INJECT_JS + '\n</body>',
	},
];

let applied = 0;
for (const e of edits) {
	if (orig.includes(e.skipIf)) {
		console.log('SKIP: ' + e.label + ' (already applied)');
	} else if (s.includes(e.find)) {
		s = s.replace(e.find, e.replace);
		console.log('OK:   ' + e.label);
		applied++;
	} else {
		console.log('WARN: ' + e.label + ' — anchor not found (file may differ)');
	}
}

if (s !== orig) { fs.writeFileSync(file, s); console.log('\nDONE: wrote ' + applied + ' edit(s) to ' + file); }
else { console.log('\nNo changes written.'); }
