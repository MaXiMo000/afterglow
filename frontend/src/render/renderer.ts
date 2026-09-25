/**
 * WebGL2 renderer, ported from prototype/src/gl.js (see docs/PLAN.md section 3 for why raw WebGL2, not Three.js).
 *
 * Additions over the prototype (EXPERIENCE section 9): shaders compile in parallel (KHR_parallel_shader_compile)
 * and are polled instead of blocking; dynamic resolution holds the frame budget; hover/click use a GPU ID pass read
 * back asynchronously through a pixel-pack buffer; instance counts come from validated data only (SECURITY T21).
 */
import { mirrorY, rng, type M4, type V3 } from './math';
import { SRC } from './shaders';
import { INST, type World } from '../world/build';

export type Tier = { name: 'simple' | 'balanced' | 'cinematic'; dpr: number; refl: number; bloom: 0 | 1 | 2; msaa: number; mist: number; cloud: number; fire: number; dof: 0 | 1 | 2; flare: 0 | 1 | 2 };
export const TIERS: readonly Tier[] = [
  { name: 'simple', dpr: 1.0, refl: 0, bloom: 0, msaa: 0, mist: 0, cloud: 0, fire: 60, dof: 0, flare: 0 },
  { name: 'balanced', dpr: 1.25, refl: 0.35, bloom: 1, msaa: 0, mist: 10, cloud: 1, fire: 120, dof: 1, flare: 1 },
  { name: 'cinematic', dpr: 1.75, refl: 0.5, bloom: 2, msaa: 4, mist: 26, cloud: 1, fire: 220, dof: 2, flare: 2 },
];

export type Camera = { vp: M4; vpR: M4; pos: V3; posR: V3; right: V3; up: V3; fwd: V3; tanH: number; near: number; far: number };
export type Params = { t: number; fog: number; hot: number; focus: number; focusAmt: number; hover: number; fade: number; exposure: number; grain: number; ca: number;
  /** Explore toggles (A5): coupling arcs, lanterns, and compare mode [on, fromT, toT] in normalised history time. */
  arcs: number; lanterns: number; cmp: [number, number, number];
  /** Effects (A6): hover lift 0..1, selected file (-1 none), focus distance for depth of field (0 off), DOF amount,
   *  motion 0/1 (reduced motion turns off ripples, heartbeat and trails). */
  lift: number; sel: number; focusDist: number; dof: number; motion: number };

const FOG_COL: V3 = [0.075, 0.17, 0.19];
const MOON: V3 = [-0.42, 0.36, -0.83];
const PAL = [[0.1, 0.22, 0.26], [0.17, 0.14, 0.3], [0.11, 0.17, 0.32], [0.26, 0.19, 0.15], [0.13, 0.16, 0.16]].flat();
const RIM = [[0.25, 0.95, 0.8], [0.7, 0.52, 1], [0.38, 0.6, 1], [1, 0.7, 0.4], [0.45, 0.6, 0.6]].flat();
const MAX_FIRE = 220;
const MAX_MIST = 26;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { f: WebGLFramebuffer; t: WebGLTexture | null; rbs: WebGLRenderbuffer[]; w: number; h: number; d?: WebGLTexture };
const TRAIL = 8; // lantern trail samples

export class RendererError extends Error {}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progs: Record<string, Prog> = {};
  private pending: { name: string; p: WebGLProgram; vs: WebGLShader; fs: WebGLShader }[] = [];
  private readonly parallel: boolean;
  private readonly hdr: { i: number; f: number; t: number };
  private readonly maxSamples: number;
  private T: Record<string, Target> = {};
  private tier: Tier = TIERS[2]!;
  private cw = 2;
  private ch = 2;
  private world: World | null = null;
  private vaos: { bld?: WebGLVertexArrayObject; pad?: WebGLVertexArrayObject; beam?: WebGLVertexArrayObject; fire?: WebGLVertexArrayObject; lant?: WebGLVertexArrayObject; mist?: WebGLVertexArrayObject; water?: WebGLVertexArrayObject; ripple?: WebGLVertexArrayObject; curves: WebGLVertexArrayObject[] } = { curves: [] };
  private buffers: WebGLBuffer[] = [];
  private n = 0;
  private padCount = 0;
  private lanternBuf: WebGLBuffer | null = null;
  private lanternCount = 0;
  private trail: Float32Array | null = null; // TRAIL past positions per lantern, newest first
  private trailOut: Float32Array | null = null; // reused upload buffer (no per-frame allocation)
  private trailAt = 0;
  private cube!: { vb: WebGLBuffer; ib: WebGLBuffer };
  private nullTex: WebGLTexture;
  private pickState: { fbo: WebGLFramebuffer; rb: WebGLRenderbuffer; depth: WebGLRenderbuffer; pbo: WebGLBuffer; fence: WebGLSync | null; resolve: ((id: number) => void) | null } | null = null;
  private lost = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new RendererError('no_webgl2');
    this.gl = gl;
    const extF = gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.parallel = !!gl.getExtension('KHR_parallel_shader_compile');
    this.hdr = extF ? { i: gl.RGBA16F, f: gl.RGBA, t: gl.HALF_FLOAT } : { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
    this.maxSamples = (gl.getParameter(gl.MAX_SAMPLES) as number) || 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.nullTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.nullTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.startCompile();
    this.buildStatic();
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  // ---------- shaders: compile in parallel, poll, never block the main thread ----------
  private startCompile(): void {
    const gl = this.gl;
    for (const [name, src] of Object.entries(SRC)) {
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(vs, src.vs);
      gl.shaderSource(fs, src.fs);
      gl.compileShader(vs);
      gl.compileShader(fs);
      const p = gl.createProgram()!;
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      this.pending.push({ name, p, vs, fs });
    }
  }

  /** True once every program is linked. Throws RendererError if any failed (caller falls back to 2D). */
  ready(): boolean {
    const gl = this.gl;
    const COMPLETION_STATUS_KHR = 0x91b1;
    const still: typeof this.pending = [];
    for (const job of this.pending) {
      if (this.parallel && !gl.getProgramParameter(job.p, COMPLETION_STATUS_KHR)) {
        still.push(job);
        continue;
      }
      if (!gl.getProgramParameter(job.p, gl.LINK_STATUS)) {
        // Log only the program name: shader info logs are ours, but keep the console free of noise in prod.
        throw new RendererError(`shader_${job.name}`);
      }
      const u: Prog['u'] = {};
      const count = gl.getProgramParameter(job.p, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(job.p, i);
        if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(job.p, info.name);
      }
      gl.deleteShader(job.vs);
      gl.deleteShader(job.fs);
      this.progs[job.name] = { p: job.p, u };
    }
    this.pending = still;
    return still.length === 0;
  }

  // ---------- geometry ----------
  private buf(data: ArrayBufferView, usage: number = this.gl.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.buffers.push(b);
    return b;
  }
  private attr(loc: number, size: number, stride = 0, off = 0, div = 0): void {
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    if (div) gl.vertexAttribDivisor(loc, div);
  }
  private vao(fn: () => void): WebGLVertexArrayObject {
    const gl = this.gl;
    const v = gl.createVertexArray()!;
    gl.bindVertexArray(v);
    fn();
    gl.bindVertexArray(null);
    return v;
  }

  private buildStatic(): void {
    const gl = this.gl;
    const faces: { n: V3; c: V3[] }[] = [
      { n: [1, 0, 0], c: [[0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]] },
      { n: [-1, 0, 0], c: [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5]] },
      { n: [0, 1, 0], c: [[-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] },
      { n: [0, 0, 1], c: [[0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]] },
      { n: [0, 0, -1], c: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]] },
    ]; // prettier-ignore
    const cv: number[] = [];
    const ci: number[] = [];
    faces.forEach((f, i) => {
      for (const p of f.c) cv.push(...p, ...f.n);
      const o = i * 4;
      ci.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    const vb = this.buf(new Float32Array(cv));
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ci), gl.STATIC_DRAW);
    this.buffers.push(ib);
    this.cube = { vb, ib };
    this.vaos.water = this.vao(() => {
      this.buf(new Float32Array([-1500, -1500, 1500, -1500, -1500, 1500, 1500, -1500, 1500, 1500, -1500, 1500]));
      this.attr(0, 2);
    });
  }

  setWorld(w: World): void {
    const gl = this.gl;
    this.world = w;
    this.n = w.inst.length / INST;
    const instVB = this.buf(w.inst);
    this.vaos.bld = this.vao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cube.vb);
      this.attr(0, 3, 24, 0);
      this.attr(1, 3, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cube.ib);
      gl.bindBuffer(gl.ARRAY_BUFFER, instVB);
      for (let k = 0; k < 4; k++) this.attr(2 + k, 4, INST * 4, k * 16, 1);
    });

    // District pads: disc + skirt, per-vertex district values (birth, activity, last touch, palette).
    const pv: number[] = [];
    for (const d of w.dists) {
      const seg = Math.min(96, Math.max(24, Math.round(d.r * 3)));
      const dv = [d.birth, d.act, d.last, d.pal];
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2;
        const a1 = ((s + 1) / seg) * Math.PI * 2;
        const x0 = d.x + Math.cos(a0) * d.r;
        const z0 = d.z + Math.sin(a0) * d.r;
        const x1 = d.x + Math.cos(a1) * d.r;
        const z1 = d.z + Math.sin(a1) * d.r;
        const v = (x: number, y: number, z: number, rad: number): void => void pv.push(x, y, z, rad, d.index, ...dv);
        v(d.x, 0.25, d.z, 0), v(x0, 0.25, z0, 1), v(x1, 0.25, z1, 1);
        v(x0, 0.25, z0, 1), v(x0, -0.15, z0, 1.5), v(x1, 0.25, z1, 1);
        v(x1, 0.25, z1, 1), v(x0, -0.15, z0, 1.5), v(x1, -0.15, z1, 1.5);
      }
    }
    this.padCount = pv.length / 9;
    const padVB = this.buf(new Float32Array(pv));
    this.vaos.pad = this.vao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, padVB);
      this.attr(0, 3, 36, 0);
      this.attr(1, 2, 36, 12);
      this.attr(2, 4, 36, 20);
    });

    this.vaos.curves = w.curves.map((c) => {
      const b = this.buf(c.pts);
      return this.vao(() => {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        this.attr(0, 3, 16, 0);
        this.attr(1, 1, 16, 12);
      });
    });

    // Fireflies (decorative) and lanterns (contributors; positions updated per frame).
    const R = rng(w.seed ^ 0x5bd1);
    const fp = new Float32Array(MAX_FIRE * 3);
    const fm = new Float32Array(MAX_FIRE * 4);
    const fc = new Float32Array(MAX_FIRE * 3);
    const spread = Math.min(w.radius, 400);
    for (let i = 0; i < MAX_FIRE; i++) {
      const a = R() * Math.PI * 2;
      const r = Math.sqrt(R()) * spread;
      fp.set([Math.cos(a) * r, 0.6 + R() * 6, Math.sin(a) * r], i * 3);
      fm.set([0.16 + R() * 0.18, R(), 0, 0.55 + R() * 0.6], i * 4);
      fc.set(R() < 0.6 ? [1, 0.72, 0.38] : [0.45, 0.95, 0.85], i * 3);
    }
    this.vaos.fire = this.vao(() => {
      this.buf(fp), this.attr(0, 3);
      this.buf(fm), this.attr(1, 4);
      this.buf(fc), this.attr(2, 3);
    });
    this.lanternCount = w.lanterns.length;
    // A6: each lantern draws its head plus TRAIL fading samples of where it has been.
    const pts = this.lanternCount * (1 + TRAIL);
    const lm = new Float32Array(pts * 4);
    const lc = new Float32Array(pts * 3);
    for (let i = 0; i < this.lanternCount; i++)
      for (let k = 0; k <= TRAIL; k++) {
        const j = i * (1 + TRAIL) + k;
        lm.set([k ? 0.55 - k * 0.04 : 0.9, i / Math.max(1, this.lanternCount), 0, k ? 0.9 * (1 - k / (TRAIL + 1)) ** 1.6 : 2.2], j * 4);
        lc.set([1, 0.78, 0.45], j * 3);
      }
    this.trail = new Float32Array(this.lanternCount * TRAIL * 3);
    this.trailOut = new Float32Array(pts * 3);
    this.trailAt = 0;
    this.lanternBuf = this.buf(new Float32Array(pts * 3), gl.DYNAMIC_DRAW);
    this.vaos.lant = this.vao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lanternBuf);
      this.attr(0, 3);
      this.buf(lm), this.attr(1, 4);
      this.buf(lc), this.attr(2, 3);
    });

    // Ripples and the selection ring share the building instance buffer (A6).
    this.vaos.ripple = this.vao(() => {
      this.buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])), this.attr(0, 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, instVB);
      this.attr(2, 4, INST * 4, 0, 1);
      this.attr(3, 4, INST * 4, 16, 1);
    });

    // Hotspot beams (instance 0 is the hottest: it gets the heartbeat).
    const hd = new Float32Array(w.hot.length * 4);
    w.hot.forEach((fi, i) => hd.set([w.pos[fi * 3]!, w.pos[fi * 3 + 1]!, w.pos[fi * 3 + 2]!, w.inst[fi * INST + 5]!], i * 4));
    this.vaos.beam = this.vao(() => {
      this.buf(new Float32Array([-1, 0, 1, 0, -1, 1, 1, 0, 1, 1, -1, 1])), this.attr(0, 2);
      this.buf(hd), this.attr(1, 4, 16, 0, 1);
    });

    // Mist banks (decorative).
    const mist = new Float32Array(MAX_MIST * 4);
    for (let i = 0; i < MAX_MIST; i++) {
      const a = R() * Math.PI * 2;
      const r = Math.sqrt(R()) * spread;
      mist.set([Math.cos(a) * r, 1.2 + R() * 3.5, Math.sin(a) * r, R()], i * 4);
    }
    this.vaos.mist = this.vao(() => {
      this.buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])), this.attr(0, 2);
      this.buf(mist), this.attr(1, 4, 16, 0, 1);
    });
  }

  // ---------- render targets ----------
  private mkTex(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.hdr.i, w, h, 0, this.hdr.f, this.hdr.t, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  private mkFBO(w0: number, h0: number, depth: boolean | 'texture'): Target {
    const gl = this.gl;
    const w = Math.max(2, w0 | 0);
    const h = Math.max(2, h0 | 0);
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    const t = this.mkTex(w, h);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const rbs: WebGLRenderbuffer[] = [];
    if (depth === 'texture') {
      // Sampled by the depth-of-field pass (A6).
      const d = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, d);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, d, 0);
      return { f, t, rbs, w, h, d };
    }
    if (depth) {
      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      rbs.push(rb);
    }
    return { f, t, rbs, w, h };
  }
  private mkMS(w: number, h: number, s: number): Target | null {
    const gl = this.gl;
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    const c = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, c);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, this.hdr.i, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
    const d = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, d);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
    const t: Target = { f, t: null, rbs: [c, d], w, h };
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.free(t);
      return null;
    }
    return t;
  }
  private free(o: Target | undefined): void {
    if (!o) return;
    const gl = this.gl;
    gl.deleteFramebuffer(o.f);
    if (o.t) gl.deleteTexture(o.t);
    if (o.d) gl.deleteTexture(o.d);
    for (const rb of o.rbs) gl.deleteRenderbuffer(rb);
  }

  /** (Re)allocate render targets for a drawing-buffer size and tier. */
  alloc(w: number, h: number, tier: Tier): void {
    const gl = this.gl;
    for (const t of Object.values(this.T)) this.free(t);
    this.T = {};
    this.tier = tier;
    this.cw = w;
    this.ch = h;
    this.T['scene'] = this.mkFBO(w, h, 'texture');
    if (tier.dof) {
      this.T['dofa'] = this.mkFBO(w / 2, h / 2, false);
      this.T['dofb'] = this.mkFBO(w / 2, h / 2, false);
    }
    if (tier.msaa && this.maxSamples >= tier.msaa) {
      const ms = this.mkMS(w, h, Math.min(tier.msaa, this.maxSamples));
      if (ms) this.T['ms'] = ms;
    }
    if (tier.refl) this.T['refl'] = this.mkFBO(w * tier.refl, h * tier.refl, true);
    if (tier.bloom) {
      this.T['b1a'] = this.mkFBO(w / 4, h / 4, false);
      this.T['b1b'] = this.mkFBO(w / 4, h / 4, false);
      if (tier.bloom > 1) {
        this.T['b2a'] = this.mkFBO(w / 8, h / 8, false);
        this.T['b2b'] = this.mkFBO(w / 8, h / 8, false);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private use(name: string): Prog['u'] {
    const p = this.progs[name];
    if (!p) throw new RendererError(`program_${name}`);
    this.gl.useProgram(p.p);
    return p.u;
  }

  private drawWorld(refl: boolean, C: Camera, P: Params, time: number): void {
    const gl = this.gl;
    const w = this.world!;
    const T = this.T;
    const W2 = refl ? T['refl']!.w : this.cw;
    const H2 = refl ? T['refl']!.h : this.ch;
    gl.viewport(0, 0, W2, H2);
    gl.clearColor(FOG_COL[0], FOG_COL[1], FOG_COL[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = refl ? C.vpR : C.vp;
    const cp = refl ? C.posR : C.pos;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    let u = this.use('sky');
    gl.uniform3fv(u['uRight']!, C.right);
    gl.uniform3fv(u['uUp']!, C.up);
    gl.uniform3fv(u['uFwd']!, C.fwd);
    gl.uniform1f(u['uTanH']!, C.tanH);
    gl.uniform1f(u['uAspect']!, this.cw / this.ch);
    gl.uniform1f(u['uMirror']!, refl ? -1 : 1);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform3f(u['uSunDir']!, 0, 0, -1);
    gl.uniform3fv(u['uMoonDir']!, MOON);
    gl.uniform1f(u['uCloud']!, this.tier.cloud);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    if (!refl) {
      u = this.use('water');
      gl.uniformMatrix4fv(u['uVP']!, false, vp);
      gl.uniform3fv(u['uCam']!, cp);
      gl.uniform1f(u['uTime']!, time);
      gl.uniform1f(u['uFog']!, P.fog);
      gl.uniform3fv(u['uFogCol']!, FOG_COL);
      gl.uniform3fv(u['uMoonDir']!, MOON);
      gl.uniform3f(u['uSunDir']!, 0, 0, -1);
      gl.uniform1f(u['uCloud']!, 0);
      gl.uniform2f(u['uScr']!, this.cw, this.ch);
      gl.uniform1f(u['uHasRefl']!, T['refl'] ? 1 : 0);
      if (T['refl']) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, T['refl'].t);
        gl.uniform1i(u['uRefl']!, 0);
      }
      gl.bindVertexArray(this.vaos.water!);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    u = this.use('pad');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform3fv(u['uCam']!, cp);
    gl.uniform1f(u['uT']!, P.t);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform1f(u['uFog']!, P.fog);
    gl.uniform3fv(u['uFogCol']!, FOG_COL);
    gl.uniform3fv(u['uRim']!, RIM);
    gl.bindVertexArray(this.vaos.pad!);
    gl.drawArrays(gl.TRIANGLES, 0, this.padCount);

    u = this.use('bld');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform3fv(u['uCam']!, cp);
    gl.uniform1f(u['uT']!, P.t);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform1f(u['uFog']!, P.fog);
    gl.uniform3fv(u['uFogCol']!, FOG_COL);
    gl.uniform1f(u['uHot']!, P.hot);
    gl.uniform1f(u['uFocus']!, P.focus);
    gl.uniform1f(u['uFocusAmt']!, P.focusAmt);
    gl.uniform1f(u['uHover']!, refl ? -1 : P.hover);
    gl.uniform1f(u['uLift']!, refl ? 0 : P.lift);
    gl.uniform3fv(u['uPal']!, PAL);
    gl.uniform3fv(u['uCmp']!, refl ? [0, 0, 0] : P.cmp);
    gl.bindVertexArray(this.vaos.bld!);
    gl.drawElementsInstanced(gl.TRIANGLES, 30, gl.UNSIGNED_SHORT, 0, this.n);
    if (refl) return;

    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    u = this.use('ripple');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform1f(u['uT']!, P.t);
    gl.uniform1f(u['uSel']!, P.sel);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform1f(u['uMotion']!, P.motion);
    gl.bindVertexArray(this.vaos.ripple!);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.n);
    u = this.use('line');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform1f(u['uT']!, P.t);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform1f(u['uVis']!, 0.55 + 0.45 * P.hot);
    if (P.arcs) w.curves.forEach((c, i) => {
      gl.uniform1f(u['uBirth']!, c.birth);
      gl.uniform1f(u['uS']!, c.s);
      gl.bindVertexArray(this.vaos.curves[i]!);
      gl.drawArrays(gl.LINE_STRIP, 0, c.n);
    });
    if (w.hot.length) {
      u = this.use('beam');
      gl.uniformMatrix4fv(u['uVP']!, false, vp);
      gl.uniform3fv(u['uCam']!, cp);
      gl.uniform1f(u['uT']!, P.t);
      gl.uniform1f(u['uTime']!, time);
      gl.uniform1f(u['uHot']!, P.hot);
      gl.uniform1f(u['uBeat']!, P.motion);
      gl.bindVertexArray(this.vaos.beam!);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, w.hot.length);
    }
    u = this.use('pts');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform3fv(u['uCam']!, cp);
    gl.uniform1f(u['uTime']!, time);
    gl.uniform1f(u['uPx']!, this.ch / (2 * C.tanH));
    gl.uniform1f(u['uMotion']!, 1);
    gl.uniform1f(u['uVis']!, 1);
    gl.bindVertexArray(this.vaos.fire!);
    gl.drawArrays(gl.POINTS, 0, Math.min(this.tier.fire, MAX_FIRE));
    if (this.lanternCount && P.lanterns) {
      gl.uniform1f(u['uMotion']!, 0);
      gl.bindVertexArray(this.vaos.lant!);
      gl.drawArrays(gl.POINTS, 0, this.lanternCount * (P.motion ? 1 + TRAIL : 1));
    }
    if (this.tier.mist) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      u = this.use('mist');
      gl.uniformMatrix4fv(u['uVP']!, false, vp);
      gl.uniform3fv(u['uRight']!, C.right);
      gl.uniform3fv(u['uUp']!, C.up);
      gl.uniform3fv(u['uCam']!, cp);
      gl.uniform1f(u['uTime']!, time);
      gl.uniform3fv(u['uFogCol']!, FOG_COL);
      gl.bindVertexArray(this.vaos.mist!);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.min(this.tier.mist, MAX_MIST));
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private tri(name: string, setup: (u: Prog['u']) => void): void {
    const u = this.use(name);
    setup(u);
    this.gl.bindVertexArray(null);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  render(C: Camera, P: Params, time: number, lanterns: Float32Array | null): void {
    if (!this.world || this.isLost) return;
    const gl = this.gl;
    const T = this.T;
    if (lanterns && this.lanternBuf && this.trail) {
      // Head + trail per lantern; the trail samples positions every ~70 ms so it fades behind the lantern.
      const n = this.lanternCount;
      const tr = this.trail;
      if (time - this.trailAt > 0.07) {
        this.trailAt = time;
        for (let i = 0; i < n; i++) {
          tr.copyWithin(i * TRAIL * 3 + 3, i * TRAIL * 3, (i + 1) * TRAIL * 3 - 3);
          tr.set(lanterns.subarray(i * 3, i * 3 + 3), i * TRAIL * 3);
        }
      }
      const out = this.trailOut!;
      for (let i = 0; i < n; i++) {
        out.set(lanterns.subarray(i * 3, i * 3 + 3), i * (1 + TRAIL) * 3);
        out.set(tr.subarray(i * TRAIL * 3, (i + 1) * TRAIL * 3), i * (1 + TRAIL) * 3 + 3);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lanternBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, out);
    }
    for (let i = 2; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, i === 0 ? this.nullTex : null);
    }
    if (T['refl']) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, T['refl'].f);
      this.drawWorld(true, C, P, time);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, (T['ms'] ?? T['scene']!).f);
    this.drawWorld(false, C, P, time);
    if (T['ms']) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T['ms'].f);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T['scene']!.f);
      gl.blitFramebuffer(0, 0, this.cw, this.ch, 0, 0, this.cw, this.ch, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    const scene = T['scene']!;
    if (T['b1a'] && T['b1b']) {
      const b1a = T['b1a'];
      const b1b = T['b1b'];
      gl.bindFramebuffer(gl.FRAMEBUFFER, b1a.f);
      gl.viewport(0, 0, b1a.w, b1a.h);
      gl.bindTexture(gl.TEXTURE_2D, scene.t);
      this.tri('bright', (u) => {
        gl.uniform1i(u['uTex']!, 0);
        gl.uniform2f(u['uTexel']!, 1 / this.cw, 1 / this.ch);
        gl.uniform1f(u['uThr']!, 0.85);
      });
      const pass = (src: Target, dst: Target, dx: number, dy: number): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.t);
        this.tri('blur', (u) => {
          gl.uniform1i(u['uTex']!, 0);
          gl.uniform2f(u['uDir']!, dx / src.w, dy / src.h);
        });
      };
      pass(b1a, b1b, 1.6, 0);
      pass(b1b, b1a, 0, 1.6);
      if (T['b2a'] && T['b2b']) {
        pass(b1a, T['b2a'], 0, 0);
        pass(T['b2a'], T['b2b'], 1.6, 0);
        pass(T['b2b'], T['b2a'], 0, 1.6);
      }
    }
    // Depth of field source: a half-resolution blurred copy of the scene (wider on the high tier).
    const dofA = T['dofa'];
    const dofB = T['dofb'];
    if (dofA && dofB && P.dof > 0 && P.focusDist > 0) {
      const blurPass = (src: WebGLTexture | null, sw: number, sh: number, dst: Target, dx: number, dy: number): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src);
        this.tri('blur', (u) => {
          gl.uniform1i(u['uTex']!, 0);
          gl.uniform2f(u['uDir']!, dx / sw, dy / sh);
        });
      };
      const r = this.tier.dof > 1 ? 2.2 : 1.3;
      blurPass(scene.t, this.cw, this.ch, dofA, 0, 0);
      blurPass(dofA.t, dofA.w, dofA.h, dofB, r, 0);
      blurPass(dofB.t, dofB.w, dofB.h, dofA, 0, r);
      if (this.tier.dof > 1) {
        blurPass(dofA.t, dofA.w, dofA.h, dofB, r * 1.7, r * 0.9);
        blurPass(dofB.t, dofB.w, dofB.h, dofA, -r * 0.9, r * 1.7);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.cw, this.ch);
    const bind = (unit: number, t: WebGLTexture | null): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    };
    const dummy = (T['b2a'] ?? T['b1a'] ?? scene).t;
    bind(0, scene.t);
    bind(1, T['b1a']?.t ?? dummy);
    bind(2, (T['b2a'] ?? T['b1a'])?.t ?? dummy);
    bind(3, dofA?.t ?? dummy);
    bind(4, scene.d ?? null);
    const moon = this.moonScreen(C);
    this.tri('comp', (u) => {
      gl.uniform1i(u['uScene']!, 0);
      gl.uniform1i(u['uB1']!, 1);
      gl.uniform1i(u['uB2']!, 2);
      gl.uniform1i(u['uDof']!, 3);
      gl.uniform1i(u['uDepth']!, 4);
      gl.uniform1f(u['uDofAmt']!, dofA && P.focusDist > 0 ? P.dof : 0);
      gl.uniform1f(u['uFocusD']!, P.focusDist);
      gl.uniform1f(u['uNear']!, C.near);
      gl.uniform1f(u['uFar']!, C.far);
      gl.uniform1f(u['uFlare']!, this.tier.bloom ? this.tier.flare : 0);
      gl.uniform1f(u['uRays']!, this.tier.bloom && this.tier.flare > 1 ? 1 : 0);
      gl.uniform3fv(u['uMoon']!, moon);
      gl.uniform1f(u['uBloom']!, this.tier.bloom ? 0.9 : 0);
      gl.uniform1f(u['uB2k']!, this.tier.bloom > 1 ? 1.1 : 0);
      gl.uniform1f(u['uExp']!, P.exposure);
      gl.uniform1f(u['uFade']!, P.fade);
      gl.uniform1f(u['uTime']!, time);
      gl.uniform1f(u['uGrain']!, P.grain);
      gl.uniform1f(u['uCA']!, P.ca);
    });
    this.resolvePick();
  }

  /** Moon position in screen UV (x, y) and visibility (z), for god rays. */
  private moonScreen(C: Camera): [number, number, number] {
    const p: V3 = [C.pos[0] + MOON[0] * 800, C.pos[1] + MOON[1] * 800, C.pos[2] + MOON[2] * 800];
    const m = C.vp;
    const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
    if (w <= 0) return [0, 0, 0];
    const x = ((m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / w) * 0.5 + 0.5;
    const y = ((m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / w) * 0.5 + 0.5;
    const edge = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5));
    return [x, y, Math.max(0, Math.min(1, (0.85 - edge) / 0.35))];
  }

  // ---------- GPU picking: 1x1 ID pass under the cursor, read back without stalling ----------
  /** Resolves with the file index under canvas pixel (px, py) (drawing-buffer coords), or -1. */
  pick(C: Camera, P: Params, px: number, py: number): Promise<number> {
    const gl = this.gl;
    if (!this.world || this.isLost || !this.progs['pick']) return Promise.resolve(-1);
    if (!this.pickState) {
      const fbo = gl.createFramebuffer()!;
      const rb = gl.createRenderbuffer()!;
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const pbo = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.pickState = { fbo, rb, depth, pbo, fence: null, resolve: null };
    }
    const ps = this.pickState;
    if (ps.resolve) ps.resolve(-1); // a newer request supersedes the in-flight one
    // Narrow the projection to the single pixel under the cursor so the ID pass renders 1x1.
    const sx = this.cw;
    const sy = this.ch;
    const ndcX = ((px + 0.5) / sx) * 2 - 1;
    const ndcY = 1 - ((py + 0.5) / sy) * 2;
    const pickM = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -ndcX * sx, -ndcY * sy, 0, 1]);
    const vp = new Float32Array(16);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += pickM[k * 4 + j]! * C.vp[i * 4 + k]!;
        vp[i * 4 + j] = s;
      }
    gl.bindFramebuffer(gl.FRAMEBUFFER, ps.fbo);
    gl.viewport(0, 0, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const u = this.use('pick');
    gl.uniformMatrix4fv(u['uVP']!, false, vp);
    gl.uniform1f(u['uT']!, P.t);
    gl.bindVertexArray(this.vaos.bld!);
    gl.drawElementsInstanced(gl.TRIANGLES, 30, gl.UNSIGNED_SHORT, 0, this.n);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ps.pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (ps.fence) gl.deleteSync(ps.fence);
    ps.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve) => {
      ps.resolve = resolve;
    });
  }

  private resolvePick(): void {
    const ps = this.pickState;
    if (!ps?.resolve || !ps.fence) return;
    const gl = this.gl;
    const status = gl.clientWaitSync(ps.fence, 0, 0);
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return;
    const px = new Uint8Array(4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ps.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(ps.fence);
    ps.fence = null;
    const id = px[0]! + (px[1]! << 8) + (px[2]! << 16) - 1;
    const resolve = ps.resolve;
    ps.resolve = null;
    resolve(id >= 0 && id < this.n ? id : -1);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of Object.values(this.T)) this.free(t);
    for (const b of this.buffers) gl.deleteBuffer(b);
    for (const p of Object.values(this.progs)) gl.deleteProgram(p.p);
    this.buffers = [];
  }
}

/** Mirror a view-projection for planar water reflections. */
export const reflectVP = mirrorY;
