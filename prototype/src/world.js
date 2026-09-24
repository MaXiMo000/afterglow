/* ===== world generation (seeded, deterministic) ===== */
const CELL=1.6;
const SPEC=[
  {n:'core',      files:210,b0:.00,b1:.30,act:.62,pal:0},
  {n:'routing',   files:170,b0:.02,b1:.45,act:.92,pal:0},
  {n:'security',  files:105,b0:.10,b1:.55,act:.50,pal:1},
  {n:'middleware',files:90, b0:.14,b1:.65,act:.58,pal:1},
  {n:'models',    files:135,b0:.05,b1:.60,act:.66,pal:0},
  {n:'tests',     files:380,b0:.10,b1:1.0,act:.72,pal:2},
  {n:'docs',      files:230,b0:.22,b1:.95,act:.24,pal:3},
  {n:'legacy',    files:140,b0:.00,b1:.20,act:.03,pal:4,dead:true},
  {n:'infra',     files:80, b0:.30,b1:.90,act:.40,pal:2},
  {n:'scripts',   files:60, b0:.20,b1:.85,act:.30,pal:3},
];
const BUS=[3,2,2,3,4,7,9,1,2,1];
const WORDS={
  core:['applications','params','encoders','types','utils','datastructures','concurrency','exceptions','background','requests','responses','staticfiles','templating','websockets','status','logger','config','settings','lifespan','events','signals'],
  routing:['router','dependencies','params_solver','path_ops','endpoints','schema_gen','matching','response_model','serializer','validators','callbacks','mounts','includes','tags','versioning'],
  security:['oauth2','api_key','http_basic','http_bearer','open_id','scopes','utils','csrf','tokens','hashing','permissions','sessions'],
  middleware:['cors','gzip','https_redirect','trusted_host','wsgi','timing','ratelimit','logging','tracing','errors'],
  models:['schema','fields','base','mixins','relations','validators','serialization','registry','migrations','query','session','engine','types'],
  tests:['routing','params','security','schema','websockets','middleware','background','deps','models','regression','smoke','contract','fixtures','edge_cases'],
  docs:['index','tutorial','advanced','deployment','faq','history','contributing','release_notes','features','alternatives','benchmarks','help','install','concepts'],
  legacy:['compat_v1','old_router','py2_shims','deprecated_utils','xml_render','legacy_auth','sync_bridge','monkeypatch','vendored_lib','migrate_2016'],
  infra:['Dockerfile','compose','ci_build','deploy','terraform_main','k8s_service','release','lint_config'],
  scripts:['build_docs','publish','bump_version','translate','generate_client','coverage','format','lint'],
};
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function hashStr(s){let h=1779033703^s.length;for(let i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),3432918353);h=(h<<13)|(h>>>19)}h=Math.imul(h^(h>>>16),2246822507);h=Math.imul(h^(h>>>13),3266489909);return(h^(h>>>16))>>>0}
function rng(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function buildWorld(repo){
  const seed=hashStr(repo.toLowerCase()), R=rng(seed);
  const years=8+(seed>>>3)%3, start=Date.UTC(2013+seed%5,(seed>>>5)%12,14);
  const W={repo,seed,years,start,commits:4200+seed%5200,people:22+(seed>>>7)%40,files:[],dists:[],curves:[],hot:[],people_:[]};
  const D=SPEC.map((s,i)=>({...s,i,r:Math.sqrt(s.files*CELL*CELL/0.7/Math.PI)+1.2,x:0,z:0}));
  D.forEach((d,i)=>{ if(!i)return; const a=((i-1)/(D.length-1))*Math.PI*2+(R()-.5)*.5, rad=42+R()*14; d.x=Math.cos(a)*rad; d.z=Math.sin(a)*rad; });
  for(let it=0;it<320;it++){
    for(let i=0;i<D.length;i++)for(let j=i+1;j<D.length;j++){
      const a=D[i],b=D[j]; let dx=b.x-a.x,dz=b.z-a.z; const dist=Math.hypot(dx,dz)||.01, min=a.r+b.r+4;
      if(dist<min){ const push=(min-dist)/2; dx/=dist; dz/=dist; if(!i){b.x+=dx*push*2;b.z+=dz*push*2}else{a.x-=dx*push;a.z-=dz*push;b.x+=dx*push;b.z+=dz*push} }
    }
    for(let i=1;i<D.length;i++){D[i].x*=.996;D[i].z*=.996}
  }
  D.forEach(d=>{d.x=Math.round(d.x/CELL)*CELL;d.z=Math.round(d.z/CELL)*CELL});
  const used=new Map(), files=W.files;
  D.forEach(d=>{
    const rr=d.r-1.4, cand=[];
    for(let gx=Math.floor((d.x-rr)/CELL);gx<=Math.ceil((d.x+rr)/CELL);gx++)for(let gz=Math.floor((d.z-rr)/CELL);gz<=Math.ceil((d.z+rr)/CELL);gz++){
      const x=(gx+.5)*CELL,z=(gz+.5)*CELL,dd=Math.hypot(x-d.x,z-d.z); if(dd<=rr)cand.push({x,z,dd,k:R()});
    }
    cand.sort((a,b)=>a.k-b.k);
    const take=cand.slice(0,Math.min(cand.length,d.files)); d.count=take.length; d.maxLt=0; d.first=files.length;
    const words=WORDS[d.n];
    take.forEach(c=>{
      const rel=c.dd/rr, size=Math.exp(R()*1.5+.15);
      let h=(0.9+size*1.15)*(1.15-.6*Math.pow(rel,1.4));
      if(d.n==='tests')h*=.72; if(d.n==='docs')h*=.55; if(d.n==='legacy')h*=.8;
      h=clamp(h,.7,15);
      const birth=d.b0+(d.b1-d.b0)*Math.pow(R(),1.4)*(.55+.45*rel);
      let lt,act;
      if(d.dead){lt=Math.max(birth+.01,.10+R()*.16);act=.05}
      else{const alive=R()<d.act; lt=alive?.9+R()*.1:birth+(1-birth)*R()*.85; act=clamp(d.act*(.45+R()*.9),.05,.98); if(!alive)act*=.6; lt=Math.max(lt,birth+.01)}
      const changes=Math.round(8+420*Math.pow(R(),3.2)*(.3+d.act)*(size/3));
      const w=.72+R()*.56, dp=.72+R()*.56;
      let word=words[Math.floor(R()*words.length)], key=d.n+word, k=used.get(key)||0; used.set(key,k+1);
      const ext=d.n==='docs'?'.md':d.n==='infra'?(word==='Dockerfile'?'':'.yml'):d.n==='scripts'?(R()<.6?'.sh':'.py'):'.py';
      const base=(d.n==='tests'?'test_':'')+word+(k?'_'+(k+1):'')+ext;
      const f={x:c.x,z:c.z,w,d:dp,h,birth,lt,act,hot:0,dead:d.dead?1:0,dist:d.i,changes,authors:d.dead?1:1+Math.floor(R()*5),loc:Math.round(h*70+R()*130),seed:R(),name:d.n+'/'+base};
      d.maxLt=Math.max(d.maxLt,lt); files.push(f);
    });
    d.last=files.length;
  });
  // everything except the very first file appears after the opening shot
  files.forEach((f,i)=>{if(i!==D[0].first){f.birth=.045+f.birth*.955;f.lt=Math.max(f.lt,f.birth+.01)}});
  D.forEach(d=>{if(d.i>0)d.b0=.045+d.b0*.955});
  // hotspots: highest change counts among living files
  const order=files.map((f,i)=>i).filter(i=>!files[i].dead).sort((a,b)=>files[b].changes-files[a].changes);
  order.slice(0,16).forEach(i=>{const f=files[i];f.hot=1;f.act=Math.max(f.act,.88);f.lt=Math.max(f.lt,.96);f.changes=Math.max(f.changes,240+Math.round(R()*160));f.authors=1+Math.floor(R()*2);f.h*=1.18});
  W.hot=order.slice(0,16).sort((a,b)=>files[b].changes-files[a].changes);
  W.dists=D;
  const idx=n=>D.findIndex(d=>d.n===n);
  [['core','routing',.9],['routing','models',.8],['routing','tests',.95],['security','middleware',.7],['core','tests',.85],['models','tests',.7],['docs','core',.3],['infra','scripts',.5],['security','routing',.6],['middleware','routing',.65]].forEach(([a,b,s])=>{
    const A=D[idx(a)],B=D[idx(b)], dx=B.x-A.x,dz=B.z-A.z, L=Math.hypot(dx,dz);
    const sx=A.x+dx/L*A.r*.9, sz=A.z+dz/L*A.r*.9, ex=B.x-dx/L*B.r*.9, ez=B.z-dz/L*B.r*.9;
    const mx=(sx+ex)/2,mz=(sz+ez)/2,my=5+L*.08;
    const pts=[]; for(let i=0;i<=56;i++){const u=i/56,a1=(1-u)*(1-u),b1=2*(1-u)*u,c1=u*u; pts.push(a1*sx+b1*mx+c1*ex,.7+b1*my*.5,a1*sz+b1*mz+c1*ez,u)}
    W.curves.push({pts:new Float32Array(pts),n:57,s,birth:Math.max(A.b0,B.b0)+.06});
  });
  // contributors (lanterns): each roams between files of two districts
  for(let i=0;i<14;i++){
    const home=[D[i%3===0?0:(i*3)%D.length],D[(i*5+1)%D.length]]; const wp=[];
    for(let k=0;k<6;k++){const dd=home[k%2],fi=dd.first+Math.floor(R()*(dd.last-dd.first)),f=files[fi];wp.push([f.x,.28+f.h+1.4,f.z])}
    W.people_.push({wp,join:i<4?.02+R()*.1:R()*.8,speed:.5+R()*.6,off:R()*10});
  }
  {const f0=files[D[0].first];f0.birth=0;f0.lt=1;f0.dead=0;f0.name='core/__init__.py';f0.h=Math.max(f0.h,3.2)}
  const bd=[...files].sort((a,b)=>a.birth-b.birth).map(f=>f.birth); W.births=bd;
  // story anchors
  const hf=files[W.hot[0]], leg=D[idx('legacy')], core=D[0], rt=D[idx('routing')];
  W.anchors=[
    {pos:[files[D[0].first].x,.28+files[D[0].first].h+.6,files[D[0].first].z],name:'core/'+'__init__.py',meta:'First commit · '+dateStr(W,0,true)+''},
    null,
    {pos:[hf.x,.28+hf.h+.6,hf.z],name:hf.name,meta:hf.changes+' changes in 12 months · '+hf.authors+(hf.authors>1?' authors':' author'),hot:1},
    {pos:[leg.x,4,leg.z],name:'legacy/',meta:leg.count+' files · last change '+((1-leg.maxLt)*years).toFixed(1)+' years ago'},
    {pos:[core.x,10,core.z],name:'core/',meta:'Bus factor '+BUS[0]+' · '+Math.round(64+R()*10)+'% of lines by '+BUS[0]+' people'},
    null,
  ];
  return W;
}
function dateAt(W,t){return new Date(W.start+t*W.years*365.25*864e5)}
function dateStr(W,t,long){const d=dateAt(W,t);return long?d.getUTCDate()+' '+MONTHS[d.getUTCMonth()].charAt(0)+MONTHS[d.getUTCMonth()].slice(1).toLowerCase()+' '+d.getUTCFullYear():MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear()}
