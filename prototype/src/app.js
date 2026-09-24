/* ===== app: modes, camera, scroll story, explore, insights ===== */
(function(){
'use strict';
const body=document.body, stageEl=$('#stage'), scroller=$('#scroller');
const FOG=.0072, CH=[[0,.14],[.16,.40],[.44,.58],[.60,.76],[.78,.92],[.94,1.01]];
const NUMW=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const P={t:1,fog:FOG,hot:.5,focus:-1,focusAmt:0,hover:-1,fade:0,exposure:1};
const C={vp:null,vpR:null,pos:[0,0,0],posR:[0,0,0],right:[1,0,0],up:[0,1,0],fwd:[0,0,-1],tanH:.5};
let W=null, R=null, canvas=null, LN=0, lanterns=null;
let mode='hero', SW=1, SH=1, DPR=1;
let tierIdx=(matchMedia('(pointer:coarse)').matches||innerWidth<760||(navigator.hardwareConcurrency||8)<=4)?1:2, tierAuto=true;
let time=0, pS=0, pT=0, tT=1, playing=false, speed=1, selected=-1, hoverIdx=-1, lastInteract=-10;
let lastPos=[0,20,120], lastTgt=[0,4,0], xfrom=null, xt=1, xdur=1.1;
let K=[], sorted=[], names=[];
let loadT=0, loadLines=[], loadShown=0;
const mouse={x:0,y:0,px:0,py:0,over:false};
const E={yaw:.6,pitch:.5,dist:96,x:0,y:4,z:0}, G={yaw:.6,pitch:.5,dist:96,x:0,y:4,z:0};

/* ---------- helpers ---------- */
const v3={
  sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
  nrm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l]},
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
  lerp:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t],
};
const cr=(p0,p1,p2,p3,t)=>{const t2=t*t,t3=t2*t;return .5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3)};
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const setText=(el,t)=>{if(el.textContent!==t)el.textContent=t};

/* ---------- world + renderer ---------- */
function initWorld(repo){
  W=buildWorld(repo);
  LN=W.people_.length; lanterns=new Float32Array(LN*3);
  sorted=W.files.map((f,i)=>i).sort((a,b)=>W.files[a].birth-W.files[b].birth);
  names=W.files.map(f=>f.name.toLowerCase());
  if(!canvas){
    canvas=$('#gl');R=createRenderer(canvas,W);
    if(!R){body.classList.add('nogl');const fb=$('#fallback');fb.textContent='';const m=document.createElement('p');m.className='eyebrow';m.style.cssText='position:absolute;left:var(--gutter);top:40%;max-width:26rem';m.textContent='This device could not start WebGL 2, so the 3D city is unavailable. Everything else on the page still works.';fb.appendChild(m)}
    bindCanvas();
  }else if(R)R.setWorld(W);
  resize(true);
  buildKeys(); fillStatic(); renderList(activeTab); drawSpark(true);
  setText($('#repoPill'),repo);sparkBuckets=null;sparkLast=-1;
  const yrs=Math.max(1,Math.round((1-W.dists.find(d=>d.dead).maxLt)*W.years));
  setText($('#quietYears'),(NUMW[yrs]||yrs)+' years.');
  setText($('#busN'),cap(NUMW[BUS[0]]));
}
function resize(force){
  SW=stageEl.clientWidth||innerWidth; SH=stageEl.clientHeight||innerHeight;
  if(!R)return;
  const tier=R.tiers[tierIdx]; DPR=Math.min(devicePixelRatio||1,tier.dpr);
  const w=Math.max(2,Math.round(SW*DPR)), h=Math.max(2,Math.round(SH*DPR));
  if(force||canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;R.alloc(w,h,tier)}
  drawSpark(true);
}
function setTier(i,manual){
  tierIdx=clamp(i,0,2); if(manual)tierAuto=false;
  resize(true); fpsAcc=0;fpsN=0;grace=90;
  setText($('#btnQual'),'quality: '+R.tiers[tierIdx].name+(tierAuto?' (auto)':''));
}

/* ---------- camera ---------- */
function buildKeys(){
  const D=W.dists,f0=W.files[D[0].first],hf=W.files[W.hot[0]],leg=D.find(d=>d.dead),core=D[0];
  const fp=[f0.x,.28+f0.h*.5,f0.z];
  const hd=v3.nrm([hf.x,0,hf.z]), hp=[hf.x,.28+hf.h*.85,hf.z], hperp=[-hd[2],0,hd[0]];
  const ld=v3.nrm([leg.x,0,leg.z]), lperp=[-ld[2],0,ld[0]], lc=[leg.x,3.5,leg.z];
  const at=(o,k,dy,pp,kp)=>[o[0]+hd[0]*k+hperp[0]*(kp||0),o[1]+dy,o[2]+hd[2]*k+hperp[2]*(kp||0)];
  const la=(k,dy,kp)=>[leg.x+ld[0]*k+lperp[0]*kp,dy,leg.z+ld[2]*k+lperp[2]*kp];
  K=[
    {p:0,   pos:[fp[0]+9,fp[1]+4,fp[2]+21], tgt:[fp[0],fp[1]+1,fp[2]]},
    {p:.10, pos:[fp[0]+3,fp[1]+2.4,fp[2]+11], tgt:[fp[0],fp[1]+1.4,fp[2]]},
    {p:.17, pos:[26,13,56], tgt:[0,3,0]},
    {p:.27, pos:[62,26,30], tgt:[0,4,0]},
    {p:.34, pos:[8,34,88], tgt:[0,3,-6]},
    {p:.41, pos:[-56,26,54], tgt:[0,4,0]},
    {p:.47, pos:at(hp,40,22,0,10), tgt:hp},
    {p:.53, pos:at(hp,15,7,0,7), tgt:hp},
    {p:.58, pos:at(hp,9,5,0,-9), tgt:hp},
    {p:.62, pos:la(46,24,10), tgt:lc},
    {p:.69, pos:la(leg.r+16,9,10), tgt:lc},
    {p:.76, pos:la(leg.r+10,7,-(leg.r+12)), tgt:lc},
    {p:.80, pos:[0,34,46], tgt:[core.x,8,core.z]},
    {p:.86, pos:[-26,22,20], tgt:[core.x,9,core.z]},
    {p:.92, pos:[22,26,-18], tgt:[core.x,8,core.z]},
    {p:.96, pos:[0,46,112], tgt:[0,4,0]},
    {p:1.0, pos:[0,56,132], tgt:[0,4,0]},
  ];
}
function sampleKeys(p){
  let i=0;while(i<K.length-2&&p>=K[i+1].p)i++;
  const a=K[i],b=K[i+1],u=clamp((p-a.p)/(b.p-a.p),0,1);
  const k0=K[Math.max(0,i-1)],k3=K[Math.min(K.length-1,i+2)];
  const f=(key)=>[0,1,2].map(j=>cr(k0[key][j],a[key][j],b[key][j],k3[key][j],u));
  return{pos:f('pos'),tgt:f('tgt')};
}
function heroPose(){
  const A=time*.035+.5,r=innerWidth<760?150:126,pos=[Math.sin(A)*r,30+Math.sin(time*.1)*3,Math.cos(A)*r];
  const right=[Math.cos(A),0,-Math.sin(A)], off=innerWidth<760?0:32;
  return{pos,tgt:[-right[0]*off,10,-right[2]*off]};
}
function exploreCam(dt){
  const k=REDUCED?1:1-Math.exp(-dt*5.5);
  for(const key of['yaw','pitch','dist','x','y','z'])E[key]+=(G[key]-E[key])*k;
  const cp=Math.cos(E.pitch);
  return{pos:[E.x+Math.sin(E.yaw)*cp*E.dist,E.y+Math.sin(E.pitch)*E.dist,E.z+Math.cos(E.yaw)*cp*E.dist],tgt:[E.x,E.y,E.z]};
}
function applyCamera(pos,tgt){
  const asp=SW/SH, fov=(asp<1?70:50)*Math.PI/180;
  const view=M4.look(pos,tgt,[0,1,0]), proj=M4.persp(fov,asp,.4,1200);
  C.vp=M4.mul(proj,view); C.vpR=M4.mirrorY(C.vp);
  C.pos=pos; C.posR=[pos[0],-pos[1],pos[2]];
  const f=v3.nrm(v3.sub(tgt,pos)), r=v3.nrm(v3.cross(f,[0,1,0])), u=v3.cross(r,f);
  C.fwd=f;C.right=r;C.up=u;C.tanH=Math.tan(fov/2);
}
function project(x,y,z){
  const m=C.vp,w=m[3]*x+m[7]*y+m[11]*z+m[15];
  if(w<=.05)return null;
  const cx=(m[0]*x+m[4]*y+m[8]*z+m[12])/w, cy=(m[1]*x+m[5]*y+m[9]*z+m[13])/w;
  return{x:(cx*.5+.5)*SW,y:(1-(cy*.5+.5))*SH,w};
}

/* ---------- mode machine ---------- */
function setMode(m,dur){
  const prev=mode;
  if(prev==='story')storyScroll=pT;
  mode=m;
  for(const c of['hero','loading','story','explore'])body.classList.toggle(c,c===m);
  scroller.style.display=m==='story'?'block':'none';
  if(m==='story'){scrollTo(0,storyScroll*(document.documentElement.scrollHeight-innerHeight));}
  xfrom={pos:lastPos.slice(),tgt:lastTgt.slice()};xt=0;xdur=dur||1.1;
  $('#btnExplore').setAttribute('aria-pressed',m==='explore'?'true':'false');
  setText($('#btnExplore'),m==='explore'?'Story':'Explore');
  if(m!=='explore'){exitPhoto();hoverIdx=-1;tipHide();stopPlay()}
  if(m==='explore'){tT=1;P.hot=1;selected=-1;focusGoal=0;P.focus=-1;refreshPlaceholder();renderList(activeTab);}
  grace=60;
}
let storyScroll=0;

function startLoading(repo){
  initWorld(repo);
  P.t=1;
  setMode('loading',3.4);
  loadT=0;loadShown=0;
  const fm=fmt;
  loadLines=[
    [0,'resolving github.com/'+repo],
    [.55,'prototype: history is simulated from the name'],
    [1.05,'reading '+fm(W.commits)+' commits by '+W.people+' people'],
    [1.55,'mapping '+fm(W.files.length)+' files into '+W.dists.length+' districts'],
    [2.05,'finding hotspots, quiet zones and bus factor'],
    [2.6,'city ready, rebuilding it from day one'],
  ];
  const log=$('#log');log.textContent='';
  $('#barfill').style.width='0%';
  pS=0;pT=0;storyScroll=0;
}
function updateLoading(dt){
  loadT+=dt;
  const dur=REDUCED?1.2:3.4, k=loadT/dur;
  $('#barfill').style.width=(clamp(k,0,1)*100).toFixed(1)+'%';
  while(loadShown<loadLines.length&&loadT>=loadLines[loadShown][0]*(dur/3.4)){
    const log=$('#log'),row=document.createElement('div');
    if(loadShown>0){const prevRow=log.lastChild;const b=document.createElement('b');b.textContent=' ok';prevRow.appendChild(b)}
    row.textContent='> '+loadLines[loadShown][1];log.appendChild(row);loadShown++;
  }
  P.t=1-ease(clamp(loadT/(dur*.72),0,1));
  P.hot=lerp(.5,0,clamp(loadT/dur,0,1));
  if(loadT>=dur){
    const log=$('#log');if(log.lastChild&&!log.lastChild.querySelector('b')){const b=document.createElement('b');b.textContent=' ok';log.lastChild.appendChild(b)}
    setMode('story',1.2);P.t=0;
  }
}

/* ---------- story ---------- */
function storyT(p){
  if(p<.16)return .036+p/.16*.004;
  if(p<.40){const k=(p-.16)/.24,e=k*.5+(k*k*(3-2*k))*.5;return .040+(1-.040)*e}
  return 1;
}
let chapState=[];
function updateStory(dt){
  const max=Math.max(1,document.documentElement.scrollHeight-innerHeight);
  pT=clamp(scrollY/max,0,1);
  pS+=(pT-pS)*(REDUCED?1:1-Math.exp(-dt*4.5));
  const p=pS;
  P.t=storyT(p);
  P.hot=sstep(.40,.47,p);
  const legOp=sstep(.58,.63,p)*(1-sstep(.74,.78,p)), coreOp=sstep(.78,.82,p)*(1-sstep(.90,.94,p));
  P.fog=FOG*(1+.75*legOp)*(1-.35*sstep(.94,1,p));
  P.focus=legOp>coreOp?W.dists.findIndex(d=>d.dead):0;
  const fa=Math.max(legOp,coreOp)*.85; P.focusAmt+=(fa-P.focusAmt)*(1-Math.exp(-dt*4));
  P.hover=-1;
  const chaps=$$('.chap');let active=0,best=-1;
  chaps.forEach((el,i)=>{
    const [a,b]=CH[i];
    const op=sstep(a,a+.03,p)*(i===chaps.length-1?1:1-sstep(b-.03,b,p));
    const ty=(1-sstep(a,a+.03,p))*16-(i<chaps.length-1?sstep(b-.03,b,p)*16:0);
    const st=chapState[i]||(chapState[i]={});
    if(Math.abs((st.op??-1)-op)>.004){st.op=op;el.style.opacity=op.toFixed(3);el.style.transform='translate3d(0,'+ty.toFixed(1)+'px,0)';el.style.visibility=op<.01?'hidden':'visible'}
    if(op>best){best=op;active=i}
  });
  $$('#rail button').forEach((b,i)=>b.classList.toggle('on',i===active));
  $('#scrollHint').style.opacity=(1-sstep(.02,.06,p)).toFixed(2);
  if(active===1){
    const n=sorted.length;let lo=0,hi=n;while(lo<hi){const mid=(lo+hi)>>1;if(W.files[sorted[mid]].birth<=P.t)lo=mid+1;else hi=mid}
    setText($('#stFiles'),fmt(lo));setText($('#stCommits'),fmt(lo<=1?1:W.commits*Math.pow(P.t,1.15)));setText($('#stPeople'),fmt(Math.max(1,Math.round(W.people*Math.pow(P.t,.7)))));
  }
  updateCallout(active,best);
  setScrub(P.t);drawSpark();
  const k=sampleKeys(p);
  return k;
}
function updateCallout(active,op){
  const el=$('#callout'),a=W.anchors[active];
  if(!a||op<.05){el.style.opacity=0;return}
  const s=project(a.pos[0],a.pos[1],a.pos[2]);
  if(!s||s.x<20||s.x>SW-20||s.y<60||s.y>SH-40){el.style.opacity=0;return}
  el.classList.toggle('hot',!!a.hot);
  const bw=SW<760?180:220, right=s.x+70+bw<SW-12, dy=-84;
  const bodyEl=el.querySelector('.body');
  setText(el.querySelector('.name'),a.name);setText(el.querySelector('.meta'),a.meta);
  bodyEl.style.transform='translate('+(right?70:-70-bw)+'px,'+dy+'px)';
  const lx=right?70:-70, len=Math.hypot(lx,dy), ang=Math.atan2(dy,lx);
  const line=el.querySelector('.line');line.style.width=len.toFixed(0)+'px';line.style.transform='rotate('+ang+'rad)';
  el.style.transform='translate3d('+s.x.toFixed(1)+'px,'+s.y.toFixed(1)+'px,0)';
  el.style.opacity=Math.min(1,op*1.4).toFixed(2);
}
function scrollToChapter(i){
  const [a,b]=CH[i],p=i===CH.length-1?.985:(a+b)/2+.02;
  const max=document.documentElement.scrollHeight-innerHeight;
  scrollTo({top:p*max,behavior:REDUCED?'auto':'smooth'});
}

/* ---------- explore ---------- */
let activeTab='hot';
function fillStatic(){
  setText($('#kFiles'),fmt(W.files.length));setText($('#kCommits'),fmt(W.commits));setText($('#kPeople'),String(W.people));setText($('#kAge'),String(W.years));
}
function relYears(f){return((1-f.lt)*W.years)}
function renderList(tab){
  activeTab=tab;
  $$('.tabs button').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('on',on);b.setAttribute('aria-selected',on)});
  const ul=$('#rows');ul.textContent='';
  const add=(name,val,cls,desc,meter,onClick)=>{
    const li=document.createElement('li'),b=document.createElement('button');b.type='button';
    const n=document.createElement('span');n.className='n';n.textContent=name;
    const v=document.createElement('span');v.className='v '+cls;v.textContent=val;
    const d=document.createElement('span');d.className='d';d.textContent=desc;
    b.append(n,v,d);
    if(meter!=null){const m=document.createElement('div');m.className='meter';const i=document.createElement('i');i.className=cls;i.style.width=(clamp(meter,0.04,1)*100)+'%';m.appendChild(i);b.appendChild(m)}
    b.addEventListener('click',onClick);li.appendChild(b);ul.appendChild(li);
  };
  if(tab==='hot'){
    const mx=W.files[W.hot[0]].changes;
    W.hot.slice(0,8).forEach(i=>{const f=W.files[i];add(f.name,f.changes+' ch','bad',f.authors+(f.authors>1?' authors':' author')+' · edited nearly every week',f.changes/mx,()=>flyToFile(i))});
  }else if(tab==='bus'){
    W.dists.map((d,i)=>({d,b:BUS[i]})).sort((a,b)=>a.b-b.b).slice(0,8).forEach(({d,b})=>{
      const pct=Math.round(58+((hashStr(d.n+W.repo)%22)));
      add(d.n+'/',b+(b===1?' person':' people'),b<=2?'bad':b<=3?'warn':'ok',pct+'% of surviving lines by '+b,1-(b/10),()=>flyToDist(d));
    });
  }else{
    const q=W.files.map((f,i)=>i).filter(i=>W.files[i].h>2.2&&W.files[i].lt<.5).sort((a,b)=>W.files[a].lt-W.files[b].lt).slice(0,8);
    q.forEach(i=>{const f=W.files[i],y=relYears(f);add(f.name,y.toFixed(1)+'y','warn','untouched for '+y.toFixed(1)+' years · '+f.authors+(f.authors>1?' authors':' author')+' ever',clamp(y/W.years,0,1),()=>flyToFile(i))});
  }
  const df={hot:-1,bus:0,quiet:W.dists.findIndex(d=>d.dead)}[tab];
  if(mode==='explore'&&selected<0){P.focus=df;focusGoal=df<0?0:.75}
}
let focusGoal=0;
function refreshPlaceholder(){
  if(selected>=0)return;
  setText($('#placeEy'),'Exploring');setText($('#placeName'),'the whole city');
  setText($('#placeSub'),fmt(W.files.length)+' files · '+W.people+' people · '+W.years+' years');
}
function enterExplore(){if(mode!=='explore'){G.yaw=.6;G.pitch=.5;G.dist=96;G.x=0;G.y=4;G.z=0;E.yaw=G.yaw;E.pitch=G.pitch;E.dist=G.dist;E.x=0;E.y=4;E.z=0;setMode('explore',1.6)}}
function flyToFile(i){
  enterExplore();const f=W.files[i];
  tT=Math.max(tT,f.birth+.02);
  G.x=f.x;G.y=.28+f.h*.5;G.z=f.z;G.dist=14+f.h*1.4;G.pitch=.42;
  select(i);lastInteract=time;
}
function flyToDist(d){
  enterExplore();deselect(true);
  G.x=d.x;G.y=3;G.z=d.z;G.dist=d.r*2.5+12;G.pitch=.5;
  P.focus=d.i;focusGoal=.8;
  setText($('#placeEy'),'District');setText($('#placeName'),d.n+'/');
  setText($('#placeSub'),d.count+' files · bus factor '+BUS[d.i]+(d.dead?' · dormant':''));
  lastInteract=time;
}
function select(i){
  selected=i;const f=W.files[i];
  setText($('#placeEy'),f.hot?'Hotspot':f.dead?'Dormant file':'File');setText($('#placeName'),f.name);
  setText($('#placeSub'),f.changes+' changes · '+f.authors+(f.authors>1?' authors':' author')+' · '+fmt(f.loc)+' lines');
  P.focus=f.dist;focusGoal=.7;
}
function deselect(keepFocus){
  selected=-1;if(!keepFocus){focusGoal=0;refreshPlaceholder()}
}
function pick(x,y){
  const px=SH/(2*C.tanH), tt=P.t;let best=-1,bs=1e9;
  const F=W.files,m=C.vp;
  for(let i=0;i<F.length;i++){
    const f=F[i];if(f.birth>tt)continue;
    const yy=.28+f.h*.5,w=m[3]*f.x+m[7]*yy+m[11]*f.z+m[15];if(w<=.5)continue;
    const sx=((m[0]*f.x+m[4]*yy+m[8]*f.z+m[12])/w*.5+.5)*SW, sy=(1-((m[1]*f.x+m[5]*yy+m[9]*f.z+m[13])/w*.5+.5))*SH;
    const th=clamp(px*Math.max(f.w*.8,f.h*.5)/w,11,80), d=Math.hypot(sx-x,sy-y);
    if(d<th){const s=d/th+w*.004;if(s<bs){bs=s;best=i}}
  }
  return best;
}
const tip=$('#tip');
function tipShow(i,x,y){
  const f=W.files[i],t=Math.min(P.t,1);
  tip.textContent='';
  const pill=document.createElement('span'),dark=P.t>f.lt+.05;
  pill.className='pill '+(f.hot?'hot':dark?'quiet':'ok');pill.textContent=f.hot?'hotspot':dark?'quiet':'active';
  const n=document.createElement('div');n.className='n';n.textContent=f.name;tip.append(pill,n);
  const row=(k,v)=>{const r=document.createElement('div');r.className='row';const a=document.createElement('span');a.textContent=k;const b=document.createElement('b');b.textContent=v;r.append(a,b);tip.appendChild(r)};
  row('Created',dateStr(W,f.birth));row(dark?'Last change':'Last change',dateStr(W,Math.min(f.lt,t)));row('Changes',String(f.changes));row('Authors',String(f.authors));row('Lines',fmt(f.loc));
  const w=236,h=tip.offsetHeight||150;
  tip.style.transform='translate3d('+clamp(x+16,8,SW-w-8)+'px,'+clamp(y+16,8,SH-h-8)+'px,0)';tip.style.opacity=1;
}
function tipHide(){tip.style.opacity=0}

/* ---------- scrubber ---------- */
const track=$('#track');let sparkBuckets=null,sparkLast=-1;const NB=96;
function buildSpark(){
  const b=new Float32Array(NB),Rn=rng(W.seed^77);
  W.files.forEach(f=>{const a=Math.floor(f.birth*(NB-1)),e=Math.floor(f.lt*(NB-1));b[a]+=2.5;for(let i=a;i<=e;i++)b[i]+=f.act*.6*(.5+Rn())});
  sparkBuckets=b;
}
function drawSpark(force){
  if(!W)return;if(!sparkBuckets||force===true&&!sparkBuckets)buildSpark();
  const c=$('#spark'),r=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(r.width*d)),h=Math.max(1,Math.round(r.height*d));
  if(!r.width)return;
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;force=true}
  const cur=Math.floor(P.t*NB);if(!force&&cur===sparkLast)return;sparkLast=cur;
  if(!sparkBuckets||sparkBuckets.__repo!==W.repo){buildSpark();sparkBuckets.__repo=W.repo}
  const g=c.getContext('2d'),mx=Math.max(...sparkBuckets);g.clearRect(0,0,w,h);
  const bw=w/NB;
  for(let i=0;i<NB;i++){
    const hh=Math.max(1.5*d,(sparkBuckets[i]/mx)*h*.86);
    g.fillStyle=i<cur?'rgba(255,180,94,.78)':'rgba(236,230,219,.2)';
    g.fillRect(i*bw+bw*.18,h-hh-3*d,bw*.64,hh);
  }
}
function setScrub(t){
  $('#fill').style.width=(t*100).toFixed(2)+'%';$('#knob').style.left='calc('+(t*100).toFixed(2)+'% - 1px)';
  track.setAttribute('aria-valuenow',String(Math.round(t*100)));
  setText($('#dateMain'),dateStr(W,t));
  let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(W.files[sorted[mid]].birth<=t)lo=mid+1;else hi=mid}
  const cm=lo<=1?1:Math.round(W.commits*Math.pow(t,1.15));setText($('#dateSub'),fmt(cm)+(cm===1?' commit':' commits')+' · '+fmt(lo)+(lo===1?' file':' files'));
}
function stopPlay(){playing=false;$('#playIcon').setAttribute('d','M2 1l9 5-9 5z');$('#play').setAttribute('aria-label','Play history')}
function startPlay(){if(tT>=.999)tT=0;P.t=Math.min(P.t,tT);playing=true;$('#playIcon').setAttribute('d','M2 1h3v10H2zM7 1h3v10H7z');$('#play').setAttribute('aria-label','Pause history')}
function scrubTo(ev){const r=track.getBoundingClientRect();tT=clamp((ev.clientX-r.left)/r.width,0,1);P.t=tT;lastInteract=time}

/* ---------- input ---------- */
const ptrs=new Map();let dragMoved=0,pinch0=0,panMode=false;
function bindCanvas(){
  canvas.addEventListener('pointerdown',e=>{
    if(mode!=='explore')return;
    canvas.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});dragMoved=0;panMode=e.button===2||e.shiftKey;
    if(ptrs.size===2){const [a,b]=[...ptrs.values()];pinch0=Math.hypot(a.x-b.x,a.y-b.y)}
    canvas.classList.add('drag');lastInteract=time;
  });
  canvas.addEventListener('pointermove',e=>{
    mouse.x=e.clientX/SW*2-1;mouse.y=e.clientY/SH*2-1;mouse.over=true;
    if(mode==='explore'&&ptrs.has(e.pointerId)){
      const p=ptrs.get(e.pointerId),dx=e.clientX-p.x,dy=e.clientY-p.y;dragMoved+=Math.abs(dx)+Math.abs(dy);
      p.x=e.clientX;p.y=e.clientY;lastInteract=time;
      if(ptrs.size===1){
        if(panMode){const s=G.dist*.0016;G.x-=(Math.cos(G.yaw)*dx)*s;G.z+=(Math.sin(G.yaw)*dx)*s;G.x-=Math.sin(G.yaw)*dy*s;G.z-=Math.cos(G.yaw)*dy*s}
        else{G.yaw-=dx*.0052;G.pitch=clamp(G.pitch+dy*.004,.05,1.45)}
      }else if(ptrs.size===2){const [a,b]=[...ptrs.values()],d=Math.hypot(a.x-b.x,a.y-b.y);if(pinch0)G.dist=clamp(G.dist*pinch0/d,7,230);pinch0=d}
      tipHide();hoverIdx=-1;
    }else if(mode==='explore'&&e.pointerType!=='touch'){hoverAt(e.clientX,e.clientY)}
  });
  const up=e=>{
    if(mode==='explore'&&ptrs.has(e.pointerId)){
      const wasClick=dragMoved<6&&ptrs.size===1;ptrs.delete(e.pointerId);
      if(ptrs.size<2)pinch0=0;
      if(!ptrs.size)canvas.classList.remove('drag');
      if(wasClick){const i=pick(e.clientX,e.clientY);if(i>=0){flyToFile(i);tipHide()}else{deselect();P.focus=-1;focusGoal=0}}
    }
  };
  canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);
  canvas.addEventListener('pointerleave',()=>{mouse.over=false;hoverIdx=-1;tipHide()});
  canvas.addEventListener('contextmenu',e=>{if(mode==='explore')e.preventDefault()});
  canvas.addEventListener('wheel',e=>{
    if(mode!=='explore')return;e.preventDefault();
    G.dist=clamp(G.dist*Math.exp(e.deltaY*.0011),7,230);lastInteract=time;
  },{passive:false});
}
let hoverPending=null;
function hoverAt(x,y){hoverPending=[x,y]}
function processHover(){
  if(!hoverPending)return;const [x,y]=hoverPending;hoverPending=null;
  const i=pick(x,y);hoverIdx=i;
  if(i>=0){tipShow(i,x,y);canvas.style.cursor='pointer'}else{tipHide();canvas.style.cursor=''}
}

/* command palette */
const cmdk=$('#cmdk'),cmdIn=$('#cmdInput'),cmdList=$('#cmdList');let cmdSel=0,cmdItems=[],cmdReturn=null;
function actions(){return[
  {k:'Action',t:'Open the city (explore)',run:enterExplore},
  {k:'Action',t:'Replay history',run:()=>{enterExplore();tT=0;P.t=0;startPlay();speed=4;$$('.speeds button').forEach(b=>b.classList.toggle('on',b.dataset.s==='4'))}},
  {k:'Action',t:'Back to the story',run:()=>{if(mode==='explore')setMode('story')}},
  {k:'Action',t:'Photo mode',run:enterPhoto},
  {k:'Action',t:'Cycle graphics quality',run:cycleQuality},
];}
function cmdBuild(q){
  q=q.trim().toLowerCase();const out=[];
  if(!q){actions().forEach(a=>out.push(a));W.hot.slice(0,4).forEach(i=>out.push({k:'Hotspot',t:W.files[i].name,run:()=>flyToFile(i)}));return out}
  const toks=q.split(/\s+/);
  actions().forEach(a=>{if(toks.every(t=>a.t.toLowerCase().includes(t)))out.push(a)});
  W.dists.forEach(d=>{if(toks.every(t=>(d.n+'/').includes(t)))out.push({k:'District',t:d.n+'/',run:()=>flyToDist(d)})});
  for(let i=0;i<names.length&&out.length<10;i++)if(toks.every(t=>names[i].includes(t)))out.push({k:W.files[i].hot?'Hotspot':W.files[i].dead?'Dormant':'File',t:W.files[i].name,run:()=>flyToFile(i)});
  return out.slice(0,10);
}
function cmdRender(){
  cmdList.textContent='';
  cmdItems.forEach((it,i)=>{
    const li=document.createElement('li'),b=document.createElement('button');b.type='button';if(i===cmdSel)b.classList.add('sel');
    const a=document.createElement('span');a.textContent=it.t;const k=document.createElement('span');k.className='k';k.textContent=it.k;b.append(a,k);
    b.addEventListener('click',()=>cmdRun(i));b.addEventListener('mousemove',()=>{if(cmdSel!==i){cmdSel=i;cmdRender()}});
    li.appendChild(b);cmdList.appendChild(li);
  });
  if(!cmdItems.length){const li=document.createElement('li');li.style.cssText='padding:12px;color:var(--faint);font-family:var(--mono);font-size:12px';li.textContent='No matches';cmdList.appendChild(li)}
}
function cmdOpen(){
  if(mode!=='story'&&mode!=='explore')return;
  cmdReturn=document.activeElement;cmdk.hidden=false;cmdIn.value='';cmdSel=0;cmdItems=cmdBuild('');cmdRender();cmdIn.focus();
}
function cmdClose(){cmdk.hidden=true;if(cmdReturn&&cmdReturn.focus)cmdReturn.focus()}
function cmdRun(i){const it=cmdItems[i];if(!it)return;cmdk.hidden=true;it.run()}
cmdIn.addEventListener('input',()=>{cmdSel=0;cmdItems=cmdBuild(cmdIn.value);cmdRender()});
cmdIn.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();cmdSel=Math.min(cmdItems.length-1,cmdSel+1);cmdRender()}
  else if(e.key==='ArrowUp'){e.preventDefault();cmdSel=Math.max(0,cmdSel-1);cmdRender()}
  else if(e.key==='Enter'){e.preventDefault();cmdRun(cmdSel)}
});
cmdk.addEventListener('pointerdown',e=>{if(e.target===cmdk)cmdClose()});

/* photo + quality */
function enterPhoto(){if(mode!=='explore')enterExplore();body.classList.add('photo');lastInteract=-10}
function exitPhoto(){body.classList.remove('photo')}
function cycleQuality(){setTier((tierIdx+2)%3,true)}

/* fps + auto-tier */
let fpsAcc=0,fpsN=0,grace=90,fpsShow=0,fpsClock=0,frames=0;
function fpsTick(dt){
  frames++;fpsClock+=dt;
  if(fpsClock>=.5){setText($('#fps'),Math.round(frames/fpsClock)+' fps');frames=0;fpsClock=0}
  if(grace>0){grace--;return}
  if(dt>.25)return;
  fpsAcc+=dt;fpsN++;
  if(fpsN>=70){
    const fps=fpsN/fpsAcc;fpsAcc=0;fpsN=0;
    if(tierAuto&&fps<38&&tierIdx>0){setTier(tierIdx-1,false);}
  }
}

/* ---------- main loop ---------- */
let last=performance.now();const hdg=$('#heading'),strip=$('#strip');
function frame(now){
  requestAnimationFrame(frame);
  const raw=(now-last)/1000,dt=Math.min(.05,raw);last=now;time+=dt;
  P.fade=sstep(0,1.4,time);
  let want;
  if(mode==='hero'){want=heroPose();P.t=1;P.hot=.5;P.fog=FOG*1.15;P.focusAmt=0;P.hover=-1}
  else if(mode==='loading'){updateLoading(dt);want=mode==='loading'?sampleKeys(0):updateStory(dt)}
  else if(mode==='story'){want=updateStory(dt)}
  else{
    want=exploreCam(dt);
    P.fog=FOG;
    const tk=REDUCED?1:1-Math.exp(-dt*7);
    if(playing){tT+=dt*speed/40;if(tT>=1){tT=1;stopPlay()}}
    P.t+=(tT-P.t)*tk;if(Math.abs(tT-P.t)<.0004)P.t=tT;
    P.hot=1;P.focusAmt+=(focusGoal-P.focusAmt)*(1-Math.exp(-dt*5));
    P.hover=hoverIdx>=0?hoverIdx:selected;
    processHover();
    const photo=body.classList.contains('photo');
    if(!REDUCED&&(photo||time-lastInteract>7)&&!ptrs.size){G.yaw+=dt*(photo?.05:.018)}
    setScrub(P.t);drawSpark();
  }
  // camera transition
  let pos=want.pos,tgt=want.tgt;
  if(xt<1&&xfrom){xt=Math.min(1,xt+dt/xdur);const e=REDUCED?1:ease(xt);pos=v3.lerp(xfrom.pos,pos,e);tgt=v3.lerp(xfrom.tgt,tgt,e)}
  if(mode==='story'&&!REDUCED){
    pos=[pos[0]+Math.sin(time*.13)*.5+C.right[0]*mouse.x*1.1,pos[1]+Math.sin(time*.17)*.3-mouse.y*.5,pos[2]+Math.cos(time*.11)*.5+C.right[2]*mouse.x*1.1];
  }
  lastPos=pos;lastTgt=tgt;
  applyCamera(pos,tgt);
  {const deg=(Math.atan2(C.fwd[0],-C.fwd[2])*180/Math.PI+360)%360;setText(hdg,String(Math.round(deg)%360).padStart(3,'0')+'\u00b0');strip.style.backgroundPositionX=(-deg*2.4).toFixed(1)+'px'}
  // lanterns
  for(let i=0;i<LN;i++){
    const pe=W.people_[i],o=i*3;
    if(P.t<pe.join){lanterns[o]=0;lanterns[o+1]=-60;lanterns[o+2]=0;continue}
    const s=(time*.06*pe.speed+pe.off),k=Math.floor(s),u=ease(s-k),a=pe.wp[k%6],b=pe.wp[(k+1)%6];
    lanterns[o]=lerp(a[0],b[0],u);lanterns[o+1]=lerp(a[1],b[1],u)+Math.sin(time*1.3+i)*.4+Math.sin(u*Math.PI)*3.5;lanterns[o+2]=lerp(a[2],b[2],u);
  }
  if(R&&!document.hidden){R.render(C,P,time,lanterns)}
  fpsTick(raw);
}

/* ---------- UI wiring ---------- */
function normRepo(v){
  v=v.trim().replace(/^https?:\/\//i,'').replace(/^www\./i,'').replace(/^github\.com\//i,'').replace(/\.git$/i,'').replace(/\/+$/,'');
  return v;
}
$('#form').addEventListener('submit',e=>{
  e.preventDefault();
  const v=normRepo($('#repoInput').value);
  if(!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(v)||/^\.\.?$/.test(v.split('/')[1])){setText($('#formErr'),'Use the form owner/name, for example acme/orbit-api.');return}
  setText($('#formErr'),'');startLoading(v);
});
$$('.samples button').forEach(b=>b.addEventListener('click',()=>{$('#repoInput').value=b.dataset.repo;$('#form').requestSubmit()}));
$('#skip').addEventListener('click',()=>{const v=normRepo($('#repoInput').value);initWorld(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(v)?v:'acme/orbit-api');enterExplore()});
$('#ctaExplore').addEventListener('click',enterExplore);
$('#btnExplore').addEventListener('click',()=>{if(mode==='explore')setMode('story');else enterExplore()});
$('#btnPhoto').addEventListener('click',enterPhoto);
$('#btnSearch').addEventListener('click',cmdOpen);
$('#btnQual').addEventListener('click',cycleQuality);
$$('#rail button').forEach(b=>b.addEventListener('click',()=>scrollToChapter(+b.dataset.i)));
$$('.tabs button').forEach(b=>b.addEventListener('click',()=>{deselect(true);renderList(b.dataset.tab)}));
$('#play').addEventListener('click',()=>{playing?stopPlay():startPlay()});
$$('.speeds button').forEach(b=>b.addEventListener('click',()=>{speed=+b.dataset.s;$$('.speeds button').forEach(x=>x.classList.toggle('on',x===b))}));
track.addEventListener('pointerdown',e=>{if(mode!=='explore')return;track.setPointerCapture(e.pointerId);stopPlay();scrubTo(e);track._d=true});
track.addEventListener('pointermove',e=>{if(track._d)scrubTo(e)});
track.addEventListener('pointerup',()=>{track._d=false});
track.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){tT=clamp(tT-.02,0,1);e.preventDefault()}else if(e.key==='ArrowRight'){tT=clamp(tT+.02,0,1);e.preventDefault()}});
addEventListener('resize',()=>resize(false));
addEventListener('mousemove',e=>{if(mode==='story'){mouse.x=e.clientX/innerWidth*2-1;mouse.y=e.clientY/innerHeight*2-1}},{passive:true});
addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA)$/.test(document.activeElement&&document.activeElement.tagName);
  if((e.key==='k'||e.key==='K')&&(e.metaKey||e.ctrlKey)){e.preventDefault();cmdk.hidden?cmdOpen():cmdClose();return}
  if(e.key==='/'&&!typing){e.preventDefault();cmdOpen();return}
  if(e.key==='Escape'){
    if(!cmdk.hidden){cmdClose();return}
    if(body.classList.contains('photo')){exitPhoto();return}
    if(mode==='explore'&&selected>=0){deselect();P.focus=-1;return}
    return;
  }
  if(mode==='explore'&&!typing&&cmdk.hidden){
    const s=e.shiftKey?2:1;let hit=true;
    if(e.key==='ArrowLeft'||e.key==='a')G.yaw+=.09*s;else if(e.key==='ArrowRight'||e.key==='d')G.yaw-=.09*s;
    else if(e.key==='ArrowUp'||e.key==='w')G.pitch=clamp(G.pitch+.06*s,.05,1.45);else if(e.key==='ArrowDown'||e.key==='s')G.pitch=clamp(G.pitch-.06*s,.05,1.45);
    else if(e.key==='+'||e.key==='=')G.dist=clamp(G.dist*.88,7,230);else if(e.key==='-')G.dist=clamp(G.dist*1.14,7,230);
    else if(e.key===' '&&document.activeElement===document.body){playing?stopPlay():startPlay()}
    else hit=false;
    if(hit){e.preventDefault();lastInteract=time}
  }
});
document.addEventListener('visibilitychange',()=>{last=performance.now()});

/* ---------- boot ---------- */
initWorld('acme/orbit-api');
setMode('hero');
setTier(tierIdx,false);
requestAnimationFrame(t=>{last=t;requestAnimationFrame(frame)});

window.afterglow={
  get mode(){return mode},get W(){return W},P,C,
  go:m=>{if(m==='explore')enterExplore();else if(m==='story'){setMode('story')}else if(m==='hero')setMode('hero')},
  start:r=>startLoading(r||'acme/orbit-api'),
  setT:t=>{tT=t;P.t=t},setP:p=>{const max=document.documentElement.scrollHeight-innerHeight;scrollTo(0,p*max);pS=p},
  setTier:i=>setTier(i,true),flyToFile,flyToDist,pick,project,
  stats:()=>({mode,tier:R&&R.tiers[tierIdx].name,fps:$('#fps').textContent,hdr:R&&R.hdr,msaa:R&&R.msaa,t:P.t,p:pS,files:W.files.length,canvas:canvas.width+'x'+canvas.height,error:!R}),
};
})();
