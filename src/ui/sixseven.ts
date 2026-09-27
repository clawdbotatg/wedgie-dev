// The 6-7 hands by the $67: two plastic hands, palms up, bobbing up and down in turn ("six... seven"),
// for a couple of seconds when the price scrolls into view. All white plastic.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export function mountSixSeven(box: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const cv = renderer.domElement;
  cv.className = "sixseven";
  cv.setAttribute("aria-hidden", "true");
  box.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(-3, 8, 6);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xbdbdb7, 0.5));
  const camera = new THREE.PerspectiveCamera(30, 1.6, 0.1, 100);
  camera.position.set(0, 4.2, 12);
  camera.lookAt(0, 0.2, 0.6);

  const white = new THREE.MeshPhysicalMaterial({ color: 0xf4f3ef, roughness: 0.55, clearcoat: 0.2 });

  function hand(side: 1 | -1) {
    const g = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 2.4), white);
    g.add(palm);
    // palms up, fingers toward the viewer (like the gesture), sleeves going back
    [-0.78, -0.26, 0.26, 0.78].forEach((x, i) => {
      const len = [0.95, 1.2, 1.15, 0.85][side === 1 ? i : 3 - i];
      const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, len, 6, 12), white);
      f.rotation.x = Math.PI / 2 - 0.35;          // tips curl up: a cupped, palm-up hand
      f.position.set(x, 0.18, 1.2 + len / 2);
      g.add(f);
    });
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.8, 6, 12), white);
    thumb.rotation.set(Math.PI / 2 - 0.5, 0, -side * 0.9);   // thumbs out and up
    thumb.position.set(side * 1.35, 0.35, 0.35);
    g.add(thumb);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 2.8, 20), white);   // forearm, same white
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.set(0, -0.05, -2.4);
    g.add(sleeve);
    g.position.x = side * 1.9;
    g.rotation.y = side * 0.25;
    scene.add(g);
    return g;
  }
  const L = hand(1), R = hand(-1);

  const resize = () => {
    const W = cv.clientWidth || 220, H = cv.clientHeight || 140;
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(cv);

  let raf = 0, t0 = 0, playing = false;
  const DUR = 2.6;
  function frame() {
    const t = (performance.now() - t0) / 1000;
    if (t > DUR) { playing = false; cv.classList.remove("on"); return; }
    raf = requestAnimationFrame(frame);
    const beat = Math.sin(t * Math.PI * 2 * 2.1);                      // ~2 bobs a second, hands opposite
    L.position.y = beat * 1.3; R.position.y = -beat * 1.3;
    L.rotation.z = beat * 0.12; R.rotation.z = beat * 0.12;
    if (t > DUR - 0.35) cv.classList.remove("on");                      // fade out at the end
    renderer.render(scene, camera);
  }
  return {
    play() {
      if (playing) return;
      playing = true; t0 = performance.now();
      cv.classList.add("on");
      cancelAnimationFrame(raf); frame();
    },
  };
}
