#!/usr/bin/env python3
"""Replace the <script> block in the TickWay index.html with the API-connected version."""
import sys

html_path = sys.argv[1]

with open(html_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the <script> tag and replace everything from there to </script>
script_start = content.index('<script>\n')
script_end = content.index('</script>') + len('</script>')

new_script = r'''<script>
document.documentElement.classList.add('js');
const API_BASE=''; // Même origine en production ; changer en 'http://localhost:3000' si le front est servi séparément
const $=(s,e=document)=>e.querySelector(s),$$=(s,e=document)=>[...e.querySelectorAll(s)],
ic=n=>`<svg class="i"><use href="#i-${n}"/></svg>`,fmt=n=>n.toLocaleString('fr-FR')+' FCFA',
esc=s=>s.replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';');
const EV=[
{id:'k',n:'Kiff No Beat',t:'Concert',m:'Novembre',d:'Sam. 21 novembre 2026',h:'19 h 00',p:5000},
{id:'t',n:'Tiakola',t:'Concert',m:'Décembre',d:'Sam. 12 décembre 2026',h:'20 h 00',p:7000},
{id:'h',n:'Himra',t:'Concert',m:'Décembre',d:'Sam. 19 décembre 2026',h:'20 h 00',p:6000},
{id:'m',n:'Mother Africa Festival',t:'Festival',m:'Décembre',d:'Sam. 26 décembre 2026',h:'18 h 00',p:5500}];
const RL=[{n:'Abidjan Nord',p:[['Yopougon','Cosmos'],['Abobo','Mairie d\u2019Abobo'],['Adjam\u00e9','Gare routi\u00e8re'],['Att\u00e9coub\u00e9','Carrefour SICOGI'],['Anyama','Carrefour Anyama'],['Songon','Terminus SOTRA'],['Bingerville','K\u00e9s\u00e9'],['Al\u00e9p\u00e9','Carrefour Al\u00e9p\u00e9'],['Azagui\u00e9','Carrefour Azagui\u00e9'],['Jacqueville','Carrefour Jacqueville']]},{n:'Abidjan Sud',p:[['Cocody','UFHB'],['Plateau','Cath\u00e9drale du Plateau'],['Marcory','Prima Center'],['Treichville','Gare SOTRA'],['Koumassi','Grand March\u00e9'],['Port-Bou\u00ebt','Mairie de Port-Bou\u00ebt'],['Vraidi','Carrefour Vraidi'],['Bassam','Carrefour Bassam'],['Grand-Bassam','Carrefour Grand-Bassam'],['Bongouanou','Carrefour Bongouanou']]}];
const PT=()=>S.pt==null?null:{z:RL[S.z].n,c:RL[S.z].p[S.pt][0],l:RL[S.z].p[S.pt][1]};
$('#zs').innerHTML=RL.map(z=>`<div><h3>${ic('pin')}${z.n}</h3><ul>${z.p.map(([c,l],i)=>`<li class="r" style="--d:${i}"><b>${c}</b><span class="mut">${l}</span></li>`).join('')}</ul></div>`).join('');
const PM=[['om','Orange Money','sm',0],['mt','MTN MoMo','sm',0],['wv','Wave','sm',1],['cb','Carte bancaire','cd',0]],WAVE_LINK='https://pay.wave.com/m/M_ci_BDqgKg4Wl7G2/c/ci';
const F=[['wh','V\u00e9hicule d\u00e9di\u00e9','Un v\u00e9hicule r\u00e9serv\u00e9 \u00e0 votre \u00e9v\u00e9nement\u00a0: rendez-vous au point relais, nous nous occupons de la route.'],['pin','20 points relais','Vingt points de d\u00e9part \u00e0 Abidjan Nord et Abidjan Sud, au plus pr\u00e8s de chez vous.'],['qr','QR code unique','Re\u00e7u et billet num\u00e9rique envoy\u00e9s par e-mail, v\u00e9rifi\u00e9 et valid\u00e9 une seule fois par nos \u00e9quipes.'],['sh','Paiement s\u00e9curis\u00e9','Mobile money ou carte bancaire, confirmation imm\u00e9diate.']];
const T=[['Vos informations','Nom, pr\u00e9nom, t\u00e9l\u00e9phone et e-mail pour recevoir votre billet.'],['Votre \u00e9v\u00e9nement','Kiff No Beat, Tiakola, Himra ou Mother Africa Festival.'],['Votre point relais','Votre zone, puis le point le plus proche de chez vous.'],['Paiement et QR code','Re\u00e7u et QR code unique envoy\u00e9s par e-mail.']];

$('#h1').innerHTML='Le concert commence d\u00e8s le trajet.'.split(' ').map((w,i)=>`<span><b style="--i:${i}">${w}</b></span>`).join(' ');
const sp=`<span>${ic('mu')}</span>`,mq=EV.map(e=>`<span>${e.n}</span>`).join(sp)+sp;$('#mq').innerHTML=mq.repeat(4);
$('#rows').innerHTML=F.map(([i,t,d],k)=>`<li class="r" style="--d:${k}">${ic(i)}<h3>${t}</h3><p class="mut">${d}</p></li>`).join('');
$('#tl').innerHTML=T.map(([a,b],i)=>`<li class="st"><i>${i+1}</i><h3>${a}</h3><p class="mut">${b}</p></li>`).join('');
$('#evs').innerHTML=EV.map((e,i)=>`<div class="r" style="--d:${i}"><article class="ev"><span class="tg">${e.m}</span><h3>${e.n}</h3><p class="mut">${ic('cal')}${e.d}</p><p class="mut">${ic('cl')}${e.h}</p><div class="fo"><span class="pr">${fmt(e.p)} <small>par place</small></span><button class="btn" data-ev="${e.id}">R\u00e9server cet \u00e9v\u00e9nement</button></div></article></div>`).join('');

/* R\u00e9servation */
const S={ev:null,z:0,pt:null,pm:'wv'},E=()=>EV.find(e=>e.id==S.ev);let st=0,tm;
const f=$('#f'),pn=$$('.pn'),stp=$('#stp'),bk=$('#bk'),nx=$('#nx'),dn=$('#dn'),M=$('#main');
stp.innerHTML=['Infos','\u00c9v\u00e9nement','Relais','Paiement'].map(t=>`<li>${t}</li>`).join('');
const toast=m=>{const t=$('#toast');$('span',t).textContent=m;t.classList.add('on');clearTimeout(tm);tm=setTimeout(()=>t.classList.remove('on'),2800)};
const er=(p,t)=>{const e=$('.er',p);e.textContent=t;e.classList.remove('shk');void e.offsetWidth;t&&e.classList.add('shk')};
function rEv(){$('#eo').innerHTML=['Novembre','D\u00e9cembre'].map(m=>`<h4>${m} 2026</h4>`+EV.filter(e=>e.m==m).map(e=>`<button type="button" class="opt${S.ev==e.id?' sel':''}" data-id="${e.id}">${ic('mu')}<div><b>${e.n}</b><small>${e.d}, ${e.h}</small></div><span>${fmt(e.p)}</span></button>`).join('')).join('')}
function rRl(){const z=RL[S.z],t=$('#zt');t.style.setProperty('--x',S.z?'100%':'0');t.innerHTML=RL.map((r,i)=>`<button type="button" class="${i==S.z?'on':''}" data-z="${i}">${r.n}</button>`).join('');
$('#ro').innerHTML=z.p.map(([c,l],i)=>`<button type="button" class="opt${S.pt===i?' sel':''}" data-i="${i}" style="--i:${i}">${ic('pin')}<div><b>${c}</b><small>${l}</small></div></button>`).join('')}
function rPm(){$('#pm').innerHTML=PM.map(([id,n,i,a])=>`<button type="button" class="opt${S.pm==id?' sel':''}" data-id="${id}"${a?'':' disabled'}>${ic(i)}<div><b>${n}</b>${a?'':'<small>Bient\u00f4t disponible</small>'}</div></button>`).join('')}
function rc(){const e=E(),r=PT();
$('#rc').innerHTML='<h3>R\u00e9capitulatif</h3>'+[['mu','\u00c9v\u00e9nement',e&&e.n],['cal','Date',e&&e.d],['pin','Point relais',r&&r.c+', '+r.l]].map(([i,l,v])=>`<div class="rw${v?' ok':''}">${ic(i)}<span>${l}</span><b>${v||'\u2014'}</b></div>`).join('')+`<div class="tt"><span>Total</span><b>${e?fmt(e.p):'\u2014'}</b></div>`;
$('#tt').textContent=e?fmt(e.p):'\u2014'}
function go(n){st=n;pn.forEach((p,i)=>p.classList.toggle('on',i==n));$$('li',stp).forEach((l,i)=>{l.classList.toggle('dn',i<n);l.classList.toggle('on',i==n)});
bk.style.visibility=n?'visible':'hidden';nx.disabled=false;nx.textContent=n==3?'Payer '+fmt(E().p):'Continuer';rc();if(M.getBoundingClientRect().top<0)M.scrollIntoView()}
const V={pr:v=>v.trim().length>1,nm:v=>v.trim().length>1,tel:v=>/^\d{8,13}$/.test(v.replace(/[\s.+()-]/g,'')),ml:v=>/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)},
MS={pr:'Indiquez votre pr\u00e9nom.',nm:'Indiquez votre nom.',tel:'Num\u00e9ro de t\u00e9l\u00e9phone invalide.',ml:'Adresse e-mail invalide.'};
function ok(){if(st==0){let all=true;for(const k in V){const i=f.elements[k],g=V[k](i.value);i.nextElementSibling.textContent=g?'':MS[k];i.classList.toggle('bad',!g);if(!g)all=false}const b=$('.bad',f);b&&b.focus();return all}
const v=[0,S.ev,S.pt!=null||null][st];er(pn[st],v?'':['','Choisissez un \u00e9v\u00e9nement pour continuer.','Choisissez un point relais.'][st]);return !!v}
function setEv(id){S.ev=id;rEv();rc();er(pn[1],'')}
$('#eo').onclick=e=>{const b=e.target.closest('.opt');b&&setEv(b.dataset.id)};
$('#zt').onclick=e=>{const b=e.target.closest('button');if(b&&+b.dataset.z!=S.z){S.z=+b.dataset.z;S.pt=null;rRl();rc()}};
$('#ro').onclick=e=>{const b=e.target.closest('.opt');if(b){S.pt=+b.dataset.i;er(pn[2],'');$$('.opt',$('#ro')).forEach(x=>x.classList.toggle('sel',x==b));rc()}};
$('#pm').onclick=e=>{const b=e.target.closest('.opt');if(b){S.pm=b.dataset.id;rPm()}};
$('#evs').onclick=e=>{const b=e.target.closest('[data-ev]');if(!b)return;if(!dn.hidden)reset();setEv(b.dataset.ev);go(st);$('#reserver').scrollIntoView();toast(E().n+' s\u00e9lectionn\u00e9.')};
bk.onclick=()=>{$('#waveWait').hidden=true;go(st-1)};nx.onclick=()=>{if(st==3)return pay();ok()&&go(st+1)};
f.onkeydown=e=>{if(e.key=='Enter'&&e.target.tagName=='INPUT'){e.preventDefault();nx.click()}};
function pay(){window.open(WAVE_LINK,'_blank','noopener,noreferrer');$('#waveAmt').textContent=fmt(E().p);$('#waveWait').hidden=false;nx.disabled=true;nx.textContent='En attente du paiement\u2026'}
$('#waveReopen').onclick=()=>window.open(WAVE_LINK,'_blank','noopener,noreferrer');
$('#waveDone').onclick=finish;
async function finish(){
const e=E(),r=PT(),d=Object.fromEntries(new FormData(f)),pm=PM.find(x=>x[0]==S.pm)[1];
nx.disabled=true;nx.innerHTML='<span class="sp"></span> Paiement en cours\u2026';
try{
const resp=await fetch(API_BASE+'/api/reservations',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({prenom:d.pr,nom:d.nm,telephone:d.tel,email:d.ml,eventId:S.ev,zone:S.z,pointRelaisIndex:S.pt,modePaiement:S.pm})});
const json=await resp.json();
if(!resp.ok){toast(json.message||Object.values(json.errors||{}).join(' ')||'Erreur lors de la r\u00e9servation.');nx.disabled=false;nx.textContent='R\u00e9essayer';return}
const ref=json.reference;
f.hidden=true;dn.hidden=false;
dn.innerHTML=`<div class="ok"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 14-16"/></svg></div><h3>R\u00e9servation confirm\u00e9e</h3><p class="mut">Votre re\u00e7u et votre QR code unique ont \u00e9t\u00e9 envoy\u00e9s \u00e0 <b>${esc(d.ml)}</b>.</p><div class="tk"><dl>${[['R\u00e9f\u00e9rence',ref],['Passager',esc(d.pr+' '+d.nm)],['\u00c9v\u00e9nement',e.n],['Date',e.d+', '+e.h],['Zone',r.z],['Point relais',r.c+', '+r.l],['Montant pay\u00e9',fmt(e.p)+' ('+pm+')']].map(([a,b])=>`<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl><div class="qb"><div id="qr"></div><span>\u00c0 usage unique \u2014 pr\u00e9sentez-le \u00e0 l\u2019entr\u00e9e</span></div></div><div class="ac"><button type="button" class="btn gh" id="rs">Renvoyer l\u2019e-mail</button><button type="button" class="btn" id="nw">Nouvelle r\u00e9servation</button></div>`;
window.QRCode?new QRCode($('#qr'),{text:ref,width:150,height:150,colorDark:'#1b1f24',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M}):$('#qr').textContent=ref;
$('#rs').onclick=async()=>{try{await fetch(API_BASE+'/api/resend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference:ref})});toast('E-mail renvoy\u00e9 \u00e0 '+d.ml+'.')}catch(err){toast('\u00c9chec du renvoi.')}};
$('#nw').onclick=reset;rc();if(M.getBoundingClientRect().top<0)M.scrollIntoView()}
catch(err){console.error(err);toast('Erreur r\u00e9seau. V\u00e9rifiez votre connexion.');nx.disabled=false;nx.textContent='R\u00e9essayer'}}
function reset(){f.reset();S.ev=S.pt=null;S.z=0;S.pm='wv';dn.hidden=true;f.hidden=false;$('#waveWait').hidden=true;$$('.bad',f).forEach(x=>x.classList.remove('bad'));$$('em',f).forEach(x=>x.textContent='');rEv();rRl();rPm();go(0)}
rEv();rRl();rPm();go(0);

/* Animations au scroll */
const nav=$('#nav'),bar=$('#bar'),van=$('#van'),glow=$('#glow'),bgt=$('#bgt'),tl=$('#tl'),sts=$$('.st'),sec=$('#events');let q;
function tick(){const y=scrollY,H=innerHeight,m=document.documentElement.scrollHeight-H;
bar.style.transform='scaleX('+(m>0?y/m:0)+')';nav.classList.toggle('sc',y>40);
glow.style.transform='translateY('+Math.min(y,H)*.3+'px)';
van.style.transform='translateX('+Math.min(y,H*1.2)*1.3+'px)';
bgt.style.transform='translateX('+sec.getBoundingClientRect().top*.3+'px)';
const r=tl.getBoundingClientRect(),L=H*.6;tl.style.setProperty('--p',Math.max(0,Math.min(1,(L-r.top)/r.height)));
sts.forEach(s=>s.classList.toggle('on',s.getBoundingClientRect().top<L))}
addEventListener('scroll',()=>q||(q=requestAnimationFrame(()=>{q=0;tick()})),{passive:true});addEventListener('resize',tick);tick();
const io=new IntersectionObserver(a=>a.forEach(x=>{if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}}),{threshold:.15});
$$('.r').forEach(e=>io.observe(e));
$$('.ev').forEach(c=>{c.onmousemove=e=>{const b=c.getBoundingClientRect(),x=(e.clientX-b.left)/b.width-.5,y=(e.clientY-b.top)/b.height-.5;
c.style.transform=`perspective(900px) rotateY(${x*9}deg) rotateX(${-y*9}deg) translateY(-6px)`;c.style.setProperty('--mx',(x+.5)*100+'%');c.style.setProperty('--my',(y+.5)*100+'%')};c.onmouseleave=()=>c.style.transform=''});

/* Contr\u00f4le des billets : appels API au serveur */
const VALIDATE_KEY=localStorage.getItem('tickway_validate_key')||'';
function logAdd(code,s){const row=document.createElement('div');row.className='logr';row.innerHTML=`<span>${esc(code)}</span><span>${s} \u00b7 ${new Date().toLocaleTimeString('fr-FR').slice(0,5)}</span>`;$('#log').prepend(row)}
async function verif(code){
code=(code||'').trim().toUpperCase();if(!code)return;
const res=$('#res');
const key=VALIDATE_KEY||prompt('Entrez la cl\u00e9 API de validation (X-Api-Key) :');
if(!key){res.className='res bad';res.innerHTML=ic('x')+'<div><b>Cl\u00e9 API requise</b><p class="mut">Vous devez fournir la cl\u00e9 d\u2019API pour valider les billets.</p></div>';return}
if(!VALIDATE_KEY){localStorage.setItem('tickway_validate_key',key)}
try{
const resp=await fetch(API_BASE+'/api/validate',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':key},body:JSON.stringify({reference:code})});
const json=await resp.json();
if(json.statut==='valide_maintenant'){
res.className='res ok2';res.innerHTML=ic('ck')+`<div><b>Billet valide \u2014 entr\u00e9e autoris\u00e9e</b><p class="mut">${esc(json.passager)} \u2014 ${esc(json.evenement)}, ${esc(json.date)}<br>Point relais\u00a0: ${esc(json.pointRelais)} \u00b7 ${fmt(json.montant)}</p></div>`;logAdd(code,'valid\u00e9');$('#codeIn').value=''}
else if(json.statut==='deja_utilise'){
res.className='res warn';res.innerHTML=ic('warn')+`<div><b>Billet d\u00e9j\u00e0 utilis\u00e9</b><p class="mut">${esc(json.passager)} \u2014 ${esc(json.evenement)}. Entr\u00e9e d\u00e9j\u00e0 enregistr\u00e9e le ${new Date(json.utiliseLe).toLocaleString('fr-FR')}.</p></div>`;logAdd(code,'d\u00e9j\u00e0 utilis\u00e9')}
else if(json.statut==='introuvable'){
res.className='res bad';res.innerHTML=ic('x')+`<div><b>Code introuvable</b><p class="mut">\u00ab\u00a0${esc(code)}\u00a0\u00bb ne correspond \u00e0 aucune r\u00e9servation.</p></div>`;logAdd(code,'introuvable')}
else if(json.statut==='erreur'&&resp.status===401){
localStorage.removeItem('tickway_validate_key');
res.className='res bad';res.innerHTML=ic('x')+`<div><b>Cl\u00e9 API invalide</b><p class="mut">${esc(json.message)}</p></div>`}
else{res.className='res bad';res.innerHTML=ic('x')+`<div><b>Erreur</b><p class="mut">${esc(json.message||'Erreur inconnue')}</p></div>`}}
catch(err){res.className='res bad';res.innerHTML=ic('x')+'<div><b>Erreur r\u00e9seau</b><p class="mut">Impossible de joindre le serveur.</p></div>'}}
$('#codeBtn').onclick=()=>verif($('#codeIn').value);
$('#codeIn').onkeydown=e=>{if(e.key=='Enter')verif(e.target.value)};
let camS,camR;const vid=$('#vid'),camCv=document.createElement('canvas'),camCx=camCv.getContext('2d',{willReadFrequently:true});
function camStop(){camS&&camS.getTracks().forEach(t=>t.stop());camS=null;cancelAnimationFrame(camR);$('#camMsg').textContent='Cam\u00e9ra arr\u00eat\u00e9e.';$('#camBtn').innerHTML=ic('scan')+'D\u00e9marrer le scanner'}
function camLoop(){if(!camS)return;if(vid.videoWidth){camCv.width=vid.videoWidth;camCv.height=vid.videoHeight;camCx.drawImage(vid,0,0);
const im=camCx.getImageData(0,0,camCv.width,camCv.height),qr=window.jsQR&&jsQR(im.data,im.width,im.height);
if(qr&&qr.data){const c=qr.data;camStop();$('#codeIn').value=c;verif(c);return}}camR=requestAnimationFrame(camLoop)}
$('#camBtn').onclick=async()=>{if(camS){camStop();return}
try{camS=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});vid.srcObject=camS;await vid.play();
$('#camMsg').textContent='Visez le QR code du billet.';$('#camBtn').innerHTML=ic('x')+'Arr\u00eater le scanner';camLoop()}
catch(err){$('#camMsg').textContent='Cam\u00e9ra inaccessible\u00a0: utilisez la saisie manuelle ci-dessous.'}};
function route(){const ctl=location.hash.slice(1)=='controle';$('main').hidden=ctl;$('#controle').hidden=!ctl;if(!ctl)camStop()}
addEventListener('hashchange',route);route();
</script>'''

new_content = content[:script_start] + new_script + content[script_end:]

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Done! Script section replaced successfully.")
