/* GLSL ported from prototype/src/gl.js (the reference look). Changes from the prototype are marked PORT. */
/* eslint-disable */

export const H='#version 300 es\nprecision highp float;\n';
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

export type Program = { vs: string; fs: string };
export const SRC: Record<string, Program> = {};
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
layout(location=2) in vec4 iA;layout(location=3) in vec4 iB;layout(location=4) in vec4 iC;layout(location=5) in vec4 iD;
`+BUILDING_COMMON+`
out vec3 vW;out vec3 vN;out vec2 vXZ;out vec2 vSize;out vec4 vB;out vec4 vC;out float vG;out float vTop;flat out float vInst;flat out float vDist;
void main(){
  float g=clamp((uT-iB.y)/.03,0.,1.);
  float ge=1.-pow(1.-g,3.);ge*=1.+.06*sin(g*3.14159);
  if(g<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
  float h=iB.x*ge;
  vec3 w=vec3(iA.x+aPos.x*iA.z,.28+aPos.y*h,iA.y+aPos.z*iA.w);
  vW=w;vN=aNor;vXZ=aPos.xz+.5;vSize=iA.zw;vB=iB;vC=iC;vG=g;vTop=.28+h;vInst=float(gl_InstanceID);vDist=iD.x;
  gl_Position=uVP*vec4(w,1.);
}`,
fs:H+NOISE+`
in vec3 vW;in vec3 vN;in vec2 vXZ;in vec2 vSize;in vec4 vB;in vec4 vC;in float vG;in float vTop;flat in float vInst;flat in float vDist;
uniform float uT,uTime,uFog,uHot,uFocus,uFocusAmt,uHover;uniform vec3 uCam,uFogCol;uniform vec3 uPal[5];/* PORT: 5 palette kinds, not 12 districts */
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
  float inF=(uFocus<-.5)?1.:step(abs(vDist-uFocus),.5);/* PORT: focus by district index, not palette */
  col*=mix(1.,mix(.32,1.25,inF),uFocusAmt);emis*=mix(1.,mix(.35,1.3,inF),uFocusAmt);
  float hv=step(abs(vInst-uHover),.5);
  col+=vec3(.20,.42,.5)*hv*(.5+rim*2.);emis+=vec3(.2,.5,.6)*hv*.6*win;
  vec3 c=col+emis;
  float fg=1.-exp(-dist*uFog);fg*=mix(1.,.5,smoothstep(0.,18.,vW.y));
  c=mix(c,uFogCol,fg);
  o=vec4(c,1.);
}`};

/* PORT: per-district values travel as vertex attributes (aD = birth, activity, last touch, palette) instead of
   uniform arrays sized for 12 districts, so any number of districts works. */
SRC.pad={vs:H+`
layout(location=0) in vec3 aPos;layout(location=1) in vec2 aR;layout(location=2) in vec4 aD;
uniform mat4 uVP;out vec3 vW;out float vRad;out float vD;flat out vec4 vDist;
void main(){vW=aPos;vRad=aR.x;vD=aR.y;vDist=aD;gl_Position=uVP*vec4(aPos,1.);}`,
fs:H+`
in vec3 vW;in float vRad;in float vD;flat in vec4 vDist;
uniform float uT,uTime,uFog;uniform vec3 uCam,uFogCol,uRim[5];out vec4 o;
void main(){
  float vis=smoothstep(vDist.x,vDist.x+.05,uT);
  if(vis<.01)discard;
  vec3 c=vec3(.03,.062,.078);
  vec2 g=abs(fract(vW.xz/1.6)-.5);
  float st=smoothstep(.43,.5,max(g.x,g.y));
  float alive=1.-smoothstep(vDist.z+.06,vDist.z+.26,uT);alive=max(alive,.1);
  c+=vec3(1.,.6,.3)*st*.11*vDist.y*alive*step(vRad,1.);
  float rim=(vRad>1.)?.55:smoothstep(.93,.985,vRad);
  c+=uRim[int(vDist.w+.5)]*rim*(.5+.5*sin(uTime*.6+vD*1.7))*.9*mix(.25,1.,alive);
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
void main(){float vis=smoothstep(vB+.04,vB+.08,uT)*uHot;float a=pow(max(1.-vQ.y,0.),1.7)*pow(max(1.-abs(vQ.x),0.),2.2);/* PORT: clamp; MSAA extrapolates varyings past the quad edge and pow(negative) is NaN */float pulse=.7+.3*sin(uTime*2.1+vB*40.);o=vec4(vec3(1.,.30,.22)*a*pulse*vis*1.6,a*vis);}`};

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
if(any(isnan(c))||any(isinf(c)))c=vec3(0.);c=max(c,0.);/* PORT: one bad pixel must never smear through the blur chain */
float l=max(c.r,max(c.g,c.b));float k=smoothstep(uThr,uThr+.7,l);o=vec4(c*k,1.);}`};
SRC.blur={vs:H+FS_TRI,fs:H+`in vec2 vUv;uniform sampler2D uTex;uniform vec2 uDir;out vec4 o;
void main(){vec3 c=texture(uTex,vUv).rgb*.227;
c+=(texture(uTex,vUv+uDir*1.).rgb+texture(uTex,vUv-uDir*1.).rgb)*.194;
c+=(texture(uTex,vUv+uDir*2.).rgb+texture(uTex,vUv-uDir*2.).rgb)*.122;
c+=(texture(uTex,vUv+uDir*3.).rgb+texture(uTex,vUv-uDir*3.).rgb)*.054;
c+=(texture(uTex,vUv+uDir*4.).rgb+texture(uTex,vUv-uDir*4.).rgb)*.016;o=vec4(c,1.);}`};
SRC.comp={vs:H+FS_TRI,fs:H+NOISE+`in vec2 vUv;uniform sampler2D uScene,uB1,uB2;uniform float uBloom,uB2k,uExp,uFade,uTime,uGrain,uCA;out vec4 o;
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){
  vec2 d=vUv-.5;float ca=.0022*dot(d,d)*4.*uCA;/* PORT: scaled by scroll velocity (EXPERIENCE section 1) */
  vec3 c;c.r=texture(uScene,vUv+d*ca*2.).r;c.g=texture(uScene,vUv).g;c.b=texture(uScene,vUv-d*ca*2.).b;
  if(any(isnan(c))||any(isinf(c)))c=vec3(0.);
  c+=texture(uB1,vUv).rgb*uBloom+texture(uB2,vUv).rgb*uB2k;
  c*=uExp;c=aces(c);
  float lum=dot(c,vec3(.299,.587,.114));
  c=mix(c*vec3(.90,1.02,1.07),c*vec3(1.07,.985,.95),smoothstep(.3,.85,lum));
  float vg=smoothstep(1.12,.28,length(d*vec2(1.,.92)));c*=mix(.42,1.,vg);
  c+=(h21(gl_FragCoord.xy+fract(uTime)*97.)-.5)*uGrain;
  o=vec4(c*uFade,1.);
}`};

/* PORT: GPU picking (EXPERIENCE section 9). Same geometry as `bld`; writes instance index + 1 as RGBA8. */
SRC.pick={vs:H+`
layout(location=0) in vec3 aPos;
layout(location=2) in vec4 iA;layout(location=3) in vec4 iB;
uniform mat4 uVP;uniform float uT;flat out int vId;
void main(){
  float g=clamp((uT-iB.y)/.03,0.,1.);
  if(g<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
  vec3 w=vec3(iA.x+aPos.x*iA.z,.28+aPos.y*iB.x*g,iA.y+aPos.z*iA.w);
  vId=gl_InstanceID+1;gl_Position=uVP*vec4(w,1.);
}`,
fs:H+`flat in int vId;out vec4 o;
void main(){o=vec4(float(vId&255),float((vId>>8)&255),float((vId>>16)&255),255.)/255.;}`};
