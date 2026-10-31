// The Trust M breakout (Adafruit, 1 x 0.7 in, black) with the cable's plug in its left socket and the
// four cut wires leaving to the left, in your colors (setColors). Drawn after Austin's photo
// public/img/assemble/p/02-trust-m-plug.webp. Drag to turn, scroll or pinch to zoom.
// Frame (mm): board centre at the origin, x along the long side, y away (the "Trust M" end), z up.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { copper } from "./parts-geo";

export type Cable3D = { setColors(hex: string[]): void; destroy(): void };

const W = 25.4, H = 17.8, T = 1.6, TOP = T / 2;
const std = (color: number | string, roughness = 0.55, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b;
};

/** The board's top: black solder mask, white silkscreen (name, padlock, pin labels). */
function silk() {
  const S = 40, c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
  const g = c.getContext("2d")!;
  const X = (x: number) => (x + W / 2) * S, Y = (y: number) => (H / 2 - y) * S;
  g.fillStyle = "#141414"; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = g.fillStyle = "#f2f2ee";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `700 ${2.5 * S}px Arial, sans-serif`;
  g.fillText("Trust M", X(0.5), Y(6.9));
  g.lineWidth = 0.75 * S;                                       // the padlock round the chip
  g.beginPath(); g.arc(X(0), Y(2.2), 2.4 * S, Math.PI, 0); g.stroke();
  g.lineWidth = 0.5 * S;
  g.strokeRect(X(-4.4), Y(2.4), 8.8 * S, 6.4 * S);
  g.font = `700 ${1.35 * S}px Arial, sans-serif`;
  const pins = ["Vcc", "GND", "SCL", "SDA", "Reset"];
  pins.forEach((p, i) => g.fillText(p, X(-5.08 + i * 2.54 + (i === 4 ? 0.6 : 0)), Y(i % 2 ? -4.6 : -8.2)));
  g.font = `700 ${1 * S}px Arial, sans-serif`;
  g.fillText("on", X(-9.6), Y(3.6));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** A gold plated hole: ring at (x, y) on the top face. */
function hole(x: number, y: number, r: number, R: number) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R, R, T + 0.08, 32), std(0xd4a94a, 0.3, 0.9));
  ring.rotation.x = Math.PI / 2;
  const dark = new THREE.Mesh(new THREE.CylinderGeometry(r, r, T + 0.2, 24), std(0x050505, 0.9));
  dark.rotation.x = Math.PI / 2;
  g.add(ring, dark); g.position.set(x, y, 0);
  return g;
}

/** A JST-SH socket, opening toward -x (sx = 1) or +x (sx = -1), its outer face at x. */
function socket(x: number, sx: number) {
  const g = new THREE.Group(), m = std(0x1c1c1e, 0.6);
  g.add(box(4.2, 6, 2.9, m, x + sx * 2.1, 0, TOP + 1.45));
  for (const y of [-3.4, 3.4]) g.add(box(1.4, 1, 0.3, std(0xb9bcc0, 0.3, 0.9), x + sx * 1.6, y, TOP + 0.15));   // the side tabs
  for (let i = 0; i < 4; i++) g.add(box(1, 0.35, 0.2, std(0xb9bcc0, 0.3, 0.9), x + sx * 4.8, (i - 1.5) * 1, TOP + 0.1));
  return g;
}

export async function mountCable3D(el: HTMLElement, colors: string[]): Promise<Cable3D> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const cv = renderer.domElement;
  cv.className = "cbl-canvas";
  cv.setAttribute("aria-label", "The Trust M with the cable plugged into its left socket, in your colors. Drag to turn it.");
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-40, -50, 140);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -70, right: 40, top: 40, bottom: -40, near: 20, far: 400 });
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x9aa7a0, 0.6));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.2 }));
  floor.position.z = -T / 2 - 0.01; floor.receiveShadow = true;
  scene.add(floor);

  const all = new THREE.Group();
  scene.add(all);
  // the board: silkscreen on top, black edges
  const edge = std(0x101010, 0.6);
  const board = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), [edge, edge, edge, edge, new THREE.MeshStandardMaterial({ map: silk(), roughness: 0.45 }), edge]);
  all.add(board);
  for (const x of [-10.16, 10.16]) for (const y of [-6.35, 6.35]) all.add(hole(x, y, 1.25, 2.3));
  for (let i = 0; i < 5; i++) all.add(hole(-5.08 + i * 2.54, -6.4, 0.5, 0.95));
  all.add(box(3, 3, 0.8, std(0x0b0b0c, 0.4), 0, -0.6, TOP + 0.4));                         // the chip
  for (const [x, y, w, h, c] of [[-6.6, 3.8, 1.6, 0.8, 0xd9c7a0], [-6.6, 2.4, 1.6, 0.8, 0x2a2a2a], [-6.6, 1, 1.6, 0.8, 0x2a2a2a],
    [5.6, 4.8, 2, 1, 0xc49a6c], [6.2, 3.2, 1.6, 0.8, 0x2a2a2a], [6.2, 1.8, 1.6, 0.8, 0x2a2a2a], [3.4, 0.4, 0.8, 1.6, 0x2a2a2a], [-3.4, 1.6, 0.8, 1.6, 0x2a2a2a]] as const)
    all.add(box(w, h, 0.45, std(c, 0.5), x, y, TOP + 0.22));
  all.add(box(0.6, 0.6, 0.2, std(0xf2f2ee, 0.4), -9.1, 4.6, TOP + 0.1));                 // the LED
  all.add(socket(-W / 2, 1), socket(W / 2, -1));

  // the plug in the left socket, then the four wires: white (top, +y), yellow, black, red
  const zc = TOP + 1.45, px = -W / 2 - 1.8;
  all.add(box(3.6, 5.4, 2.5, std(0xf1ede2, 0.7), -W / 2 + 0.2 - 0.4, 0, zc));
  for (let i = 0; i < 3; i++) all.add(box(0.3, 5.2, 2.3, std(0xe2ddd0, 0.7), px + 0.4 + i * 0.6, 0, zc));
  const mats = colors.map((c) => std(c, 0.45));
  const ys = [1.5, 0.5, -0.5, -1.5];
  ys.forEach((y, i) => {
    const pts = [[px, y, zc], [px - 5, y, zc - 0.2], [px - 14, y * 1.4, 0.2], [px - 26, y * 2.6, -0.25], [px - 36, y * 3.6, -0.25]]
      .map(([a, b, c]) => new THREE.Vector3(a, b, c));
    const ins = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.5, 12, false), mats[i]);
    const cu = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4, 10), copper());
    const end = pts[pts.length - 1], d = end.clone().sub(pts[pts.length - 2]).normalize();
    cu.position.copy(end).addScaledVector(d, 2);
    cu.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    all.add(ins, cu);
  });
  all.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = (m as THREE.Mesh).receiveShadow = true; });
  floor.castShadow = false;

  const target = new THREE.Vector3(-14, 0, 0);
  const camera = new THREE.PerspectiveCamera(28, 1, 5, 2000);
  camera.up.set(0, 0, 1);
  const home = () => { camera.position.set(target.x - 12, target.y - 42, 46); controls.target.copy(target); controls.update(); };
  const controls = new OrbitControls(camera, cv);
  controls.enableDamping = true;
  controls.minDistance = 30; controls.maxDistance = 260;
  controls.maxPolarAngle = Math.PI * 0.49;
  home();

  let dirty = true;
  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight || 260;
    renderer.setSize(w, h, false);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    camera.aspect = w / h;
    camera.fov = w < 500 ? 52 : w < h * 1.2 ? 40 : 28;           // a phone: wider, to see the whole cable
    camera.updateProjectionMatrix();
    dirty = true;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  let raf = 0, dead = false;
  const loop = () => {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (controls.update() || dirty) { dirty = false; renderer.render(scene, camera); }   // draw only when something moved
  };
  loop();
  return {
    setColors(hex) { hex.forEach((c, i) => mats[i].color.set(c)); dirty = true; },
    destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); pmrem.dispose(); cv.remove(); },
  };
}
