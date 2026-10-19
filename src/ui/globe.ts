// "Wedgies around the world" (home.ts #world): a flat-drawn globe, each approved build an underwear pin.
// Drag to turn it (on a phone: sideways; up and down still scrolls the page). It turns by itself when left alone.
// Land: public/geo/land.json (tools/land.mjs), drawn once into the sphere's texture. Pins are HTML over the canvas.
import * as THREE from "three";
import { P } from "./palette";

export type Build = { id: string; name: string; place: string; stage: string; note: string; link: string; lat: number; lon: number; at: string };
export type Globe = {
  setBuilds(b: Build[]): void;
  select(id: string | null): void;
  /** Taps on the globe pick a place (cb), and a dashed pin marks it, till place(null). */
  place(cb: ((lat: number, lon: number) => void) | null): void;
  mark(lat: number, lon: number): void;
};

const OCEAN = "#dfe0db", LAND = P.WHITE, EDGE = "#c4c5c0", GRID = "#d3d4cf";
const VIEW = 1.16;                      // the orthographic camera's half-size: the globe and a rim for the pins
const D = Math.PI / 180;

/** The pin: white briefs with the waistband's three stripes (the favicon's underwear). */
export const UNDIES = `<svg viewBox="0 0 32 26" aria-hidden="true"><path d="M2.5 2.5h27v6.2c-6.2 1.6-9.6 6.6-10.6 14.8h-5.8C12.1 15.3 8.7 10.3 2.5 8.7z" fill="#fefefe" stroke="#1a1b1a" stroke-width="1.6" stroke-linejoin="round"/><rect x="3.3" y="3.3" width="25.4" height="1.7" fill="#22c452"/><rect x="3.3" y="5" width="25.4" height="1.3" fill="#a9aaab"/><rect x="3.3" y="6.3" width="25.4" height="1.7" fill="#e3312c"/></svg>`;

// Where (lat, lon) sits on three's sphere (its u = 0 seam is lon -180).
const at = (lat: number, lon: number) =>
  new THREE.Vector3(Math.cos(lat * D) * Math.cos(lon * D), Math.sin(lat * D), -Math.cos(lat * D) * Math.sin(lon * D));

async function landTexture(): Promise<HTMLCanvasElement> {
  const W = 2048, H = 1024, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = OCEAN; g.fillRect(0, 0, W, H);
  g.strokeStyle = GRID; g.lineWidth = 2;
  for (let l = -150; l <= 180; l += 30) { const x = (l + 180) / 360 * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let l = -60; l <= 60; l += 30) { const y = (90 - l) / 180 * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const rings: number[][] = await fetch("/geo/land.json").then((r) => r.json());
  g.fillStyle = LAND; g.strokeStyle = EDGE; g.lineWidth = 2.5; g.lineJoin = "round";
  for (const r of rings) {
    // Unwrapped across the date line, then drawn three times over so whatever spills past an edge comes in the other.
    const pts: [number, number][] = [];
    for (let i = 0; i < r.length; i += 2) {
      let lon = r[i] / 10;
      if (pts.length) { const p = pts[pts.length - 1][0]; while (lon - p > 180) lon -= 360; while (lon - p < -180) lon += 360; }
      pts.push([lon, r[i + 1] / 10]);
    }
    const turn = pts[pts.length - 1][0] - pts[0][0];
    if (Math.abs(turn) > 300) { const s = pts[0][1] < 0 ? -90 : 90; pts.push([pts[pts.length - 1][0], s], [pts[0][0], s]); }   // Antarctica: round the pole
    for (const off of [-360, 0, 360]) {
      g.beginPath();
      pts.forEach(([lon, lat], i) => { const x = (lon + off + 180) / 360 * W, y = (90 - lat) / 180 * H; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill(); g.stroke();
    }
  }
  // The prime meridian wears green and red, the equator two greys (the buttons).
  g.globalAlpha = .75;
  g.fillStyle = P.GREEN; g.fillRect(W / 2 - 6, 0, 5, H);
  g.fillStyle = P.RED; g.fillRect(W / 2 + 1, 0, 5, H);
  g.fillStyle = P.GREY; g.fillRect(0, H / 2 - 6, W, 4); g.fillRect(0, H / 2 + 2, W, 4);
  g.globalAlpha = 1;
  return c;
}

export async function mountGlobe(box: HTMLElement, onPick: (b: Build | null) => void): Promise<Globe> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = "globe-gl";
  const pinsEl = document.createElement("div");
  pinsEl.className = "globe-pins";
  box.append(canvas, pinsEl);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 10);
  camera.position.z = 3;
  const tex = new THREE.CanvasTexture(await landTexture());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const earth = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshBasicMaterial({ map: tex }));
  earth.add(ball);
  scene.add(earth);

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let yaw = -(-40 + 90) * D, pitch = 22 * D, spin = still ? 0 : 0.06, vYaw = 0;   // starts on the Atlantic
  let goal: { yaw: number; pitch: number } | null = null;
  let size = 0, shown = false, raf = 0, hover = false;
  let builds: Build[] = [], pins: { b: Build; el: HTMLButtonElement; v: THREE.Vector3 }[] = [], sel: string | null = null;
  let placing: ((lat: number, lon: number) => void) | null = null;
  const markEl = document.createElement("div");
  markEl.className = "globe-pin globe-mark";
  markEl.innerHTML = UNDIES;
  markEl.hidden = true;
  pinsEl.append(markEl);
  let markV: THREE.Vector3 | null = null;

  const resize = () => {
    size = box.clientWidth;
    renderer.setSize(size, size, false);
    canvas.style.width = canvas.style.height = size + "px";
    kick();
  };
  new ResizeObserver(resize).observe(box);

  const w = new THREE.Vector3();
  const put = (el: HTMLElement, v: THREE.Vector3, lift = 0) => {
    w.copy(v).applyMatrix4(earth.matrixWorld);
    const vis = Math.max(0, Math.min(1, (w.z - 0.02) / 0.2));
    el.style.opacity = String(vis);
    el.style.pointerEvents = vis > 0.5 ? "" : "none";
    if (!vis) return;
    const x = (w.x / VIEW + 1) / 2 * size, y = (1 - w.y / VIEW) / 2 * size, s = 0.7 + 0.3 * w.z;
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%) scale(${(s + lift).toFixed(3)})`;
    el.style.zIndex = String(Math.round(w.z * 100) + (lift ? 1000 : 0));
  };

  let last = 0;
  const frame = (t: number) => {
    raf = 0;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (goal) {
      let d = goal.yaw - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += d * Math.min(1, dt * 5); pitch += (goal.pitch - pitch) * Math.min(1, dt * 5);
      if (Math.abs(d) < 0.002 && Math.abs(goal.pitch - pitch) < 0.002) goal = null;
    } else if (!drag) {
      yaw += vYaw * dt * 60;
      vYaw *= Math.pow(0.9, dt * 60);
      if (Math.abs(vYaw) < 0.0004) vYaw = 0;
      if (!vYaw && !sel && !hover && !placing) yaw += spin * dt;
    }
    earth.rotation.set(pitch, yaw, 0);
    earth.updateMatrixWorld();
    renderer.render(scene, camera);
    for (const p of pins) put(p.el, p.v, p.b.id === sel ? 0.45 : 0);
    if (markV) put(markEl, markV, 0.3);
    if (shown && (spin || goal || vYaw || drag)) raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!raf && shown) { last = 0; raf = requestAnimationFrame(frame); } };
  new IntersectionObserver((es) => { shown = es.some((e) => e.isIntersecting); kick(); }).observe(box);
  // Scrolling the page turns it a little, as if it rolled along.
  let lastY = scrollY;
  addEventListener("scroll", () => {
    const dy = scrollY - lastY;
    lastY = scrollY;
    if (!shown || still || drag || goal) return;
    yaw += dy * 0.0025;
    kick();
  }, { passive: true });

  // Dragging: sideways turns it, up and down tilts it (a mouse; a finger's up and down scrolls the page).
  let drag: { x: number; y: number; id: number; moved: boolean; t: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, t: performance.now() };
    goal = null; vYaw = 0;
    canvas.setPointerCapture(e.pointerId);
    kick();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    const k = 2.2 / Math.max(200, size);
    yaw += dx * k;
    vYaw = dx * k * 0.6;
    if (e.pointerType === "mouse") pitch = Math.max(-1.1, Math.min(1.1, pitch + dy * k));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = !drag.moved;
    drag = null;
    if (tap) { vYaw = 0; tapAt(e); }
    kick();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.id) { drag = null; kick(); } });
  box.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hover = true; });
  box.addEventListener("pointerleave", () => { hover = false; kick(); });

  const ray = new THREE.Raycaster();
  function tapAt(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height * 2 - 1)), camera);
    const hit = ray.intersectObject(ball)[0];
    if (!hit) return;
    if (!placing) { if (sel) { sel = null; onPick(null); } return; }
    const p = earth.worldToLocal(hit.point.clone()).normalize();
    const lat = Math.round(Math.asin(p.y) / D * 4) / 4, lon = Math.round(Math.atan2(-p.z, p.x) / D * 4) / 4;   // quarter degrees: about 25 km, never a house
    g.mark(lat, lon);
    placing(lat, lon);
  }
  const face = (lat: number, lon: number) => { goal = { yaw: -(lon + 90) * D, pitch: Math.max(-1.1, Math.min(1.1, lat * D)) }; kick(); };

  const g: Globe = {
    setBuilds(list) {
      builds = list;
      for (const p of pins) p.el.remove();
      pins = builds.map((b) => {
        const el = document.createElement("button");
        el.className = "globe-pin";
        el.innerHTML = UNDIES;
        el.setAttribute("aria-label", b.name + (b.place ? ", " + b.place : ""));
        el.onclick = () => { g.select(b.id); onPick(b); };
        pinsEl.append(el);
        return { b, el, v: at(b.lat, b.lon) };
      });
      kick();
    },
    select(id) {
      sel = id;
      pins.forEach((p) => p.el.classList.toggle("on", p.b.id === id));
      const b = builds.find((x) => x.id === id);
      if (b) face(b.lat, b.lon);
      kick();
    },
    place(cb) {
      placing = cb;
      box.classList.toggle("placing", !!cb);
      if (!cb) { markV = null; markEl.hidden = true; }
      kick();
    },
    mark(lat, lon) {
      markV = at(lat, lon);
      markEl.hidden = false;
      face(lat, lon);
    },
  };
  resize();
  return g;
}
