// The loose parts of a wedgie, shared by the assembly animation and the part cards, in the colors of
// their numbered cards: 1 the Pico (green), 2 the screen hat (dark grey), 3 the chip (red).
// Case frame (mm): LCD PCB bottom-left origin, +y toward the joystick (the USB end), +z out of the screen.
import * as THREE from "three";

export const PART_COLORS = { pico: 0x27a84a, hat: 0x55565a, chip: 0xd8322c };

// Header: two rows 17.78 mm apart, centred on the Pico; pin 1 at the USB end.
export const ROW_L = 13.22 + 8.89, ROW_R = 13.22 - 8.89;   // left/right as seen from the Pico side, USB at top
export const PIN1_Y = 51.77 - 1.61;
export const pinY = (n: number) => PIN1_Y - (n - 1) * 2.54;
export const PICO_TOP = -14.26;                               // the Pico's component face
export const SOCKET_BOTTOM = -10.66;                          // underside of the hat's female header

const gold = () => new THREE.MeshStandardMaterial({ color: 0xd4a94a, metalness: 0.9, roughness: 0.3 });
export const copper = () => new THREE.MeshStandardMaterial({ color: 0xc8743a, metalness: 0.95, roughness: 0.28 });

/** The Pico's 40 header pins, standing up from its component face into the hat's sockets. */
export function picoPins() {
  const g = new THREE.Group();
  const pin = new THREE.BoxGeometry(0.64, 0.64, 6.2), plastic = new THREE.BoxGeometry(2.5, 2.5, 2.5);
  const m = gold(), pm = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });
  for (const x of [ROW_L, ROW_R]) for (let n = 1; n <= 20; n++) {
    const p = new THREE.Mesh(pin, m); p.position.set(x, pinY(n), PICO_TOP + 3.1 + 1.2); g.add(p);
    const b = new THREE.Mesh(plastic, pm); b.position.set(x, pinY(n), PICO_TOP + 1.25); g.add(b);
  }
  return g;
}

/** The secure chip on its breakout board (red), with its white STEMMA QT plug. Plug at local (0, 13.5, 2.2). */
export function chipBoard() {
  const chip = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(17.7, 25.5, 1.6), new THREE.MeshStandardMaterial({ color: PART_COLORS.chip, roughness: 0.55 }));
  const ic = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 1.2), new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.4 }));
  ic.position.set(0, -2, 1.3);
  const jst = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 3), new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.7 }));
  jst.position.set(0, 12, 1.8);
  const jst2 = jst.clone(); jst2.position.set(0, -12, 1.8);    // the second QT port (same bus)
  board.castShadow = true;
  chip.add(board, ic, jst, jst2);
  return chip;
}
export const PLUG = new THREE.Vector3(0, 13.5, 2.2);

// Plug order GND, V+, SDA, SCL (Adafruit colors black red blue yellow).
export const WIRE_COLORS = [0x1a1a1a, 0xd8262a, 0x2f6fd6, 0xf2c417];

/** One wire: insulation along a curve, then 3 mm of bare copper at the tip (pointing along `dir`). */
export function wire(color: number) {
  const g = new THREE.Group();
  const ins = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  const cu = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3, 10), copper());
  ins.castShadow = cu.castShadow = true;
  g.add(ins, cu);
  return {
    group: g,
    /** points: start ... the end of the insulation; the copper sticks out from there along dir */
    set(points: THREE.Vector3[], dir: THREE.Vector3) {
      ins.geometry.dispose();
      ins.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 40, 0.55, 8, false);
      const end = points[points.length - 1], d = dir.clone().normalize();
      cu.position.copy(end).addScaledVector(d, 1.5);
      cu.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    },
  };
}
