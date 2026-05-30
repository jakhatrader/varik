// patch-ui.js — adds to the Proof-of-* sites:
//   1. site-domain label in the top-right header (links to itself),
//   2. a "Save image" (📷) button exporting the card as PNG with the domain in the corner,
//      avatars routed through the backend /img proxy so they render in the screenshot,
//   3. mobile responsiveness.
// Requires the backend /img proxy (apply patch-imgproxy.js to server.js).
// Self-upgrading: strips any previously-injected version, then re-applies cleanly.
// Usage: node patch-ui.js <public/index.html> <domain>

const INNER_JS = `(function(){
var DOMAIN='__DOMAIN__';
function brandText(){var b=document.querySelector('.pov-brand');return b?b.textContent.trim():DOMAIN;}
function safeName(){var el=document.getElementById('pName');var s=(el&&el.textContent)?el.textContent:'card';var o='';for(var i=0;i<s.length;i++){var c=s.charAt(i);if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c==='_'){o+=c;}}return o||'card';}
function makeBar(){var bar=document.createElement('div');bar.className='pov-shot-bar';var b=document.createElement('span');b.className='b';b.textContent=brandText();var d=document.createElement('span');d.className='d';d.textContent=DOMAIN;bar.appendChild(b);bar.appendChild(d);return bar;}
function isProxyable(src){if(!src||src.indexOf('http')!==0){return false;}try{var u=new URL(src);var h=u.hostname.toLowerCase();return h==='unavatar.io'||h.slice(-12)==='.unavatar.io'||h==='twimg.com'||h.slice(-10)==='.twimg.com';}catch(e){return false;}}
function proxify(node){var imgs=node.querySelectorAll('img');var ps=[];var swapped=[];for(var i=0;i<imgs.length;i++){(function(im){var src=im.getAttribute('src')||'';if(isProxyable(src)){swapped.push([im,src]);ps.push(new Promise(function(res){im.onload=function(){res();};im.onerror=function(){res();};}));im.setAttribute('src','/img?u='+encodeURIComponent(src));}})(imgs[i]);}return {ps:ps,swapped:swapped};}
function waitImgs(ps){return Promise.race([Promise.all(ps),new Promise(function(r){setTimeout(r,5000);})]);}
function shoot(node,fileBase,hideSel){
if(!node){return;}
if(typeof window.html2canvas!=='function'){alert('Image tool is still loading — try again in a moment.');return;}
var hidden=[];
if(hideSel){var els=node.querySelectorAll(hideSel);for(var i=0;i<els.length;i++){hidden.push([els[i],els[i].style.display]);els[i].style.display='none';}}
var bar=makeBar();node.insertBefore(bar,node.firstChild);
var px=proxify(node);
function cleanup(){if(bar.parentNode){bar.parentNode.removeChild(bar);}for(var j=0;j<hidden.length;j++){hidden[j][0].style.display=hidden[j][1];}for(var k=0;k<px.swapped.length;k++){px.swapped[k][0].setAttribute('src',px.swapped[k][1]);}}
waitImgs(px.ps).then(function(){return window.html2canvas(node,{useCORS:true,scale:2,backgroundColor:null,logging:false});}).then(function(canvas){try{var a=document.createElement('a');a.download=fileBase+'.png';a.href=canvas.toDataURL('image/png');document.body.appendChild(a);a.click();a.remove();}catch(err){alert('Could not save image.');}cleanup();}).catch(function(){cleanup();alert('Could not generate image.');});
}
function relocate(){var pp=document.querySelector('#profileView .pov-profile');if(pp){var psr=pp.querySelector('.pov-share-row');var pst=pp.querySelector('.pov-prof-stats');if(psr&&pst&&psr!==pst&&pst.parentNode){pst.parentNode.insertBefore(psr,pst);}}var card=document.getElementById('card');var res=document.getElementById('result');if(card&&res){var csr=res.querySelector('.pov-share-row');var cst=card.querySelector('.pov-card-stats');if(csr&&cst&&cst.parentNode){cst.parentNode.insertBefore(csr,cst);}}}document.addEventListener('click',function(e){relocate();
var t=e.target;if(!t||!t.id){return;}
if(t.id==='pSaveImg'){shoot(document.querySelector('#profileView .pov-profile'),'proof-'+safeName(),'.pov-prof-h3,.pov-breakdown,.pov-posts,.pov-share-row');}
else if(t.id==='cSaveImg'){shoot(document.getElementById('card'),'proof-card','.pov-share-row');}
});
relocate();setTimeout(relocate,800);
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

const CSS = `
/* pov-uiaddons: domain label + screenshot card + mobile */
.pov-domain{display:none;align-items:center;padding:7px 13px;border-radius:11px;font-weight:800;font-size:13.5px;color:var(--text);background:var(--surface);border:1px solid var(--border);white-space:nowrap;line-height:1;}
main.mode-profile .pov-domain{display:inline-flex;}
.pov-domain:hover{text-decoration:none;border-color:var(--text-dim);transform:translateY(-1px);}
.pov-shot-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 18px;padding-bottom:13px;border-bottom:1px solid var(--border-soft);}
.pov-shot-bar .b{font-weight:900;font-size:16px;letter-spacing:.01em;color:var(--text);white-space:nowrap;}
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

// ---- strip any previously injected version (clean re-apply / upgrade) ----
function stripScript(str){
	var mi = str.indexOf('/* pov-shot-js */');
	if (mi < 0) return str;
	var start = str.lastIndexOf('<script>', mi);
	var end = str.indexOf('</script>', mi);
	if (start < 0 || end < 0) return str;
	end += '</script>'.length;
	if (str.charAt(end) === '\n') end++;
	return str.slice(0, start) + str.slice(end);
}
function stripCss(str){
	var mi = str.indexOf('/* pov-uiaddons');
	if (mi < 0) return str;
	var start = mi;
	while (start > 0 && str.charAt(start - 1) === '\n') start--;
	var he = str.indexOf('</head>', mi);
	if (he < 0) return str;
	he += '</head>'.length;
	return str.slice(0, start) + '\n</style></head>' + str.slice(he);
}
function stripDomain(str){
	var a = str.indexOf('<a class="pov-domain"');
	if (a < 0) return str;
	var end = str.indexOf('</a>', a);
	if (end < 0) return str;
	end += '</a>'.length;
	return str.slice(0, a) + str.slice(end);
}
function stripBtn(str, id){
	var bi = str.indexOf('id="' + id + '"');
	if (bi < 0) return str;
	var start = str.lastIndexOf('<button', bi);
	var end = str.indexOf('</button>', bi);
	if (start < 0 || end < 0) return str;
	end += '</button>'.length;
	while (start > 0 && (str.charAt(start - 1) === ' ' || str.charAt(start - 1) === '\t' || str.charAt(start - 1) === '\n')) start--;
	return str.slice(0, start) + str.slice(end);
}

const before = s;
s = stripScript(s); s = stripCss(s); s = stripDomain(s); s = stripBtn(s, 'pSaveImg'); s = stripBtn(s, 'cSaveImg');
if (s !== before) { console.log('NOTE: removed previous UI add-ons before re-applying'); }

const SCRIPT_TAG = '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>';
const INJECT_JS = '<script>\n/* pov-shot-js */\n' + INNER_JS.split('__DOMAIN__').join(DOMAIN) + '\n</script>';

const edits = [
	{ label: 'CSS add-ons + html2canvas', find: '</style></head>', replace: '\n' + CSS + '</style>\n' + SCRIPT_TAG + '\n</head>' },
	{ label: 'domain label in header', find: '<nav class="pov-nav">', replace: '<nav class="pov-nav"><a class="pov-domain" href="https://' + DOMAIN + '" target="_blank" rel="noopener">' + DOMAIN + '</a>' },
	{ label: 'Save image button (profile)', find: '<a class="pov-btn pov-btn-primary" id="pShareX" href="#" target="_blank" rel="noopener">𝕏 Share this profile</a>', replace: '<a class="pov-btn pov-btn-primary" id="pShareX" href="#" target="_blank" rel="noopener">𝕏 Share this profile</a>\n\t\t\t\t\t<button class="pov-btn pov-btn-ghost pov-shotbtn" id="pSaveImg" type="button">📷 Save image</button>' },
	{ label: 'Save image button (scan card)', find: '<button class="pov-btn pov-btn-ghost" id="openProfileBtn" type="button">View full profile →</button>', replace: '<button class="pov-btn pov-btn-ghost" id="openProfileBtn" type="button">View full profile →</button>\n\t\t\t\t\t<button class="pov-btn pov-btn-ghost pov-shotbtn" id="cSaveImg" type="button">📷 Save image</button>' },
	{ label: 'screenshot script before </body>', find: '</body>', replace: INJECT_JS + '\n</body>' },
];

let applied = 0;
for (const e of edits) {
	if (s.includes(e.find)) { s = s.replace(e.find, e.replace); console.log('OK:   ' + e.label); applied++; }
	else { console.log('WARN: ' + e.label + ' \u2014 anchor not found'); }
}

fs.writeFileSync(file, s);
console.log('\nDONE: ' + applied + '/5 edit(s) applied to ' + file);
