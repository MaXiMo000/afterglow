/* ===== WebGL2 renderer ===== */
const H='#version 300 es\nprecision highp float;\n';
const NOISE=`
float h21(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec2(17.,9.);a*=.5;}return s;}
`;
const SKY=`
uniform float uTime;uniform vec3 uSunDir;uniform vec3 uMoonDir;uniform float uCloud;
vec3 skyColor(vec3 d){
  float e=d.y;
  vec3 deep=vec3(.035,.045,.13),mid=vec3(.20,.14,.36),low=vec3(.80,.38,.52),hor=vec3(1.,.60,.48);
  vec3 c=mix(low,mid,smoothstep(.02,.30,e));
  c=mix(c,deep,smoothstep(.25,.85,e));
  float sun=pow(max(dot(normalize(vec3(d.x,0.,d.z)),normalize(vec3(uSunDir.x,0.,uSunDir.z))),0.),3.);
  c+=hor*sun*exp(-max(e,0.)*7.)*.75;
  c=mix(c,vec3(.075,.17,.19),smoothstep(.035,-.05,e));
  if(e>.16){vec3 q=floor(d*230.);float r=fract(sin(dot(q,vec3(12.9898,78.233,37.719)))*43758.5453);float st=step(.9968,r)*smoothstep(.16,.6,e);c+=vec3(.9,.9,1.)*st*(.5+.5*sin(uTime*2.+r*60.));}
  float md=dot(d,normalize(uMoonDir));
  c+=vec3(.85,.92,1.)*smoothstep(.99935,.99985,md)*2.4;
  c+=vec3(.45,.6,.9)*pow(max(md,0.),160.)*.4;
  if(uCloud>.5&&e>0.){
    vec2 uv=d.xz/(e+.22)*.55+vec2(uTime*.006,0.);
    float n=fbm(uv*2.2);
    float dens=smoothstep(.48,.80,n)*smoothstep(0.,.18,e)*(1.-smoothstep(.5,.9,e));
    vec3 cc=mix(vec3(.16,.12,.28),vec3(.95,.55,.55),sun*exp(-e*3.)*.9+.08);
    c=mix(c,cc,dens*.8);
  }
  return c;
}
`;
const FS_TRI=`out vec2 vUv;void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.-1.,1.,1.);}`;

const SRC={};
SRC.sky={vs:H+FS_TRI,fs:H+NOISE+SKY+`
in vec2 vUv;uniform vec3 uRight,uUp,uFwd;uniform float uTanH,uAspect,uMirror;out vec4 o;
void main(){vec2 n=vUv*2.-1.;vec3 d=normalize(uFwd+n.x*uAspect*uTanH*uRight+n.y*uTanH*uUp);d.y*=uMirror;o=vec4(skyColor(d),1.);}`};

SRC.water={vs:H+`layout(location=0) in vec2 aP;uniform mat4 uVP;out vec3 vW;void main(){vec3 w=vec3(aP.x,0.,aP.y);vW=w;gl_Position=uVP*vec4(w,1.);}`,
fs:H+NOISE+SKY+`
in vec3 vW;uniform vec3 uCam;uniform sampler2D uRefl;uniform vec2 uScr;uniform float uHasRefl,uFog;uniform vec3 uFogCol;out vec4 o;
float wave(vec2 p){return vnoise(p*.8+uTime*.05)*.6+vnoise(p*2.3-uTime*.08)*.3+vnoise(p*5.1+uTime*.13)*.1;}
void main(){
  vec3 tc=uCam-vW;float dist=length(tc);vec3 V=tc/dist;
  vec2 p=vW.xz;float e=.06,w0=wave(p);
  vec2 g=vec2(wave(p+vec2(e,0.))-w0,wave(p+vec2(0.,e))-w0)/e;
  float amp=1.1/(1.+dist*.045);
  vec3 N=normalize(vec3(-g.x*amp,1.,-g.y*amp));
  float fr=pow(1.-max(dot(N,V),0.),4.);
  float refl=mix(.34,.96,fr);
  vec3 deep=vec3(.010,.050,.058)+vec3(.02,.05,.05)*fr;
  vec3 rc;
  if(uHasRefl>.5){
    vec2 uv=gl_FragCoord.xy/uScr;
    uv+=N.xz*.07/(1.+dist*.01);
    vec2 px=1.4/uScr;
    rc=(texture(uRefl,uv).rgb*2.+texture(uRefl,uv+vec2(px.x,px.y)).rgb+texture(uRefl,uv-vec2(px.x,px.y)).rgb+texture(uRefl,uv+vec2(-px.x,px.y)).rgb+texture(uRefl,uv+vec2(px.x,-px.y)).rgb)/6.;
  } else rc=skyColor(reflect(-V,N));
  vec3 c=mix(deep,rc,refl);
  vec3 Lm=normalize(uMoonDir);vec3 R=reflect(-Lm,N);
  c+=vec3(.75,.88,1.)*pow(max(dot(R,V),0.),220.)*min(2.2,60./(dist+20.));
  float fg=1.-exp(-dist*uFog*.7);
  c=mix(c,uFogCol,fg*.9);
  o=vec4(c,1.);
}`};

const BUILDING_COMMON=`
uniform mat4 uVP;uniform float uT,uTime;
`;
SRC.bld={vs:H+`
layout(location=0) in vec3 aPos;layout(location=1) in vec3 aNor;
layout(location=2) in vec4 iA;layout(location=3) in vec4 iB;layout(location=4) in vec4 iC;
`+BUILDING_COMMON+`
out vec3 vW;out vec3 vN;out vec2 vXZ;out vec2 vSize;out vec4 vB;out vec4 vC;out float vG;out float vTop;flat out float vInst;
void main(){
  float g=clamp((uT-iB.y)/.03,0.,1.);
  float ge=1.-pow(1.-g,3.);ge*=1.+.06*sin(g*3.14159);
  if(g<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
  float h=iB.x*ge;
  vec3 w=vec3(iA.x+aPos.x*iA.z,.28+aPos.y*h,iA.y+aPos.z*iA.w);
  vW=w;vN=aNor;vXZ=aPos.xz+.5;vSize=iA.zw;vB=iB;vC=iC;vG=g;vTop=.28+h;vInst=float(gl_InstanceID);
  gl_Position=uVP*vec4(w,1.);
}`,
fs:H+NOISE+`
in vec3 vW;in vec3 vN;in vec2 vXZ;in vec2 vSize;in vec4 vB;in vec4 vC;in float vG;in float vTop;flat in float vInst;
uniform float uT,uTime,uFog,uHot,uFocus,uFocusAmt,uHover;uniform vec3 uCam,uFogCol;uniform vec3 uPal[12];
out vec4 o;
void main(){
  vec3 N=normalize(vN);vec3 tc=uCam-vW;float dist=length(tc);vec3 V=tc/dist;
  vec3 base=uPal[int(vC.x+.5)];
  vec3 L=normalize(vec3(-.5,.6,-.6));
  float ndl=max(dot(N,L),0.),hemi=N.y*.5+.5;
  vec3 amb=mix(vec3(.05,.10,.11),vec3(.22,.16,.32),hemi);
  vec3 col=base*(amb*1.7+vec3(.32,.44,.62)*ndl*.6);
  vec3 Ld=normalize(vec3(0.,.15,-1.));
  float rim=pow(1.-max(dot(N,V),0.),3.);
  col+=vec3(.85,.42,.5)*rim*.38*(.4+.6*max(dot(N,Ld),0.));
  float side=step(abs(N.y),.5);
  float ySt=vW.y-.28;
  vec2 uv=abs(N.x)>.5?vec2(vXZ.y*vSize.y,ySt):vec2(vXZ.x*vSize.x,ySt);
  vec2 cell=vec2(.34,.5),id=floor(uv/cell),f=fract(uv/cell);
  float win=step(.18,f.x)*step(f.x,.82)*step(.22,f.y)*step(f.y,.78)*step(1.,ySt)*side;
  float rnd=h21(id+vC.y*17.31+(abs(N.x)>.5?3.7:0.));
  float alive=1.-smoothstep(vB.z+.06,vB.z+.26,uT);alive=max(alive,.05);
  float act=vB.w*alive;
  float lit=step(rnd,act*.85+.02);
  float fl=.78+.22*sin(uTime*(1.+rnd*3.)+rnd*40.);
  vec3 warm=mix(vec3(1.,.66,.32),vec3(1.,.84,.56),h21(id+7.7));
  warm=mix(warm,vec3(1.,.30,.20),vC.z*uHot);
  vec3 emis=warm*lit*win*fl*1.9;
  emis*=1.-vC.w*.9;
  emis+=vec3(.30,.62,.75)*step(.988,rnd)*win*vC.w*.5;
  float period=.012+vC.y*.03;
  float k=floor((uT-vB.y)/period);float since=uT-(vB.y+k*period);
  float flash=(uT<vB.z)?smoothstep(.006,0.,since)*step(.55,h21(vec2(k,vC.y*91.))):0.;
  emis+=vec3(1.,.9,.72)*flash*win*1.5;col+=vec3(.5,.45,.36)*flash*.35;
  float grow=1.-vG;
  emis+=vec3(.45,.95,1.)*grow*smoothstep(1.4,0.,vTop-vW.y)*1.6;
  if(N.y>.5){col*=1.15;emis+=vec3(1.,.28,.18)*vC.z*uHot*.9;}
  float inF=(uFocus<-.5)?1.:step(abs(vC.x-uFocus),.5);
  col*=mix(1.,mix(.32,1.25,inF),uFocusAmt);emis*=mix(1.,mix(.35,1.3,inF),uFocusAmt);
  float hv=step(abs(vInst-uHover),.5);
  col+=vec3(.20,.42,.5)*hv*(.5+rim*2.);emis+=vec3(.2,.5,.6)*hv*.6*win;
  vec3 c=col+emis;
  float fg=1.-exp(-dist*uFog);fg*=mix(1.,.5,smoothstep(0.,18.,vW.y));
  c=mix(c,uFogCol,fg);
  o=vec4(c,1.);
}`};

SRC.pad={vs:H+`
layout(location=0) in vec3 aPos;layout(location=1) in vec2 aR;
uniform mat4 uVP;out vec3 vW;out float vRad;out float vD;
void main(){vW=aPos;vRad=aR.x;vD=aR.y;gl_Position=uVP*vec4(aPos,1.);}`,
fs:H+`
in vec3 vW;in float vRad;in float vD;
uniform float uT,uTime,uFog,uBirth[12],uAct[12],uMaxLt[12];uniform vec3 uCam,uFogCol,uRim[12];out vec4 o;
void main(){
  int d=int(vD+.5);
  float vis=smoothstep(uBirth[d],uBirth[d]+.05,uT);
  if(vis<.01)discard;
  vec3 c=vec3(.03,.062,.078);
  vec2 g=abs(fract(vW.xz/1.6)-.5);
  float st=smoothstep(.43,.5,max(g.x,g.y));
  float alive=1.-smoothstep(uMaxLt[d]+.06,uMaxLt[d]+.26,uT);alive=max(alive,.1);
  c+=vec3(1.,.6,.3)*st*.11*uAct[d]*alive*step(vRad,1.);
  float rim=(vRad>1.)?.55:smoothstep(.93,.985,vRad);
  c+=uRim[d]*rim*(.5+.5*sin(uTime*.6+vD*1.7))*.9*mix(.25,1.,alive);
  float dist=length(uCam-vW);float fg=1.-exp(-dist*uFog);
  c=mix(c,uFogCol,fg*.9);
  o=vec4(c*vis,1.);
}`};

SRC.line={vs:H+`layout(location=0) in vec3 aP;layout(location=1) in float aU;uniform mat4 uVP;out float vU;void main(){vU=aU;gl_Position=uVP*vec4(aP,1.);}`,
fs:H+`in float vU;uniform float uT,uTime,uBirth,uS,uVis;out vec4 o;
void main(){float v=smoothstep(uBirth,uBirth+.05,uT);float p=fract(vU*2.-uTime*.12);float pulse=.25+.75*smoothstep(.82,1.,p);o=vec4(vec3(.35,.85,.8)*pulse*uS*v*uVis*.8,1.);}`};

SRC.pts={vs:H+`
layout(location=0) in vec3 aPos;layout(location=1) in vec4 aP;layout(location=2) in vec3 aCol;
uniform mat4 uVP;uniform vec3 uCam;uniform float uTime,uPx,uMotion,uVis;out vec3 vCol;out float vI;
void main(){
  vec3 p=aPos;
  if(uMotion>.5){float ph=aP.y;p+=vec3(sin(uTime*.31+ph*6.28)*2.2,sin(uTime*.5+ph*9.)*.7,cos(uTime*.27+ph*5.)*2.2);}
  float d=length(uCam-p);
  gl_Position=uVP*vec4(p,1.);
  gl_PointSize=clamp(aP.x*uPx/d,1.,110.);
  float tw=.6+.4*sin(uTime*(1.5+aP.y*3.)+aP.y*40.);
  vI=aP.w*tw*uVis;vCol=aCol;
}`,
fs:H+`in vec3 vCol;in float vI;out vec4 o;void main(){float r=length(gl_PointCoord-.5)*2.;float a=pow(clamp(1.-r,0.,1.),2.2);o=vec4(vCol*a*vI,a*vI);}`};

SRC.beam={vs:H+`
layout(location=0) in vec2 aQ;layout(location=1) in vec4 iP;
uniform mat4 uVP;uniform vec3 uCam;out vec2 vQ;out float vB;
void main(){
  vec3 tc=uCam-iP.xyz;tc.y=0.;vec3 r=normalize(cross(vec3(0.,1.,0.),tc));
  vec3 w=iP.xyz+r*aQ.x*.9+vec3(0.,aQ.y*28.,0.);
  vQ=aQ;vB=iP.w;gl_Position=uVP*vec4(w,1.);
}`,
fs:H+`in vec2 vQ;in float vB;uniform float uT,uTime,uHot;out vec4 o;
void main(){float vis=smoothstep(vB+.04,vB+.08,uT)*uHot;float a=pow(1.-vQ.y,1.7)*pow(1.-abs(vQ.x),2.2);float pulse=.7+.3*sin(uTime*2.1+vB*40.);o=vec4(vec3(1.,.30,.22)*a*pulse*vis*1.6,a*vis);}`};

SRC.mist={vs:H+`
layout(location=0) in vec2 aQ;layout(location=1) in vec4 iP;
uniform mat4 uVP;uniform vec3 uRight,uUp,uCam;uniform float uTime;out vec2 vQ;out float vD;out float vPh;
void main(){
  vec3 p=iP.xyz+vec3(sin(uTime*.05+iP.w*9.)*4.,0.,cos(uTime*.04+iP.w*7.)*4.);
  float s=14.+iP.w*26.;
  vec3 w=p+(uRight*aQ.x+uUp*aQ.y*.35)*s;
  vQ=aQ;vD=length(uCam-p);vPh=iP.w;gl_Position=uVP*vec4(w,1.);
}`,
fs:H+NOISE+`in vec2 vQ;in float vD;in float vPh;uniform vec3 uFogCol;uniform float uTime;out vec4 o;
void main(){float r=length(vQ);float a=pow(clamp(1.-r,0.,1.),1.6)*(.55+.45*vnoise(vQ*3.+vPh*20.+uTime*.02));a*=.10*smoothstep(8.,40.,vD);o=vec4(uFogCol*1.25*a,a);}`};

SRC.bright={vs:H+FS_TRI,fs:H+`in vec2 vUv;uniform sampler2D uTex;uniform vec2 uTexel;uniform float uThr;out vec4 o;
void main(){vec2 u=vUv;vec3 c=(texture(uTex,u+uTexel*.5).rgb+texture(uTex,u-uTexel*.5).rgb+texture(uTex,u+vec2(uTexel.x,-uTexel.y)*.5).rgb+texture(uTex,u+vec2(-uTexel.x,uTexel.y)*.5).rgb)*.25;
float l=max(c.r,max(c.g,c.b));float k=smoothstep(uThr,uThr+.7,l);o=vec4(c*k,1.);}`};
SRC.blur={vs:H+FS_TRI,fs:H+`in vec2 vUv;uniform sampler2D uTex;uniform vec2 uDir;out vec4 o;
void main(){vec3 c=texture(uTex,vUv).rgb*.227;
c+=(texture(uTex,vUv+uDir*1.).rgb+texture(uTex,vUv-uDir*1.).rgb)*.194;
c+=(texture(uTex,vUv+uDir*2.).rgb+texture(uTex,vUv-uDir*2.).rgb)*.122;
c+=(texture(uTex,vUv+uDir*3.).rgb+texture(uTex,vUv-uDir*3.).rgb)*.054;
c+=(texture(uTex,vUv+uDir*4.).rgb+texture(uTex,vUv-uDir*4.).rgb)*.016;o=vec4(c,1.);}`};
SRC.comp={vs:H+FS_TRI,fs:H+NOISE+`in vec2 vUv;uniform sampler2D uScene,uB1,uB2;uniform float uBloom,uB2k,uExp,uFade,uTime,uGrain;out vec4 o;
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){
  vec2 d=vUv-.5;float ca=.0022*dot(d,d)*4.;
  vec3 c;c.r=texture(uScene,vUv+d*ca*2.).r;c.g=texture(uScene,vUv).g;c.b=texture(uScene,vUv-d*ca*2.).b;
  c+=texture(uB1,vUv).rgb*uBloom+texture(uB2,vUv).rgb*uB2k;
  c*=uExp;c=aces(c);
  float lum=dot(c,vec3(.299,.587,.114));
  c=mix(c*vec3(.90,1.02,1.07),c*vec3(1.07,.985,.95),smoothstep(.3,.85,lum));
  float vg=smoothstep(1.12,.28,length(d*vec2(1.,.92)));c*=mix(.42,1.,vg);
  c+=(h21(gl_FragCoord.xy+fract(uTime)*97.)-.5)*uGrain;
  o=vec4(c*uFade,1.);
}`};

const TIERS=[
  {name:'simple',   dpr:1.0, refl:0,  bloom:0,msaa:0,mist:0, cloud:0,fire:60},
  {name:'balanced', dpr:1.25,refl:.35,bloom:1,msaa:0,mist:10,cloud:1,fire:120},
  {name:'cinematic',dpr:1.75,refl:.5, bloom:2,msaa:4,mist:26,cloud:1,fire:220},
];

function createRenderer(canvas,W0){
  let W=W0;
  const gl=canvas.getContext('webgl2',{antialias:false,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false});
  if(!gl)return null;
  const extF=gl.getExtension('EXT_color_buffer_float');gl.getExtension('EXT_color_buffer_half_float');gl.getExtension('OES_texture_float_linear');
  const HDR=extF?{i:gl.RGBA16F,f:gl.RGBA,t:gl.HALF_FLOAT}:{i:gl.RGBA8,f:gl.RGBA,t:gl.UNSIGNED_BYTE};
  const maxSamples=gl.getParameter(gl.MAX_SAMPLES)||0;
  let ok=true;
  const progs={};
  function compile(type,src,name){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){console.error('[shader '+name+']',gl.getShaderInfoLog(s));ok=false}return s}
  for(const k in SRC){
    const p=gl.createProgram();gl.attachShader(p,compile(gl.VERTEX_SHADER,SRC[k].vs,k+'.vs'));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,SRC[k].fs,k+'.fs'));gl.linkProgram(p);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS)){console.error('[link '+k+']',gl.getProgramInfoLog(p));ok=false}
    const u={};const n=gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){const info=gl.getActiveUniform(p,i);const nm=info.name.replace(/\[0\]$/,'');u[nm]=gl.getUniformLocation(p,info.name)}
    progs[k]={p,u};
  }
  if(!ok)return null;

  const buf=(data,usage=gl.STATIC_DRAW)=>{const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,usage);return b};
  const attr=(loc,size,stride=0,off=0,div=0)=>{gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,stride,off);if(div)gl.vertexAttribDivisor(loc,div)};
  const vao=fn=>{const v=gl.createVertexArray();gl.bindVertexArray(v);fn();gl.bindVertexArray(null);return v};

  /* cube */
  const faces=[
    {n:[1,0,0],c:[[.5,0,-.5],[.5,0,.5],[.5,1,.5],[.5,1,-.5]]},{n:[-1,0,0],c:[[-.5,0,.5],[-.5,0,-.5],[-.5,1,-.5],[-.5,1,.5]]},
    {n:[0,1,0],c:[[-.5,1,-.5],[.5,1,-.5],[.5,1,.5],[-.5,1,.5]]},{n:[0,0,1],c:[[.5,0,.5],[-.5,0,.5],[-.5,1,.5],[.5,1,.5]]},
    {n:[0,0,-1],c:[[-.5,0,-.5],[.5,0,-.5],[.5,1,-.5],[-.5,1,-.5]]}];
  const cv=[],ci=[];faces.forEach((f,i)=>{f.c.forEach(p=>cv.push(...p,...f.n));const o=i*4;ci.push(o,o+1,o+2,o,o+2,o+3)});
  const cubeVB=buf(new Float32Array(cv)),cubeIB=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,cubeIB);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(ci),gl.STATIC_DRAW);

  /* water */
  const waterVAO=vao(()=>{buf(new Float32Array([-700,-700,700,-700,-700,700,700,-700,700,700,-700,700]));attr(0,2)});

  let N=0,bldVAO,padCount=0,padVAO,curveVAOs=[],fVAO,lVAO,LN=0,lb,beamVAO,mistVAO,palArr,rimArr,birthArr,actArr,ltArr;
  function setWorld(Wn){W=Wn;
  /* instances */
  N=W.files.length;const inst=new Float32Array(N*12);
  W.files.forEach((f,i)=>{const o=i*12;inst.set([f.x,f.z,f.w,f.d, f.h,f.birth,f.lt,f.act, f.dist,f.seed,f.hot,f.dead],o)});
  const instVB=buf(inst);
  bldVAO=vao(()=>{gl.bindBuffer(gl.ARRAY_BUFFER,cubeVB);attr(0,3,24,0);attr(1,3,24,12);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,cubeIB);gl.bindBuffer(gl.ARRAY_BUFFER,instVB);attr(2,4,48,0,1);attr(3,4,48,16,1);attr(4,4,48,32,1)});

  /* pads */
  const pv=[],SEG=72;
  W.dists.forEach(d=>{
    for(let s=0;s<SEG;s++){
      const a0=s/SEG*Math.PI*2,a1=(s+1)/SEG*Math.PI*2,r=d.r;
      const x0=d.x+Math.cos(a0)*r,z0=d.z+Math.sin(a0)*r,x1=d.x+Math.cos(a1)*r,z1=d.z+Math.sin(a1)*r;
      pv.push(d.x,.25,d.z,0,d.i, x0,.25,z0,1,d.i, x1,.25,z1,1,d.i);
      pv.push(x0,.25,z0,1,d.i, x0,-.15,z0,1.5,d.i, x1,.25,z1,1,d.i);
      pv.push(x1,.25,z1,1,d.i, x0,-.15,z0,1.5,d.i, x1,-.15,z1,1.5,d.i);
    }
  });
  padCount=pv.length/5;const padVB=buf(new Float32Array(pv));
  padVAO=vao(()=>{gl.bindBuffer(gl.ARRAY_BUFFER,padVB);attr(0,3,20,0);attr(1,2,20,12)});

  /* curves */
  curveVAOs=W.curves.map(c=>{const b=buf(c.pts);return vao(()=>{gl.bindBuffer(gl.ARRAY_BUFFER,b);attr(0,3,16,0);attr(1,1,16,12)})});

  /* fireflies + lanterns */
  const FMAX=220,fdata=new Float32Array(FMAX*3),fmeta=new Float32Array(FMAX*4),fcol=new Float32Array(FMAX*3);
  {const R=rng(W.seed^0x5bd1);for(let i=0;i<FMAX;i++){const a=R()*Math.PI*2,r=Math.sqrt(R())*95;fdata.set([Math.cos(a)*r,.6+R()*6,Math.sin(a)*r],i*3);fmeta.set([.16+R()*.18,R(),0,.55+R()*.6],i*4);const w=R();fcol.set(w<.6?[1,.72,.38]:[.45,.95,.85],i*3)}}
  fVAO=vao(()=>{attr0(fdata,0,3);attr0(fmeta,1,4);attr0(fcol,2,3)});
  function attr0(data,loc,size){buf(data);attr(loc,size)}
  LN=W.people_.length;const ldata=new Float32Array(LN*3),lmeta=new Float32Array(LN*4),lcol=new Float32Array(LN*3);
  for(let i=0;i<LN;i++){lmeta.set([.9,i/LN,0,2.2],i*4);lcol.set([1,.78,.45],i*3)}
  lb=gl.createBuffer();
  lVAO=vao(()=>{gl.bindBuffer(gl.ARRAY_BUFFER,lb);gl.bufferData(gl.ARRAY_BUFFER,ldata,gl.DYNAMIC_DRAW);attr(0,3);attr0(lmeta,1,4);attr0(lcol,2,3)});

  /* beams */
  const bq=new Float32Array([-1,0, 1,0, -1,1, 1,0, 1,1, -1,1]);
  const hotData=new Float32Array(W.hot.length*4);W.hot.forEach((fi,i)=>{const f=W.files[fi];hotData.set([f.x,.28+f.h,f.z,f.birth],i*4)});
  beamVAO=vao(()=>{buf(bq);attr(0,2);const b=buf(hotData);attr(1,4,16,0,1)});

  /* mist */
  const MM=26,mist=new Float32Array(MM*4);{const R=rng(W.seed^0x9e37);for(let i=0;i<MM;i++){const a=R()*Math.PI*2,r=Math.sqrt(R())*100;mist.set([Math.cos(a)*r,1.2+R()*3.5,Math.sin(a)*r,R()],i*4)}}
  mistVAO=vao(()=>{buf(new Float32Array([-1,-1,1,-1,-1,1,1,-1,1,1,-1,1]));attr(0,2);buf(mist);attr(1,4,16,0,1)});

  /* palette uniforms */
  const PAL=[[.10,.22,.26],[.17,.14,.30],[.11,.17,.32],[.26,.19,.15],[.13,.16,.16]];
  const RIM=[[.25,.95,.80],[.70,.52,1.],[.38,.60,1.],[1.,.70,.40],[.45,.60,.60]];
  palArr=new Float32Array(36);rimArr=new Float32Array(36);birthArr=new Float32Array(12);actArr=new Float32Array(12);ltArr=new Float32Array(12);
  W.dists.forEach(d=>{palArr.set(PAL[d.pal],d.i*3);rimArr.set(RIM[d.pal],d.i*3);birthArr[d.i]=d.b0;actArr[d.i]=d.act;ltArr[d.i]=d.maxLt});

  }
  /* targets */
  let T={};
  const mkTex=(w,h)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,HDR.i,w,h,0,HDR.f,HDR.t,null);for(const [a,b] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,a,b);return t};
  const mkFBO=(w,h,depth)=>{w=Math.max(2,w|0);h=Math.max(2,h|0);const f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);const t=mkTex(w,h);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);let rb=null;if(depth){rb=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,rb);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,w,h);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,rb)}const okk=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;return{f,t,rb,w,h,ok:okk}};
  const mkMS=(w,h,s)=>{const f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);const c=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,c);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,s,HDR.i,w,h);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,c);const d=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,d);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,s,gl.DEPTH_COMPONENT24,w,h);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,d);const okk=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;return{f,c,d,w,h,ok:okk}};
  const free=o=>{if(!o)return;if(o.f)gl.deleteFramebuffer(o.f);if(o.t)gl.deleteTexture(o.t);if(o.rb)gl.deleteRenderbuffer(o.rb);if(o.c)gl.deleteRenderbuffer(o.c);if(o.d)gl.deleteRenderbuffer(o.d)};
  const nullTex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,nullTex);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
  let tier=TIERS[2],cw=0,ch=0;
  function alloc(w,h,tr){
    Object.values(T).forEach(free);T={};tier=tr;cw=w;ch=h;
    T.scene=mkFBO(w,h,true);
    if(tr.msaa&&maxSamples>=tr.msaa){const ms=mkMS(w,h,Math.min(tr.msaa,maxSamples));if(ms.ok)T.ms=ms;else free(ms)}
    if(tr.refl)T.refl=mkFBO(w*tr.refl,h*tr.refl,true);
    if(tr.bloom){T.b1a=mkFBO(w/4,h/4);T.b1b=mkFBO(w/4,h/4);if(tr.bloom>1){T.b2a=mkFBO(w/8,h/8);T.b2b=mkFBO(w/8,h/8)}}
    T.dummy=T.b2a||T.b1a||T.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }

  const use=p=>{gl.useProgram(p.p);return p.u};
  const cam4={};
  function drawWorld(pass,C,P,time){
    const refl=pass==='refl',W2=refl?T.refl.w:cw,H2=refl?T.refl.h:ch;
    gl.viewport(0,0,W2,H2);
    gl.clearColor(.075,.17,.19,1);gl.clearDepth(1);gl.depthMask(true);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const vp=refl?C.vpR:C.vp,cp=refl?C.posR:C.pos;
    /* sky */
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
    let u=use(progs.sky);
    gl.uniform3fv(u.uRight,C.right);gl.uniform3fv(u.uUp,C.up);gl.uniform3fv(u.uFwd,C.fwd);gl.uniform1f(u.uTanH,C.tanH);gl.uniform1f(u.uAspect,cw/ch);gl.uniform1f(u.uMirror,refl?-1:1);
    gl.uniform1f(u.uTime,time);gl.uniform3f(u.uSunDir,0,0,-1);gl.uniform3f(u.uMoonDir,-.42,.36,-.83);gl.uniform1f(u.uCloud,tier.cloud);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
    /* water */
    if(!refl){
      u=use(progs.water);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uFog,P.fog);gl.uniform3f(u.uFogCol,.075,.17,.19);
      gl.uniform3f(u.uMoonDir,-.42,.36,-.83);gl.uniform3f(u.uSunDir,0,0,-1);gl.uniform1f(u.uCloud,0);
      gl.uniform2f(u.uScr,cw,ch);gl.uniform1f(u.uHasRefl,T.refl?1:0);
      if(T.refl){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,T.refl.t);gl.uniform1i(u.uRefl,0)}
      gl.bindVertexArray(waterVAO);gl.drawArrays(gl.TRIANGLES,0,6);
    }
    /* pads */
    u=use(progs.pad);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uT,P.t);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uFog,P.fog);gl.uniform3f(u.uFogCol,.075,.17,.19);
    gl.uniform1fv(u.uBirth,birthArr);gl.uniform1fv(u.uAct,actArr);gl.uniform1fv(u.uMaxLt,ltArr);gl.uniform3fv(u.uRim,rimArr);
    gl.bindVertexArray(padVAO);gl.drawArrays(gl.TRIANGLES,0,padCount);
    /* buildings */
    u=use(progs.bld);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uT,P.t);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uFog,P.fog);gl.uniform3f(u.uFogCol,.075,.17,.19);
    gl.uniform1f(u.uHot,P.hot);gl.uniform1f(u.uFocus,P.focus);gl.uniform1f(u.uFocusAmt,P.focusAmt);gl.uniform1f(u.uHover,refl?-1:P.hover);gl.uniform3fv(u.uPal,palArr);
    gl.bindVertexArray(bldVAO);gl.drawElementsInstanced(gl.TRIANGLES,30,gl.UNSIGNED_SHORT,0,N);
    if(refl)return;
    /* additive layer */
    gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
    u=use(progs.line);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform1f(u.uT,P.t);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uVis,.55+.45*P.hot);
    W.curves.forEach((c,i)=>{gl.uniform1f(u.uBirth,c.birth);gl.uniform1f(u.uS,c.s);gl.bindVertexArray(curveVAOs[i]);gl.drawArrays(gl.LINE_STRIP,0,c.n)});
    u=use(progs.beam);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uT,P.t);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uHot,P.hot);
    gl.bindVertexArray(beamVAO);gl.drawArraysInstanced(gl.TRIANGLES,0,6,W.hot.length);
    u=use(progs.pts);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uPx,ch/(2*C.tanH));
    gl.uniform1f(u.uMotion,1);gl.uniform1f(u.uVis,1);gl.bindVertexArray(fVAO);gl.drawArrays(gl.POINTS,0,tier.fire);
    gl.uniform1f(u.uMotion,0);gl.uniform1f(u.uVis,1);gl.bindVertexArray(lVAO);gl.drawArrays(gl.POINTS,0,LN);
    /* mist */
    if(tier.mist){
      gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      u=use(progs.mist);gl.uniformMatrix4fv(u.uVP,false,vp);gl.uniform3fv(u.uRight,C.right);gl.uniform3fv(u.uUp,C.up);gl.uniform3fv(u.uCam,cp);gl.uniform1f(u.uTime,time);gl.uniform3f(u.uFogCol,.075,.17,.19);
      gl.bindVertexArray(mistVAO);gl.drawArraysInstanced(gl.TRIANGLES,0,6,tier.mist);
    }
    gl.depthMask(true);gl.disable(gl.BLEND);
  }
  const tri=(p,setup)=>{const u=use(p);setup(u);gl.bindVertexArray(null);gl.drawArrays(gl.TRIANGLES,0,3)};
  function render(C,P,time,lanterns){
    if(lanterns){gl.bindBuffer(gl.ARRAY_BUFFER,lb);gl.bufferSubData(gl.ARRAY_BUFFER,0,lanterns)}
    gl.bindVertexArray(null);
    for(let i=2;i>=0;i--){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,i===0?nullTex:null)}
    if(T.refl){gl.bindFramebuffer(gl.FRAMEBUFFER,T.refl.f);drawWorld('refl',C,P,time)}
    gl.bindFramebuffer(gl.FRAMEBUFFER,(T.ms?T.ms:T.scene).f);drawWorld('main',C,P,time);
    if(T.ms){gl.bindFramebuffer(gl.READ_FRAMEBUFFER,T.ms.f);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,T.scene.f);gl.blitFramebuffer(0,0,cw,ch,0,0,cw,ch,gl.COLOR_BUFFER_BIT,gl.NEAREST)}
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    if(T.b1a){
      gl.bindFramebuffer(gl.FRAMEBUFFER,T.b1a.f);gl.viewport(0,0,T.b1a.w,T.b1a.h);gl.bindTexture(gl.TEXTURE_2D,T.scene.t);
      tri(progs.bright,u=>{gl.uniform1i(u.uTex,0);gl.uniform2f(u.uTexel,1/cw,1/ch);gl.uniform1f(u.uThr,.85)});
      const pass=(src,dst,dx,dy)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,dst.f);gl.viewport(0,0,dst.w,dst.h);gl.bindTexture(gl.TEXTURE_2D,src.t);tri(progs.blur,u=>{gl.uniform1i(u.uTex,0);gl.uniform2f(u.uDir,dx/src.w,dy/src.h)})};
      pass(T.b1a,T.b1b,1.6,0);pass(T.b1b,T.b1a,0,1.6);
      if(T.b2a){pass(T.b1a,T.b2a,0,0);pass(T.b2a,T.b2b,1.6,0);pass(T.b2b,T.b2a,0,1.6)}
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,cw,ch);
    const bind=(unit,t)=>{gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t)};
    bind(0,T.scene.t);bind(1,(T.b1a||T.dummy).t);bind(2,(T.b2a||T.b1a||T.dummy).t);
    tri(progs.comp,u=>{gl.uniform1i(u.uScene,0);gl.uniform1i(u.uB1,1);gl.uniform1i(u.uB2,2);gl.uniform1f(u.uBloom,tier.bloom?.9:0);gl.uniform1f(u.uB2k,tier.bloom>1?1.1:0);gl.uniform1f(u.uExp,P.exposure||1.0);gl.uniform1f(u.uFade,P.fade);gl.uniform1f(u.uTime,time);gl.uniform1f(u.uGrain,REDUCED?0:.035)});
  }
  setWorld(W0);
  return{gl,alloc,render,setWorld,tiers:TIERS,get hdr(){return!!extF},get msaa(){return!!T.ms}};
}
