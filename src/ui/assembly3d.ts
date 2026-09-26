// "Put it together", as you scroll: an exploded wedgie that assembles itself. setProgress(0..1):
//   0.00-0.25  1. wedge the wires in: the chip's four wires slide into the hat's header, beside the Pico pins
//   0.25-0.50  2. wedge the chip in between: the chip tucks into the gap, the Pico comes up into the header
//   0.50-0.75  3. snap the case on: base up, lid down, caps and joystick drop in
//   0.75-1.00  4. plug it in: the screen boots to the underwear and the bar fills, grey then green
// Same case frame as wedgie3d (mm; LCD PCB bottom-left origin, +y toward the joystick, +z out of the
// screen). Header holes: rows 17.78 mm apart centred on the Pico, pin 1 at the USB (joystick) end.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadGeo, partGeometry, COLORS } from "./wedgie3d";

export type Assembly3D = { setProgress(p: number): void; destroy(): void };

const ROW_L = 13.22 + 8.89, ROW_R = 13.22 - 8.89;       // left/right as seen from the Pico side, USB at top
const PIN1_Y = 51.77 - 1.61;
const hole = (x: number, n: number) => new THREE.Vector3(x, PIN1_Y - (n - 1) * 2.54, -10.66);
// plug order GND, V+, SDA, SCL -> right 3rd (pin 38), right 5th (pin 36), left 6th (GP4), left 7th (GP5)
const WIRES = [
  { color: 0x1a1a1a, to: hole(ROW_R, 3) },
  { color: 0xd8262a, to: hole(ROW_R, 5) },
  { color: 0x2f6fd6, to: hole(ROW_L, 6) },
  { color: 0xf2c417, to: hole(ROW_L, 7) },
];
const CHIP_IN = { x: 13.2, y: 17, z: -7.5, roll: 0.32 };          // wedged: jammed in at an angle
const CHIP_OUT = { x: 48, y: 16, z: -13, roll: 0 };

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => { v = clamp(v); return v * v * (3 - 2 * v); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export async function mountAssembly3D(el: HTMLElement): Promise<Assembly3D> {
  const { meta, bin } = await loadGeo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const cv = renderer.domElement;
  cv.className = "w3d";
  cv.setAttribute("aria-hidden", "true");
  el.style.position = "relative";
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const camera = new THREE.PerspectiveCamera(24, 1, 10, 3000);
  camera.position.set(0, -30, 190);
  camera.lookAt(0, 0, 0);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-35, 45, 160);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 12;
  Object.assign(key.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 10, far: 500 });
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xb9b9b3, 0.4));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.14 }));
  floor.position.z = -40;
  floor.receiveShadow = true;
  scene.add(floor);

  const tilt = new THREE.Group();
  const dev = new THREE.Group();
  dev.rotation.z = Math.PI / 2;               // landscape: joystick end left, like the device
  tilt.add(dev);
  scene.add(tilt);
  const inner = new THREE.Group();
  inner.position.set(-13.22, -26, 4);
  dev.add(inner);

  const plastic = (c: number, rough = 0.5) => new THREE.MeshPhysicalMaterial({ color: c, roughness: rough, clearcoat: 0.2, clearcoatRoughness: 0.5 });
  const mesh = (name: string, mat: THREE.Material) => {
    const p = meta.parts.find((q) => q.name === name)!;
    const m = new THREE.Mesh(partGeometry(p, bin), mat);
    m.castShadow = m.receiveShadow = true;
    inner.add(m);
    return m;
  };
  const hat = mesh("hat", new THREE.MeshStandardMaterial({ color: 0x1f5a7a, roughness: 0.6 }));
  const pico = mesh("pico", new THREE.MeshStandardMaterial({ color: 0x2b8a48, roughness: 0.55 }));
  const lid = mesh("lid", plastic(COLORS.lid));
  const base = mesh("base", plastic(COLORS.base, 0.55));
  const caps = ["A", "B", "X", "Y", "joystick"].map((k) => mesh(k, plastic(COLORS[k])));

  // The screen: dark glass, and what the firmware shows when it boots (underwear + the bar).
  const G = meta.glass;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(G.w, G.h), new THREE.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.08, clearcoat: 1 }));
  glass.position.set(G.cx, G.cy, G.z + 0.02);
  inner.add(glass);
  const scr = document.createElement("canvas");
  scr.width = scr.height = 240;
  const sg = scr.getContext("2d")!;
  const logo = new Image();
  logo.src = "/img/loader-logo.webp";
  const scrTex = new THREE.CanvasTexture(scr);
  scrTex.colorSpace = THREE.SRGBColorSpace;
  const scrMat = new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false, transparent: true, opacity: 0 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(23.4, 23.4), scrMat);
  screen.position.set(G.cx, G.cy, G.z + 0.05);
  screen.rotation.z = -Math.PI / 2;
  inner.add(screen);
  let lastBoot = -1;
  function drawBoot(t: number) {             // t 0..1: the device's own boot screen, splash.py + loader.py
    if (Math.abs(t - lastBoot) < 0.01) return;
    lastBoot = t;
    sg.fillStyle = "#fefefe"; sg.fillRect(0, 0, 240, 240);
    if (logo.complete) sg.drawImage(logo, 72, 74, 96, 77);
    const x = 45, y = 166, w = 150, h = 30;
    sg.fillStyle = "#eceded"; round(x, y, w, h, 15); sg.fill();
    sg.fillStyle = "#c9cacc"; round(x + 11, y + 7, w - 22, h - 14, 8); sg.fill();
    const f = Math.min(1, t / 0.8), fw = 12 + (w - 26 - 12) * f;
    const gr = sg.createLinearGradient(0, y + 9, 0, y + 21);
    if (t >= 0.85) { gr.addColorStop(0, "#46cd64"); gr.addColorStop(1, "#168c34"); } else { gr.addColorStop(0, "#7c7d7f"); gr.addColorStop(1, "#48494b"); }
    sg.fillStyle = gr; round(x + 13, y + 9, fw, h - 18, 6); sg.fill();
    scrTex.needsUpdate = true;
  }
  function round(x: number, y: number, w: number, h: number, r: number) { sg.beginPath(); sg.roundRect(x, y, w, h, r); }

  // The chip on its breakout, and its four wires to the header.
  const chip = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(17.7, 25.5, 1.6), new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.6 }));
  const ic = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 1.2), new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.4 }));
  ic.position.set(0, -2, 1.3);
  const jst = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 3), new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.7 }));
  jst.position.set(0, 12, 1.8);
  board.castShadow = true;
  chip.add(board, ic, jst);
  inner.add(chip);
  const wires = WIRES.map((w) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.45 }));
    m.castShadow = true;
    inner.add(m);
    return { ...w, m };
  });
  function placeWires(insert: number) {
    const plug = new THREE.Vector3(0, 13.5, 2.2).applyMatrix4(chip.matrix);
    wires.forEach((w, i) => {
      const start = plug.clone().add(new THREE.Vector3((i - 1.5) * 1.1, 0, 0));
      const tip = w.to.clone().add(new THREE.Vector3(0, 0, lerp(-9, 1.5, insert)));    // slides up into the socket
      const below = tip.clone().add(new THREE.Vector3(0, 0, -6));
      const mid = start.clone().lerp(below, 0.5).add(new THREE.Vector3(0, 0, -5));
      const curve = new THREE.CatmullRomCurve3([start, mid, below, tip]);
      w.m.geometry.dispose();
      w.m.geometry = new THREE.TubeGeometry(curve, 40, 0.55, 8, false);
    });
  }

  // ---- labels with arrows: the wedge, spelled out --------------------------------------------------
  const label = (text: string) => {
    const d = document.createElement("div");
    d.className = "wedge-label";
    d.innerHTML = `<span>${text}</span><i></i>`;
    el.appendChild(d);
    return d;
  };
  const lblWires = label("Wedge the wires in");
  const lblChip = label("Wedge the chip in between");
  const tmp = new THREE.Vector3();
  function pin(d: HTMLElement, at: THREE.Vector3, show: number) {
    tmp.copy(at).applyMatrix4(inner.matrixWorld).project(camera);
    d.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * W}px, ${(-tmp.y * 0.5 + 0.5) * H}px)`;
    d.style.opacity = String(show);
  }

  // ---- progress -> pose -------------------------------------------------------------------------------
  let p = 0, shown = -1;
  const cur = { x: 0, y: 0 };
  function pose() {
    const s1 = ease(p / 0.25), s2 = ease((p - 0.25) / 0.25), s3 = ease((p - 0.5) / 0.22), s4 = clamp((p - 0.75) / 0.2);
    // view: starts looking at the back of the hat (where the header is), turns face-up for the case
    const back = 1 - ease((p - 0.42) / 0.3);
    tilt.rotation.x = lerp(-0.12, -2.35, back) + cur.y * 0.06;
    tilt.rotation.y = lerp(0.1, 0.5, back) * (1 - s3) + cur.x * 0.08;
    tilt.rotation.z = lerp(0, 0.25, back);
    const c = { x: lerp(CHIP_OUT.x, CHIP_IN.x, s2), y: lerp(CHIP_OUT.y, CHIP_IN.y, s2), z: lerp(CHIP_OUT.z, CHIP_IN.z, s2), r: lerp(CHIP_OUT.roll, CHIP_IN.roll, s2) };
    chip.position.set(c.x, c.y, c.z);
    chip.rotation.set(0, c.r, 0);
    chip.updateMatrix();
    placeWires(s1);
    pico.position.z = lerp(-34, 0, s2);
    pico.visible = s2 > 0.001 || p > 0.2;
    base.position.z = lerp(-44, 0, s3);
    lid.position.z = lerp(34, 0, ease((p - 0.55) / 0.2));
    caps.forEach((m, i) => { m.position.z = lerp(52, 0, ease((p - 0.6 - i * 0.012) / 0.15)); });
    base.visible = p > 0.45; lid.visible = p > 0.5; caps.forEach((m) => (m.visible = p > 0.55));
    scrMat.opacity = s4 > 0 ? Math.min(1, s4 * 3) : 0;
    if (s4 > 0) drawBoot(s4);
    tilt.updateMatrixWorld(true);
    pin(lblWires, hole(ROW_L, 6).add(new THREE.Vector3(0, 0, -4)), clamp(1 - Math.abs(p - 0.14) / 0.13) * 1.6);
    pin(lblChip, new THREE.Vector3(CHIP_IN.x, CHIP_IN.y - 6, CHIP_IN.z), clamp(1 - Math.abs(p - 0.4) / 0.12) * 1.6);
  }

  let W = 0, H = 0;
  const resize = () => {
    W = el.clientWidth; H = el.clientHeight || Math.round(W * 0.7);
    renderer.setSize(W, H, false);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    camera.aspect = W / H;
    const fit = 84 / (2 * Math.tan((24 / 2) * Math.PI / 180) * camera.aspect);   // keep ~84 mm across in view
    camera.position.set(0, -24, Math.max(118, fit));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    shown = -1;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  const aim = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => { aim.x = e.clientX / innerWidth - 0.5; aim.y = e.clientY / innerHeight - 0.5; };
  addEventListener("pointermove", onMove);

  // Keep ticking while mounted; draw only when on screen (an IntersectionObserver can miss the sticky
  // stage changing size and stop the loop for good).
  let raf = 0, dead = false;
  function loop() {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || document.hidden) return;
    cur.x += (aim.x - cur.x) * 0.05; cur.y += (aim.y - cur.y) * 0.05;
    pose();
    renderer.render(scene, camera);
  }
  loop();

  return {
    setProgress(v) { p = clamp(v); if (p !== shown) shown = p; },
    destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); removeEventListener("pointermove", onMove); renderer.dispose(); pmrem.dispose(); cv.remove(); lblWires.remove(); lblChip.remove(); },
  };
}
