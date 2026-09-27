// One loose part, in 3D, in its numbered card: "pico" (green), "hat" (dark grey), "chip" (red, with its
// cable and bare copper tips). It sways as the page scrolls past, and a little on its own.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadGeo, partGeometry } from "./wedgie3d";
import { PART_COLORS, picoPins, chipBoard, PLUG, WIRE_COLORS, wire } from "./parts-geo";

export type Part3D = { destroy(): void };

export async function mountPart3D(el: HTMLElement, which: "pico" | "hat" | "chip", phase = 0): Promise<Part3D> {
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
  scene.environmentIntensity = 0.45;
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-30, 50, 120);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xb9b9b3, 0.4));
  const camera = new THREE.PerspectiveCamera(26, 1, 5, 1000);

  const spin = new THREE.Group();
  scene.add(spin);
  const holder = new THREE.Group();
  spin.add(holder);
  let size = 60;
  const part = (name: string, color: number) => {
    const p = meta.parts.find((q) => q.name === name)!;
    return new THREE.Mesh(partGeometry(p, bin), new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
  };
  if (which === "pico") {
    const m = part("pico", PART_COLORS.pico);
    m.add(picoPins());
    holder.add(m);
    holder.rotation.x = Math.PI;                    // components up, pins hanging down, like it comes out of the bag
  } else if (which === "hat") {
    const m = part("hat", PART_COLORS.hat);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(meta.glass.w, meta.glass.h), new THREE.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.1, clearcoat: 1 }));
    glass.position.set(meta.glass.cx, meta.glass.cy, meta.glass.z + 0.02);
    m.add(glass);
    holder.add(m);

  } else {
    const chip = chipBoard();
    holder.add(chip);
    WIRE_COLORS.forEach((c, i) => {                  // a short length of cable, fanned out, bare tips
      const w = wire(c);
      const s = PLUG.clone().add(new THREE.Vector3((i - 1.5) * 1.1, 0, 0));
      const end = new THREE.Vector3((i - 1.5) * 5, 30, 3 + (i % 2) * 2);
      w.set([s, s.clone().add(new THREE.Vector3(0, 6, 1)), end], new THREE.Vector3((i - 1.5) * 0.3, 1, 0));
      holder.add(w.group);
    });
  }
  // Centre whatever we built on the spin point, and size the camera to it.
  const box = new THREE.Box3().setFromObject(holder), mid = box.getCenter(new THREE.Vector3()), dim = box.getSize(new THREE.Vector3());
  const wrap = new THREE.Group();
  spin.remove(holder); wrap.add(holder); spin.add(wrap);
  holder.position.sub(mid.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler())));
  size = Math.max(dim.x, dim.y, dim.z) * 0.95;

  const resize = () => {
    const W = el.clientWidth, H = el.clientHeight || 180;
    renderer.setSize(W, H, false);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    camera.aspect = W / H;
    const d = size / (2 * Math.tan((26 / 2) * Math.PI / 180) * Math.min(1, camera.aspect));
    camera.position.set(0, -d * 0.35, d);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  let raf = 0, dead = false;
  const t0 = performance.now();
  function loop() {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || document.hidden) return;
    const t = (performance.now() - t0) / 1000;
    const sc = (r.top + r.height / 2 - innerHeight / 2) / innerHeight;       // -0.5..0.5 across the screen
    spin.rotation.z = Math.PI / 2 + Math.sin(sc * 3.2 + phase) * 0.5 + Math.sin(t * 0.7 + phase) * 0.05;
    spin.rotation.x = -0.35 + sc * 0.9 + Math.sin(t * 0.5 + phase) * 0.04;
    spin.rotation.y = Math.sin(sc * 2.4 + phase * 1.7) * 0.35;
    renderer.render(scene, camera);
  }
  loop();
  return { destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); pmrem.dispose(); cv.remove(); } };
}
