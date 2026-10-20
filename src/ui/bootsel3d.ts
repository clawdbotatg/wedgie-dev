// /format's "hold BOOTSEL and plug it in", in 3D: a wedgie seen from the back, a paperclip pressing the Pico's
// BOOTSEL button through the hole in the base, the USB cable going in while it's held, then the clip let go.
// install (/reset): then it lets go, turns over, and its screen shows what comes next: the install's bar
// filling, a restart, Welcome. A caption under it says each step, so the loop reads as one story.
// Case frame (mm, parts-geo.ts): +y toward the joystick (the USB end), +z out of the screen, so the back is -z.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadGeo, partGeometry, COLORS } from "./wedgie3d";
import { PART_COLORS } from "./parts-geo";

export type Bootsel3D = { destroy(): void };

const HOLE = { x: 16.5, y: 39.4, z: -20.64 };     // the base's hole over BOOTSEL (from the case mesh)
const USB = { x: 13.22, y: 54.2, z: -16.7 };       // the Pico's micro USB socket mouth
const CYCLE = 6;                                   // s: press, plug in, hold, let go, unplug
const LONG = 17;                                   // s, with install: press, plug in, let go, turn over, install, restart, Welcome

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const span = (t: number, a: number, b: number) => ease((t - a) / (b - a));

export async function mountBootsel3D(el: HTMLElement, opts: { install?: boolean } = {}): Promise<Bootsel3D> {
  const { meta, bin } = await loadGeo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  const cv = renderer.domElement;
  cv.setAttribute("aria-hidden", "true");
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(30, 60, -120);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xb9b9b3, 0.5));
  const camera = new THREE.PerspectiveCamera(26, 1, 5, 1000);

  const spin = new THREE.Group();
  scene.add(spin);
  const dev = new THREE.Group();                   // turns it round to its back
  spin.add(dev);
  const body = new THREE.Group();                  // everything, in case mm, centred on the case
  dev.add(body);
  const plastic = (c: number) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.6, clearcoat: 0.1 });
  for (const [name, color] of [["lid", COLORS.lid], ["base", COLORS.base], ["hat", PART_COLORS.hat], ["pico", PART_COLORS.pico]] as const) {
    const p = meta.parts.find((q) => q.name === name);
    if (p) body.add(new THREE.Mesh(partGeometry(p, bin), plastic(color)));
  }
  // Its front, for when it turns over: the buttons, dark glass, and the screen (drawn here, like assembly3d.ts).
  const scr = document.createElement("canvas");
  scr.width = scr.height = 240;
  const sg = scr.getContext("2d")!;
  const scrTex = new THREE.CanvasTexture(scr);
  scrTex.colorSpace = THREE.SRGBColorSpace;
  const logo = new Image();
  if (opts.install) {
    for (const name of ["joystick", "A", "B", "X", "Y"]) {
      const p = meta.parts.find((q) => q.name === name);
      if (p) body.add(new THREE.Mesh(partGeometry(p, bin), plastic(COLORS[name])));
    }
    const G = meta.glass;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(G.w, G.h), new THREE.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.08, clearcoat: 1 }));
    glass.position.set(G.cx, G.cy, G.z + 0.02);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(23.4, 23.4), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }));
    screen.position.set(G.cx, G.cy, G.z + 0.05);
    screen.rotation.z = -Math.PI / 2;            // image up = case +x
    body.add(glass, screen);
    logo.src = "/img/loader-logo.webp";
  }
  let drawn = "";
  const round = (x: number, y: number, w: number, h: number, r: number) => { sg.beginPath(); sg.roundRect(x, y, w, h, r); sg.fill(); };
  /** What its screen shows: dark (boot mode), the install's logo + bar at p, or Welcome. */
  function draw(what: "dark" | "bar" | "welcome", p = 0) {
    const k = what + (what === "bar" ? Math.round(p * 60) : "") + logo.complete;
    if (k === drawn) return;
    drawn = k;
    sg.fillStyle = what === "dark" ? "#000" : "#fefefe"; sg.fillRect(0, 0, 240, 240);
    if (what === "bar") {
      if (logo.complete) sg.drawImage(logo, 72, 60, 96, 77);
      const x = 45, y = 160, w = 150, h = 30;
      sg.fillStyle = "#eceded"; round(x, y, w, h, 15);
      sg.fillStyle = "#c9cacc"; round(x + 11, y + 7, w - 22, h - 14, 8);
      const gr = sg.createLinearGradient(0, y + 9, 0, y + 21);
      gr.addColorStop(0, p >= 1 ? "#46cd64" : "#7c7d7f"); gr.addColorStop(1, p >= 1 ? "#168c34" : "#48494b");
      sg.fillStyle = gr; round(x + 13, y + 9, 12 + (w - 38) * p, h - 18, 6);
    }
    if (what === "welcome") {
      sg.fillStyle = "#1c1c1e"; sg.textAlign = "center"; sg.font = "bold 36px sans-serif";
      sg.fillText("Welcome", 120, 128);
    }
    scrTex.needsUpdate = true;
  }
  draw("dark");
  const caption = document.createElement("div");
  caption.className = "boot-hint-cap";
  if (opts.install) el.appendChild(caption);
  const say = (t: string) => { if (caption.textContent !== t) caption.textContent = t; };

  // The hole, lit up: a green ring on the base that pulses until the clip is in.
  const green = new THREE.MeshBasicMaterial({ color: 0x22c452, transparent: true });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.9, 0.45, 12, 40), green);
  ring.position.set(HOLE.x, HOLE.y, HOLE.z - 0.3);
  body.add(ring);

  // A straightened paperclip, along z, its tip at the button when pressed.
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.25 });
  const clip = new THREE.Group();
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 30, 16), steel);
  wire.rotation.x = Math.PI / 2;
  wire.position.z = -15;
  const loop = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.5, 10, 32, Math.PI), steel);
  loop.position.set(3.2, 0, -30);
  loop.rotation.x = Math.PI / 2;
  clip.add(wire, loop);
  clip.position.set(HOLE.x, HOLE.y, 0);
  body.add(clip);

  // The USB cable: a micro USB plug and a length of black cable, coming in along -y.
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
  const cable = new THREE.Group();
  const tip = new THREE.Mesh(new THREE.BoxGeometry(7, 5, 2.4), steel);
  tip.position.y = 2.5;
  const boot = new THREE.Mesh(new THREE.BoxGeometry(10.5, 16, 7), black);
  boot.position.y = 13;
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 40, 16), black);
  cord.position.y = 41;
  cable.add(tip, boot, cord);
  cable.position.set(USB.x, USB.y, USB.z);
  body.add(cable);

  // Seen from the back, turned a little so the USB end shows too; sized to the wedgie.
  dev.rotation.y = Math.PI;
  body.position.set(-13.2, -26 - 8, 11.3);           // the case's middle (x 13.2, y 26, z -11.3), nudged toward the cable
  const size = 74;

  const resize = () => {
    const W = el.clientWidth, H = el.clientHeight || 240;
    renderer.setSize(W, H, false);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    camera.aspect = W / H;
    const d = size / (2 * Math.tan((26 / 2) * Math.PI / 180) * Math.min(1, camera.aspect));
    camera.position.set(0, -d * 0.3, d);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  let raf = 0, dead = false;
  const t0 = performance.now();
  function frame() {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    if (!el.offsetParent || document.hidden) return;          // hidden (a unit is on the bench): nothing to draw
    const t = ((performance.now() - t0) / 1000) % (opts.install ? LONG : CYCLE);
    const press = span(t, 0.2, 1.0) - span(t, 3.8, 4.4);        // clip in, held, let go
    // cable in while held; out at the end (with install it stays in: the wedgie fades out and back instead)
    const plug = span(t, 1.4, 2.6) - (opts.install ? 0 : span(t, 4.8, 5.6));
    if (opts.install) {
      const turn = span(t, 4.8, 6.0);                           // over onto its front
      dev.rotation.y = Math.PI * (1 - turn);
      key.position.z = -120 * Math.cos(Math.PI * turn);       // the light stays on the side we see
      cv.style.opacity = String(t < 0.4 ? span(t, 0, 0.4) : 1 - span(t, 16.2, 16.9));
      if (t < 6.4) draw("dark");
      else if (t < 12.4) draw("bar", Math.min(1, (t - 6.4) / 5.4));
      else if (t < 13.2) draw("dark");                          // the restart
      else draw("welcome");
      say(t < 1.4 ? "1. Hold the button" : t < 4.4 ? "2. Plug it in, let go" : t < 6.4 ? "3. Tap Find it, then Reset it"
        : t < 12.4 ? "4. It installs. Leave it plugged in" : t < 13.2 ? "5. It restarts" : "Done: it says Welcome");
    }
    clip.position.z = -40 + 22.5 * press;                        // tip reaches the button (-17.5; the base is -20.6)
    clip.visible = (press > 0.001 || t < 1) && (!opts.install || t < 4.6);
    cable.position.y = USB.y + 26 * (1 - plug);
    green.opacity = press > 0.95 ? 1 : 0.45 + 0.4 * Math.abs(Math.sin(t * 4));
    spin.rotation.z = Math.PI / 2 + 0.25 + Math.sin(t * 0.6) * 0.05;   // lying on its side, USB end to the right
    spin.rotation.x = -0.45;
    spin.rotation.y = 0.15;
    renderer.render(scene, camera);
  }
  frame();
  return { destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); pmrem.dispose(); cv.remove(); } };
}
