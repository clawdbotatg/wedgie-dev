// The wedgie in 3D: the real printed case (clawd-pico-case, public/3d/ from tools/case3d.py) in
// plastic, held landscape like the device. It leans a little toward the pointer and its shadow moves
// with it; it doesn't spin. Caps press when clicked, the joystick goes the way you push it, and the
// screen is a live texture (the virtual wedgie's canvas). Loaded only when shown (three.js is big).
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Part = { name: string; verts: number; tris: number; lo: number[]; hi: number[]; pos: number; idx: number; wide: boolean };
type Geo = { parts: Part[]; glass: { cx: number; cy: number; w: number; h: number; z: number } };

export type Wedgie3D = {
  setScreen(canvas: HTMLCanvasElement | null): void;
  setBacklight(v: number): void;
  keyVisual(key: string, down: boolean): void;
  destroy(): void;
};

// Printed colors, in the site's palette: white lid, black base, green A, grey B X and joystick, red Y.
const COLORS: Record<string, number> = { lid: 0xf3f2ee, base: 0x1c1c1e, A: 0x2dbd57, B: 0x75767a, X: 0x75767a, Y: 0xdf342e, joystick: 0x75767a };
const KEYS = ["A", "B", "X", "Y"];
const STICK = { x: 13.17, y: 46.13 };          // joystick centre in case mm
const ACTIVE = 23.4;                            // 1.3" 240x240 active area, mm

let geoP: Promise<{ meta: Geo; bin: ArrayBuffer }> | null = null;
function loadGeo() {
  if (!geoP) geoP = Promise.all([fetch("/3d/wedgie.json").then((r) => r.json()), fetch("/3d/wedgie.bin").then((r) => r.arrayBuffer())])
    .then(([meta, bin]) => ({ meta, bin }));
  return geoP;
}

function partGeometry(p: Part, bin: ArrayBuffer) {
  const q = new Uint16Array(bin, p.pos, p.verts * 3);
  const pos = new Float32Array(p.verts * 3);
  for (let i = 0; i < pos.length; i++) { const a = i % 3; pos[i] = p.lo[a] + (q[i] / 65535) * (p.hi[a] - p.lo[a]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(p.wide ? new Uint32Array(bin, p.idx, p.tris * 3) : new Uint16Array(bin, p.idx, p.tris * 3), 1));
  return toCreasedNormals(g, (35 * Math.PI) / 180);    // smooth curves, crisp printed edges
}

export async function mountWedgie3D(el: HTMLElement, opts: { onKey?: (key: string, down: boolean) => void } = {}): Promise<Wedgie3D> {
  const { meta, bin } = await loadGeo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const cv = renderer.domElement;
  cv.className = "w3d";
  cv.tabIndex = 0;
  cv.setAttribute("aria-label", "a wedgie: click its buttons, or use the arrow keys, Enter, and A B X Y");
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(22, 1, 10, 2000);
  camera.position.set(0, -26, 190);
  camera.lookAt(0, -2, 0);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-35, 45, 160);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 14;
  key.shadow.blurSamples = 16;
  Object.assign(key.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 400 });
  key.shadow.bias = -0.0005;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b9b3, 0.35));

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
    const m = new THREE.Mesh(partGeometry(p, bin), new THREE.MeshPhysicalMaterial({
      color: COLORS[p.name] ?? 0xcccccc, roughness: p.name === "base" ? 0.55 : 0.5, clearcoat: 0.2, clearcoatRoughness: 0.5,
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
  let tex: THREE.CanvasTexture | null = null;
  let backlight = 0;

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
  let visible = true, raf = 0, dead = false;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); });
  io.observe(cv);
  const t0 = performance.now();
  function loop() {
    cancelAnimationFrame(raf);
    if (dead || !visible || document.hidden) return;
    raf = requestAnimationFrame(loop);
    const t = (performance.now() - t0) / 1000;
    cur.x += (aim.x - cur.x) * 0.06; cur.y += (aim.y - cur.y) * 0.06;
    tilt.rotation.y = cur.x * 0.14 + Math.sin(t * 0.6) * 0.012;
    tilt.rotation.x = -0.05 + cur.y * 0.1 + Math.sin(t * 0.45) * 0.01;
    for (const k of KEYS) {
      const m = meshes.get(k)!; const want = pressed.get(k) ? -0.45 : 0;
      m.position.z += (want - m.position.z) * 0.5;
    }
    if (tex) tex.needsUpdate = true;
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
    const p = inner.worldToLocal(h.point.clone());
    const dx = p.x - STICK.x, dy = p.y - STICK.y;           // case mm: +x is up on screen, +y is left
    if (Math.hypot(dx, dy) < 1.8) return "press";
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "up" : "down") : (dy > 0 ? "left" : "right");
  }
  function visual(k: string, down: boolean) {
    if (KEYS.includes(k)) pressed.set(k, down);
    else {
      const lean = 0.28;
      joyPiv.rotation.set(0, 0, 0);
      if (down) {
        if (k === "up") joyPiv.rotation.y = lean; if (k === "down") joyPiv.rotation.y = -lean;
        if (k === "left") joyPiv.rotation.x = -lean; if (k === "right") joyPiv.rotation.x = lean;
        if (k === "press") joyPiv.position.z = 2.05 - 0.4; else joyPiv.position.z = 2.05;
      } else joyPiv.position.z = 2.05;
    }
  }
  const set = (k: string, down: boolean) => { visual(k, down); opts.onKey?.(k, down); };
  cv.addEventListener("pointerdown", (e) => {
    const k = hit(e);
    cv.focus({ preventScroll: true });
    if (!k) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, k);
    set(k, true);
  });
  const up = (e: PointerEvent) => { const k = pointers.get(e.pointerId); if (k) { pointers.delete(e.pointerId); set(k, false); } };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointermove", (e) => { cv.style.cursor = hit(e) ? "pointer" : "default"; });
  const KEYMAP: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "press", " ": "press",
    a: "A", b: "B", x: "X", y: "Y", A: "A", B: "B", X: "X", Y: "Y" };
  const held = new Set<string>();
  cv.addEventListener("keydown", (e) => { const k = KEYMAP[e.key]; if (!k) return; e.preventDefault(); if (!held.has(k)) { held.add(k); set(k, true); } });
  cv.addEventListener("keyup", (e) => { const k = KEYMAP[e.key]; if (k && held.delete(k)) set(k, false); });
  cv.addEventListener("blur", () => { for (const k of held) set(k, false); held.clear(); });

  return {
    setScreen(canvas) {
      tex?.dispose();
      tex = canvas ? new THREE.CanvasTexture(canvas) : null;
      if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; }
      screenMat.map = tex; screenMat.color.set(tex ? 0xffffff : 0x000000); screenMat.needsUpdate = true;
    },
    setBacklight(v) { backlight = v; },
    keyVisual: visual,
    destroy() {
      dead = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      removeEventListener("pointermove", onMove); document.removeEventListener("visibilitychange", loop);
      renderer.dispose(); pmrem.dispose(); cv.remove();
    },
  };
}
