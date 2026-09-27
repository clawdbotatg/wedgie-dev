// The wedgie in 3D: the real printed case (clawd-pico-case, public/3d/ from tools/case3d.py) in
// plastic, held landscape like the device. It leans a little toward the pointer and its shadow moves
// with it; it doesn't spin. Caps press when clicked, the joystick goes the way you push it, and the
// screen is a live texture (the virtual wedgie's canvas). Loaded only when shown (three.js is big).
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Part = { name: string; verts: number; tris: number; lo: number[]; hi: number[]; pos: number; idx: number; wide: boolean };
type Geo = { parts: Part[]; glass: { cx: number; cy: number; w: number; h: number; z: number } };

export type Wedgie3DOptions = {
  onKey?: (key: string, down: boolean) => void;
  /** false: just a picture of a wedgie (clicks go to whatever holds it). Default true. */
  interactive?: boolean;
  screen?: HTMLCanvasElement | string;
  screens?: string[];
  /** Which way it swings as it scrolls past: 1 or -1. */
  side?: number;
  /** Fly in when the page shows: tumbles at you from tiny, overshoots, sticks, wobbles back. */
  intro?: boolean;
};

export type Wedgie3D = {
  /** A live canvas (redrawn every frame), a picture URL (e.g. /screens/launcher.png), or off. */
  setScreen(src: HTMLCanvasElement | string | null): void;
  /** Cycle through pictures, one every `ms`. */
  setScreens(urls: string[], ms?: number): void;
  setBacklight(v: number): void;
  keyVisual(key: string, down: boolean): void;
  destroy(): void;
};

// Printed colors, in the site's palette: white lid, black base, green A, grey B X and joystick, red Y.
// A and Y match the 1 and 3 badges (the site's green and red fills), not neon
export const COLORS: Record<string, number> = { lid: 0xf3f2ee, base: 0x1c1c1e, A: 0x278c3c, B: 0x6c6d71, X: 0x6c6d71, Y: 0xb3302a, joystick: 0x75767a };
const KEYS = ["A", "B", "X", "Y"];
const STICK = { x: 13.17, y: 46.13 };          // joystick centre in case mm
const ACTIVE = 23.4;                            // 1.3" 240x240 active area, mm

let geoP: Promise<{ meta: Geo; bin: ArrayBuffer }> | null = null;
export function loadGeo() {
  if (!geoP) geoP = Promise.all([fetch("/3d/wedgie.json").then((r) => r.json()), fetch("/3d/wedgie.bin").then((r) => r.arrayBuffer())])
    .then(([meta, bin]) => ({ meta, bin }));
  return geoP;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
export function partGeometry(p: Part, bin: ArrayBuffer) {
  let g = geoCache.get(p.name);
  if (!g) { g = buildGeometry(p, bin); geoCache.set(p.name, g); }   // shared by every wedgie on the page
  return g;
}
function buildGeometry(p: Part, bin: ArrayBuffer) {
  const q = new Uint16Array(bin, p.pos, p.verts * 3);
  const pos = new Float32Array(p.verts * 3);
  for (let i = 0; i < pos.length; i++) { const a = i % 3; pos[i] = p.lo[a] + (q[i] / 65535) * (p.hi[a] - p.lo[a]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(p.wide ? new Uint32Array(bin, p.idx, p.tris * 3) : new Uint16Array(bin, p.idx, p.tris * 3), 1));
  return toCreasedNormals(g, (35 * Math.PI) / 180);    // smooth curves, crisp printed edges
}

export async function mountWedgie3D(el: HTMLElement, opts: Wedgie3DOptions = {}): Promise<Wedgie3D> {
  const interactive = opts.interactive !== false;
  const side = opts.side ?? 1;
  const { meta, bin } = await loadGeo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const cv = renderer.domElement;
  cv.className = "w3d";
  if (interactive) {
    cv.tabIndex = 0;
    cv.setAttribute("aria-label", "a wedgie: click its buttons, or use the arrow keys, Enter, and A B X Y");
  } else {
    cv.style.pointerEvents = "none";
    cv.setAttribute("aria-hidden", "true");
  }
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(22, 1, 10, 2000);
  camera.position.set(0, -20, 128);        // close: the wedgie fills its frame
  camera.lookAt(0, -1.5, 0);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-35, 45, 160);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 14;
  key.shadow.blurSamples = 16;
  Object.assign(key.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 400 });
  key.shadow.bias = -0.0005;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b9b3, 0.55));

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.16 }));
  floor.position.z = -18;
  floor.receiveShadow = true;
  scene.add(floor);

  // The device: case mm, centred, turned landscape (joystick end to the left, A at the top).
  const tilt = new THREE.Group();
  const dev = new THREE.Group();
  dev.rotation.z = Math.PI / 2;
  dev.position.set(0, 0, 8);
  tilt.add(dev);
  scene.add(tilt);
  const inner = new THREE.Group();
  inner.position.set(-13.22, -26, 0);
  dev.add(inner);

  const meshes = new Map<string, THREE.Mesh>();
  for (const p of meta.parts) {
    if (p.name === "hat" || p.name === "pico") continue;   // the boards: only the assembly shows them
    const m = new THREE.Mesh(partGeometry(p, bin), new THREE.MeshPhysicalMaterial({
      color: COLORS[p.name] ?? 0xcccccc, roughness: p.name === "base" ? 0.55 : KEYS.includes(p.name) ? 0.85 : 0.5, specularIntensity: KEYS.includes(p.name) ? 0.25 : 1,
      clearcoat: KEYS.includes(p.name) ? 0 : 0.2, clearcoatRoughness: 0.5, envMapIntensity: KEYS.includes(p.name) ? 0.45 : 1,   // caps: matte printed PETG, no hot glare
    }));
    m.castShadow = true; m.receiveShadow = true;
    m.name = p.name;
    if (p.name === "joystick") {
      // pivot the cap at its base so it can lean the way it's pushed
      const piv = new THREE.Group();
      piv.position.set(STICK.x, STICK.y, 2.05);
      m.position.set(-STICK.x, -STICK.y, -2.05);
      piv.add(m);
      piv.name = "joypivot";
      inner.add(piv);
    } else inner.add(m);
    meshes.set(p.name, m);
  }
  // A dark inside, so the port and holes don't show daylight through the case.
  const core = new THREE.Mesh(new THREE.BoxGeometry(28, 54, 14), new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 1 }));
  core.position.set(13.2, 26, -9);
  inner.add(core);

  // Screen: dark glass, and the live display on it.
  const G = meta.glass;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(G.w, G.h), new THREE.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 }));
  glass.position.set(G.cx, G.cy, G.z + 0.02);
  inner.add(glass);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, transparent: true, opacity: 1 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(ACTIVE, ACTIVE), screenMat);
  screen.position.set(G.cx, G.cy, G.z + 0.05);
  screen.rotation.z = -Math.PI / 2;          // image right = case -y, image up = case +x
  inner.add(screen);
  let tex: THREE.Texture | null = null;
  let live = false;          // a canvas that keeps changing (vs a still picture)
  let backlight = 1;
  const loader = new THREE.TextureLoader();
  const pics = new Map<string, THREE.Texture>();
  const picture = (url: string) => {
    let t = pics.get(url);
    if (!t) {
      t = loader.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;          // crisp pixels, like the real panel
      t.anisotropy = 4;
      pics.set(url, t);
    }
    return t;
  };
  function useScreen(src: HTMLCanvasElement | string | null) {
    if (tex && live) tex.dispose();
    live = src instanceof HTMLCanvasElement;
    tex = !src ? null : live ? new THREE.CanvasTexture(src as HTMLCanvasElement) : picture(src as string);
    if (tex && live) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; }
    screenMat.map = tex; screenMat.color.set(tex ? 0xffffff : 0x000000); screenMat.needsUpdate = true;
  }
  let cycle = 0;
  function useScreens(urls: string[], ms = 2600) {
    clearInterval(cycle);
    let i = 0;
    useScreen(urls[0] || null);
    urls.forEach(picture);
    if (urls.length > 1) cycle = window.setInterval(() => { i = (i + 1) % urls.length; useScreen(urls[i]); }, ms);
  }
  if (opts.screens) useScreens(opts.screens); else if (opts.screen) useScreen(opts.screen);

  // ---- sizing, pointer lean, render loop --------------------------------------------------------
  let W = 0, H = 0;
  const resize = () => {
    W = el.clientWidth; H = Math.round(W * 0.62);
    renderer.setSize(W, H, false);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    camera.aspect = W / H; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  const aim = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    aim.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
    aim.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
  };
  addEventListener("pointermove", onMove);

  const pressed = new Map<string, boolean>();
  const vel = new Map<string, number>();
  let visible = true, raf = 0, dead = false;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); });
  io.observe(cv);
  const t0 = performance.now();
  let scroll = 0;
  // intro: -1 = waiting for the page to show, then seconds since it did; done after INTRO seconds
  const GROW = 1.6, INTRO = 2.1;
  let introStart = opts.intro ? -1 : 0, introT = opts.intro ? 0 : INTRO;
  function loop() {
    cancelAnimationFrame(raf);
    if (dead || !visible || document.hidden) return;
    raf = requestAnimationFrame(loop);
    const t = (performance.now() - t0) / 1000;
    cur.x += (aim.x - cur.x) * 0.06; cur.y += (aim.y - cur.y) * 0.06;
    // Lean as it scrolls past (-1 entering at the bottom, +1 leaving at the top), and toward the pointer.
    const r = cv.getBoundingClientRect();
    const sc = Math.max(-1.2, Math.min(1.2, (r.top + r.height / 2 - innerHeight / 2) / (innerHeight / 2)));
    scroll += (sc - scroll) * 0.12;
    tilt.rotation.y = cur.x * 0.12 + scroll * 0.22 * side + Math.sin(t * 0.6 + side) * 0.012;
    tilt.rotation.x = -0.05 + cur.y * 0.08 + scroll * 0.28 + Math.sin(t * 0.45) * 0.01;
    tilt.rotation.z = 0;
    if (introT < INTRO) {
      if (introStart < 0 && document.documentElement.classList.contains("ready")) introStart = performance.now();
      introT = introStart < 0 ? 0 : (performance.now() - introStart) / 1000;
      // grow from 1% over GROW s with a small overshoot (~106%); tumble only while small, so it's
      // steady by the time it's full size; then a tiny settle.
      const g = Math.pow(Math.min(1, introT / GROW), 1.35), c = 1.3, x = g - 1;        // slow start
      const size = 0.01 + 0.99 * (1 + (c + 1) * x * x * x + c * x * x);                // easeOutBack: ~105% then 100%
      tilt.scale.setScalar(size);
      const spin = Math.pow(Math.max(0, 1 - size), 1.6);                                // spins only while small
      tilt.rotation.x += spin * Math.PI * 3;
      tilt.rotation.y += spin * Math.PI * 1.2;
      const w = Math.max(0, introT - GROW);
      tilt.rotation.z += introT > GROW ? 0.05 * Math.exp(-6 * w) * Math.sin(12 * w) : 0;
      if (introT >= INTRO) tilt.scale.setScalar(1);
    }
    for (const k of KEYS) {
      // a spring: snaps down ~1.8 mm when pressed, pops back up with a little overshoot
      const m = meshes.get(k)!; const want = pressed.get(k) ? -1.8 : 0;
      const v = (vel.get(k) || 0) * 0.55 + (want - m.position.z) * 0.38;
      vel.set(k, v);
      m.position.z += v;
    }
    if (tex && live) tex.needsUpdate = true;
    screenMat.opacity = tex ? Math.max(0.02, backlight) : 1;
    renderer.render(scene, camera);
  }
  document.addEventListener("visibilitychange", loop);
  loop();

  // ---- pressing it --------------------------------------------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const targets = [...KEYS.map((k) => meshes.get(k)!), meshes.get("joystick")!];
  const pointers = new Map<number, string>();
  const joyPiv = inner.getObjectByName("joypivot")!;
  function hit(e: PointerEvent): string | null {
    const r = cv.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(targets, false)[0];
    if (!h) return null;
    if (h.object.name !== "joystick") return h.object.name;
    // The stick is tall and seen at an angle, so read the push in screen space: where you clicked
    // against where the top of the stick shows. Near the middle = press straight down.
    const top = new THREE.Vector3(STICK.x, STICK.y, 9).applyMatrix4(inner.matrixWorld).project(camera);
    const edge = new THREE.Vector3(STICK.x + 5, STICK.y, 9).applyMatrix4(inner.matrixWorld).project(camera);
    const px = (v: THREE.Vector3) => [(v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height];
    const [tx, ty] = px(top), [ex, ey] = px(edge);
    const dx = e.clientX - r.left - tx, dy = e.clientY - r.top - ty;
    if (Math.hypot(dx, dy) < Math.hypot(ex - tx, ey - ty) * 0.35) return "press";
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  }
  function visual(k: string, down: boolean) {
    if (KEYS.includes(k)) pressed.set(k, down);
    else {
      const lean = 0.18;          // more and the cap's flange swings up through the lid
      joyPiv.rotation.set(0, 0, 0);
      if (down) {
        if (k === "up") joyPiv.rotation.y = lean; if (k === "down") joyPiv.rotation.y = -lean;
        if (k === "left") joyPiv.rotation.x = -lean; if (k === "right") joyPiv.rotation.x = lean;
        if (k === "press") joyPiv.position.z = 2.05 - 0.6; else joyPiv.position.z = 2.05;
      } else joyPiv.position.z = 2.05;
    }
  }
  const set = (k: string, down: boolean) => { visual(k, down); opts.onKey?.(k, down); };
  if (interactive) wire();
  function wire() {
  // Buttons: down on press, up on release. The joystick: a click pushes it in (press); a drag tilts it
  // the way you drag and holds that direction (and can swing round to another) until you let go.
  const JOY = new Set(["up", "down", "left", "right", "press"]);
  const sticks = new Map<number, { x: number; y: number; dir: string | null }>();
  cv.addEventListener("pointerdown", (e) => {
    if (introT < INTRO) return;              // still flying in
    const k = hit(e);
    cv.focus({ preventScroll: true });
    if (!k) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    if (JOY.has(k)) { sticks.set(e.pointerId, { x: e.clientX, y: e.clientY, dir: null }); cv.style.cursor = "grabbing"; return; }
    pointers.set(e.pointerId, k);
    set(k, true);
  });
  const up = (e: PointerEvent) => {
    const st = sticks.get(e.pointerId);
    if (st) {
      sticks.delete(e.pointerId);
      if (st.dir) set(st.dir, false);
      else { set("press", true); setTimeout(() => set("press", false), 140); }     // a click: push it in
      return;
    }
    const k = pointers.get(e.pointerId); if (k) { pointers.delete(e.pointerId); set(k, false); }
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointermove", (e) => {
    const st = sticks.get(e.pointerId);
    if (st) {
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      const dir = Math.hypot(dx, dy) < 10 ? st.dir : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      if (dir !== st.dir) { if (st.dir) set(st.dir, false); if (dir) set(dir, true); st.dir = dir; }
      return;
    }
    if (e.pointerType === "mouse") cv.style.cursor = hit(e) ? (JOY.has(hit(e)!) ? "grab" : "pointer") : "default";
  });
  const KEYMAP: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "press", " ": "press",
    a: "A", b: "B", x: "X", y: "Y", A: "A", B: "B", X: "X", Y: "Y" };
  const held = new Set<string>();
  cv.addEventListener("keydown", (e) => { const k = KEYMAP[e.key]; if (!k) return; e.preventDefault(); if (!held.has(k)) { held.add(k); set(k, true); } });
  cv.addEventListener("keyup", (e) => { const k = KEYMAP[e.key]; if (k && held.delete(k)) set(k, false); });
  cv.addEventListener("blur", () => { for (const k of held) set(k, false); held.clear(); });
  }

  return {
    setScreen(src) { clearInterval(cycle); useScreen(src); },
    setScreens: useScreens,
    setBacklight(v) { backlight = v; },
    keyVisual: visual,
    destroy() {
      dead = true; cancelAnimationFrame(raf); clearInterval(cycle); ro.disconnect(); io.disconnect();
      removeEventListener("pointermove", onMove); document.removeEventListener("visibilitychange", loop);
      renderer.dispose(); pmrem.dispose(); cv.remove();
    },
  };
}
