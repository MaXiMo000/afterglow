/**
 * Embeddable city (docs/ROADMAP.md #12), served at /embed/owner/name for other sites' iframes.
 *
 * Read-only by design, so being framed carries no clickjacking risk: it shows the newest stored analysis and never
 * starts one, has no forms and no state-changing requests. Plain wheel scrolls the host page (zoom is Ctrl+wheel,
 * pinch or +/-); rendering pauses when the frame is off screen or hidden; reduced motion stops the slow orbit.
 */
import 'virtual:tokens.css';
import './embed.css';
import { parseRepo } from './lib/repo';
import { validateResult, type Result } from './lib/result';
import { Renderer, TIERS, type Params } from './render/renderer';
import { buildCamera, OrbitCamera } from './ui/camera';
import { fmt, reducedMotion } from './ui/dom';
import { honestyLines } from './ui/table';
import { buildWorld } from './world/build';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const status = (text: string): void => void ($('status').textContent = text);

async function main(): Promise<void> {
  const m = /^\/embed\/([^/]+)\/([^/]+?)\/?$/.exec(location.pathname);
  const ref = m ? parseRepo(`${m[1]}/${m[2]}`) : null; // the same strict parser as the form
  if (!ref) return status('Not a repository address.');
  const slug = `${ref.owner}/${ref.name}`.toLowerCase();
  const open = $('open') as HTMLAnchorElement;
  open.href = `/${slug}`; // same origin, validated owner/name (SECURITY T5)
  $('repo').textContent = slug;
  document.title = `${slug} - Afterglow city`;

  let r: Result;
  try {
    const res = await fetch(`/api/v1/results/${slug}`, { credentials: 'omit' });
    if (res.status === 404) {
      $('embed').removeAttribute('aria-busy');
      return status('Not analysed on Afterglow yet. Open it to build the city.');
    }
    if (!res.ok) throw new Error(String(res.status));
    r = validateResult(await res.json());
  } catch {
    $('embed').removeAttribute('aria-busy');
    return status('The city could not be loaded right now.');
  }
  $('note').textContent = [`${fmt(r.meta.files)} files · ${fmt(r.meta.commits)} commits · at ${r.meta.sha.slice(0, 7)}`, ...honestyLines(r).filter((l) => !l.startsWith('Bus'))].join(' · ');
  $('embed').removeAttribute('aria-busy');

  const canvas = $('gl') as HTMLCanvasElement;
  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch {
    // No WebGL2: the badge skyline is the 2D fallback (the link above still opens the full city).
    canvas.hidden = true;
    const img = $('fallback') as HTMLImageElement;
    img.src = `/api/v1/badges/${slug}.svg`;
    img.alt = `Skyline of ${slug}`;
    img.hidden = false;
    return;
  }
  const world = buildWorld(r);
  renderer.setWorld(world);
  const cam = new OrbitCamera();
  cam.frame(world.radius);
  cam.snap();
  const low = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
  const tier = TIERS[low ? 0 : 1]!; // a guest on someone else's page: never the cinematic tier
  const P: Params = {
    t: 1, fog: 0.0072, hot: 1, focus: -1, focusAmt: 0, hover: -1, fade: 0, exposure: 1, grain: 0.03, ca: 1,
    arcs: 1, lanterns: 0, cmp: [0, 0, 0], lift: 0, sel: -1, focusDist: 0, dof: 0, motion: 1, flow: 0, types: 0, weather: 0, risk: 0, pr: 0,
  }; // prettier-ignore

  const size = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, tier.dpr);
    cam.fit = Math.min(2.2, Math.max(1, 1.25 / (canvas.clientWidth / Math.max(1, canvas.clientHeight))));
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      renderer.alloc(w, h, tier);
    }
  };
  size();
  new ResizeObserver(size).observe(canvas);

  // Input: drag turns the city; Ctrl+wheel (trackpad pinch) and +/- zoom; arrows turn. Plain wheel is the page's.
  let drag: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, t: performance.now() };
    cam.autoOrbit = false;
    cam.still();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const now = performance.now();
    cam.orbit(e.clientX - drag.x, e.clientY - drag.y, Math.max(1, now - drag.t) / 1000);
    drag = { x: e.clientX, y: e.clientY, t: now };
  });
  const up = (): void => void (drag = null);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      cam.zoom(Math.exp(e.deltaY * 0.01));
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') cam.orbit(k === 'ArrowLeft' ? -40 : 40, 0);
    else if (k === 'ArrowUp' || k === 'ArrowDown') cam.orbit(0, k === 'ArrowUp' ? 30 : -30);
    else if (k === '+' || k === '=' || k === '-') cam.zoom(k === '-' ? 1.15 : 1 / 1.15);
    else return;
    e.preventDefault();
    cam.autoOrbit = false;
  });

  // Render only while visible (a guest should not burn the host page's battery), at most 30 fps.
  let visible = true;
  new IntersectionObserver((es) => void (visible = es.some((x) => x.isIntersecting))).observe(canvas);
  cam.autoOrbit = !reducedMotion();
  let last = performance.now();
  let time = 0;
  let ready = false;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (!visible || document.hidden || now - last < 1000 / 30 - 2) return;
    if (!ready && !(ready = renderer.ready())) return; // shaders compile in the background (parallel compile)
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const reduced = reducedMotion();
    P.motion = reduced ? 0 : 1;
    P.grain = reduced ? 0 : 0.03;
    P.fade = Math.min(1, time / 1.2);
    cam.update(dt, reduced);
    const { pos, tgt } = cam.pose();
    const C = buildCamera(pos, tgt, canvas.clientWidth, canvas.clientHeight, Math.max(1200, world.radius * 6), 50);
    renderer.render(C, P, time, null);
  };
  requestAnimationFrame(frame);
  canvas.setAttribute('aria-label', `3D city of ${slug}: ${fmt(r.meta.files)} files in ${fmt(r.dirs.length)} districts. Drag or use the arrow keys to turn it; Ctrl and the wheel, or + and -, to zoom.`);
}

void main();
