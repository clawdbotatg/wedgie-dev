// /assemble/3d: every assembly step, in 3D, on a cutting mat. Drag to turn, wheel or pinch to zoom,
// right-drag to move. show(step, t) poses the whole scene for step `step` (0-based, same order as STEPS
// in pages/assemble.ts) at t 0..1 of its animation. Each step starts where the one before it ended:
// a step only says what it changes (run(S, t)), and the end of step k is steps 0..k run at t = 1.
// Frame: case mm (LCD PCB bottom-left origin, +y toward the joystick and USB, +z out of the screen),
// the same as wedgie3d / assembly3d. The boards and case parts are the real models (public/3d/).
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadGeo, partGeometry, COLORS } from "./wedgie3d";
import { PART_COLORS, ROW_L, ROW_R, pinY, picoPins, chipBoard, PLUG, copper } from "./parts-geo";

type V3 = [number, number, number];
type O = { p: V3; r: V3; v: number };
type S = { o: Record<string, O>; n: Record<string, number> };
type Label = { txt: string; at: V3; on?: string; t?: [number, number]; bad?: boolean };
type View = { at: V3; on?: string; az: number; el: number; d: number };
type Step3D = { dur: number; view: View; labels?: Label[]; run(s: S, t: number): void };

export type Playground = {
  /** Pose step `i` at t (0..1). A new step also swings the camera to that step's view. */
  show(i: number, t: number): void;
  resetView(): void;
  steps: number;
  durations: number[];
  destroy(): void;
};

const C: V3 = [13.22, 26.25, -8];                          // the middle of the closed case: what things turn about
const STICK: V3 = [13.17, 46.13, 2.05];
const HDR = -10.66;                                         // the open end of the screen board's sockets
const FLAT = 4.8;                                           // board face down: the mat, in case z
const FLAT_UP = -20.8;                                      // face up: the mat, in case z
const holeXY = (x: number, n: number): V3 => [x, pinY(n), HDR];
// the manual's cable: white R3, yellow R5, black L6, red L7 (top to bottom in the plug)
const HOLES = [holeXY(ROW_R, 3), holeXY(ROW_R, 5), holeXY(ROW_L, 6), holeXY(ROW_L, 7)];
const WIRES = [0xf4f4ef, 0xf2c417, 0x232323, 0xd8262a];
const CHIP_LAID: V3 = [13.22, 18, -11.5];
const CHIP_IN: V3 = [13.22, 18, -7.4];
const USB_IN: V3 = [13.22, 48.1, -16.36];
const USB_OUT: V3 = [13.22, 74, -16.36];
const PI = Math.PI;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => { v = clamp(v); return v * v * (3 - 2 * v); };
const E = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const bump = (t: number, a: number, b: number) => Math.sin(clamp((t - a) / (b - a)) * PI);   // 0 -> 1 -> 0

/** Move object `k` toward `to` by k (from wherever this step found it). */
function go(s: S, name: string, to: Partial<O>, k: number) {
  if (k <= 0) return;
  const o = s.o[name];
  if (to.p) o.p = o.p.map((x, i) => lerp(x, to.p![i], k)) as V3;
  if (to.r) o.r = o.r.map((x, i) => lerp(x, to.r![i], k)) as V3;
  if (to.v !== undefined) o.v = lerp(o.v, to.v, k);
}
const num = (s: S, name: string, to: number, k: number) => { if (k > 0) s.n[name] = lerp(s.n[name], to, k); };

// ---- the steps ------------------------------------------------------------------------------------
// view.at is in case mm (inside the turned-over or upright device); az: degrees around, 0 = from the
// front; el: degrees up; d: mm away.
const CAPS = ["A", "B", "X", "Y"];
const CAP_X: Record<string, number> = { Y: 4.8, X: 10.5, B: 16.1, A: 21.8 };
const TOOLS = ["cutters", "strippers", "roll", "poker", "tweezers"];
const LAID_OUT: Record<string, V3> = {                        // step 17: every case part on the mat
  lid: [0, -38, FLAT_UP + 12.36], base: [0, 38, 0],
  ...Object.fromEntries(CAPS.map((k, i) => [k, [-22 - CAP_X[k], 10 + i * 11 - 4, FLAT_UP - 2.61]])),
};

const STEPS3D: Step3D[] = [
  { // 1 Cable and tools
    dur: 3, view: { at: [8, 22, 4], az: 0, el: 62, d: 330 },
    labels: [{ txt: "STEMMA QT / Qwiic cable", at: [13, 72, 3], t: [0.2, 1] }, { txt: "Cutters", at: [-28, 50, 3], t: [0.35, 1] },
      { txt: "Strippers", at: [-28, 2, 3], t: [0.45, 1] }, { txt: "Tape", at: [56, 52, 0], t: [0.55, 1] },
      { txt: "Stiff jumper wire", at: [52, 12, 3], t: [0.65, 1] }, { txt: "Tweezers", at: [56, -16, 3], t: [0.75, 1] }],
    run(s, t) {
      go(s, "root", { r: [0, PI, PI / 2] }, 1);
      TOOLS.forEach((k, i) => go(s, k, { v: 1 }, E(t, 0.1 + i * 0.1, 0.4 + i * 0.1)));
    },
  },
  { // 2 Cut and strip
    dur: 4.2, view: { at: [13, 38, 4], az: 10, el: 58, d: 230 },
    labels: [{ txt: "Cut 2 in (5 cm) from the plug", at: [13, 22, 4], t: [0.05, 0.45] }, { txt: "Strip 5 mm", at: [13, 18, 4], t: [0.62, 1] }],
    run(s, t) {
      go(s, "cutters", { p: [19.5, 22, FLAT - 2.5] }, E(t, 0, 0.22));
      go(s, "cutters", { p: [-30, 50, FLAT - 2.5] }, E(t, 0.3, 0.45));
      go(s, "plug2", { p: [13, -48, 3.3], v: 0 }, E(t, 0.3, 0.55));
      go(s, "strippers", { p: [19.5, 25, FLAT - 2.5] }, E(t, 0.45, 0.62));
      num(s, "strip", 1, E(t, 0.62, 0.9));
      go(s, "strippers", { p: [-30, 2, FLAT - 2.5] }, E(t, 0.85, 1));
      num(s, "fan", 1, E(t, 0.85, 1));
    },
  },
  { // 3 Number the wires: plug them into the Trust M, read them 1 to 4 by place, unplug
    dur: 4.6, view: { at: [13, 56, 4], az: 0, el: 64, d: 160 },
    labels: [{ txt: "Trust M", at: [13, 90, 2], t: [0.12, 0.42] }, { txt: "1 GND", at: [-3.13, 9.3, 0], on: "plug", t: [0.42, 0.84] }, { txt: "2 3V3", at: [-1.87, 21.3, 0], on: "plug", t: [0.47, 0.84] }, { txt: "3 SDA", at: [2.70, 33.3, 0], on: "plug", t: [0.52, 0.84] }, { txt: "4 SCL", at: [10.56, 45.3, 0], on: "plug", t: [0.57, 0.84] }],
    run(s, t) {
      TOOLS.forEach((k) => go(s, k, { v: 0 }, E(t, 0, 0.15)));
      go(s, "chip", { p: [13, 106, FLAT - 0.8], r: [0, PI, PI] }, 1);
      go(s, "chip", { v: 1 }, E(t, 0, 0.12));
      go(s, "chip", { p: [13, 86, FLAT - 0.8] }, E(t, 0.12, 0.38));
      num(s, "plugIn", 1, E(t, 0.12, 0.4));
      num(s, "plugIn", 0, E(t, 0.86, 1));
      go(s, "chip", { p: [13, 106, FLAT - 0.8] }, E(t, 0.86, 1));
    },
  },
  { // 4 Lay out the screen board
    dur: 3.4, view: { at: [13, 34, -10], az: 0, el: 62, d: 170 },
    labels: [{ txt: "USB end", at: [13.2, 52, -11], t: [0.6, 1] }, { txt: "Never the 4th", at: holeXY(ROW_R, 4), t: [0.75, 1], bad: true }],
    run(s, t) {
      go(s, "chip", { v: 0 }, E(t, 0, 0.2));
      go(s, "chip", { p: [-24, 18, FLAT - 0.8], r: [0, PI, 0] }, E(t, 0.2, 0.25));
      go(s, "hat", { p: [0, 0, 0], v: 1 }, E(t, 0.1, 0.55));
      go(s, "plug", { p: [13.22, 16, -12.3], r: [0, 0, 0] }, E(t, 0.25, 0.7));
      num(s, "marks", 1, E(t, 0.6, 0.85));
    },
  },
  { // 5 Wires 1 and 2
    dur: 3.6, view: { at: [8, 38, -10], az: -25, el: 52, d: 120 },
    labels: [{ txt: "1 GND: 3rd", at: HOLES[0], t: [0.08, 0.47] }, { txt: "2 3V3: 5th", at: HOLES[1], t: [0.47, 1] }],
    run(s, t) {
      num(s, "w0", 1, E(t, 0.08, 0.5));
      num(s, "w1", 1, E(t, 0.45, 0.9));
    },
  },
  { // 6 Tape
    dur: 2.4, view: { at: [6, 40, -10], az: -20, el: 55, d: 110 },
    labels: [{ txt: "Tape on top of the wires", at: [ROW_R, 40.6, -11], t: [0.5, 1] }],
    run(s, t) { go(s, "tape1", { p: [ROW_R, 40.6, HDR - 0.1], v: 1 }, E(t, 0.05, 0.6)); },
  },
  { // 7 Poke the holes
    dur: 3.4, view: { at: [6, 40, -14], az: -40, el: 38, d: 120 },
    labels: [{ txt: "Poke through the tape", at: [ROW_R, pinY(3), -16], t: [0.15, 0.85] }],
    run(s, t) {
      const [x, y3] = HOLES[0], y5 = HOLES[1][1];
      go(s, "poker", { p: [x, y3, -30], r: [0, 0, 0], v: 1 }, E(t, 0, 0.15));
      go(s, "poker", { p: [x, y3, HDR + 4] }, E(t, 0.15, 0.3));
      go(s, "poker", { p: [x, y5, -24] }, E(t, 0.32, 0.48));
      go(s, "poker", { p: [x, y5, HDR + 4] }, E(t, 0.5, 0.65));
      go(s, "poker", { p: [x - 20, y5, -40], v: 0 }, E(t, 0.7, 1));
      num(s, "open0", 1, E(t, 0.25, 0.3)); num(s, "open1", 1, E(t, 0.6, 0.65));
    },
  },
  { // 8 Wires 3 and 4
    dur: 5.4, view: { at: [20, 37, -10], az: 25, el: 52, d: 125 },
    labels: [{ txt: "3 SDA: 6th", at: HOLES[2], t: [0.03, 0.27] }, { txt: "4 SCL: 7th", at: HOLES[3], t: [0.27, 0.55] }, { txt: "Tape, then poke", at: [ROW_L, 36.2, -11], t: [0.6, 1] }],
    run(s, t) {
      num(s, "w2", 1, E(t, 0.04, 0.28));
      num(s, "w3", 1, E(t, 0.26, 0.5));
      go(s, "tape2", { p: [ROW_L, 36.2, HDR - 0.1], v: 1 }, E(t, 0.5, 0.64));
      const [x, y6] = HOLES[2], y7 = HOLES[3][1];
      go(s, "poker", { p: [x, y6, -30], v: 1 }, E(t, 0.62, 0.7));
      go(s, "poker", { p: [x, y6, HDR + 4] }, E(t, 0.7, 0.77));
      go(s, "poker", { p: [x, y7, -24] }, E(t, 0.78, 0.84));
      go(s, "poker", { p: [x, y7, HDR + 4] }, E(t, 0.85, 0.91));
      go(s, "poker", { p: [x + 20, y7, -40], v: 0 }, E(t, 0.92, 1));
      num(s, "open2", 1, E(t, 0.75, 0.77)); num(s, "open3", 1, E(t, 0.9, 0.91));
    },
  },
  { // 9 Header ready
    dur: 2.6, view: { at: [13, 36, -10], az: 35, el: 40, d: 150 },
    labels: [{ txt: "4 wires in, taped, holes open", at: [13.2, 40, -12], t: [0.2, 1] }],
    run(s, t) { num(s, "marks", 0.35, E(t, 0.3, 1)); },
  },
  { // 10 Plug in the chip, lay it on the wires
    dur: 4.8, view: { at: [0, 24, -6], az: 20, el: 52, d: 190 },
    labels: [{ txt: "Fits one way", at: [-24, 34, 2], t: [0.35, 0.6] }, { txt: "Face up, over the wires", at: [13.2, 18, -14], t: [0.86, 1] }],
    run(s, t) {
      go(s, "chip", { v: 1 }, E(t, 0, 0.15));
      num(s, "plugIn", 0.5, E(t, 0.12, 0.42));
      num(s, "plugIn", 1, E(t, 0.44, 0.6));
      go(s, "chip", { p: [-6, 18, -22] }, E(t, 0.62, 0.78));
      go(s, "chip", { p: CHIP_LAID }, E(t, 0.78, 0.95));
    },
  },
  { // 11 Snap off extra board
    dur: 3.4, view: { at: [40, 8, 2], az: -30, el: 50, d: 140 },
    labels: [{ txt: "Extra board, away from the USB-C", at: [45.2, -0.7, -16], t: [0.25, 0.65] }, { txt: "Snap", at: [45.2, -2, -18], t: [0.65, 1] }],
    run(s, t) {
      go(s, "pico", { p: [32, 0, FLAT + 6.86], v: 1 }, E(t, 0, 0.3));
      go(s, "tab", { r: [0.55, 0, 0] }, E(t, 0.5, 0.68));
      go(s, "tab", { p: [0, -16, -10], r: [1.2, 0, 0.3], v: 0 }, E(t, 0.7, 1));
    },
  },
  { // 12 Cut off plastic guards (Pico 2 W only)
    dur: 4.4, view: { at: [45, 26, -2], az: -20, el: 58, d: 150 },
    labels: [{ txt: "Pico 2 W only", at: [45.2, 52, -8], t: [0.15, 0.4] },
      { txt: "Cut", at: [13.22, 27, -11.6], on: "pico", t: [0.4, 0.6] }, { txt: "Cut", at: [13.22, 48, -11.6], on: "pico", t: [0.58, 0.78] },
      { txt: "Keep this one", at: [13.22, 5, -11.6], on: "pico", t: [0.78, 1] }],
    run(s, t) {
      go(s, "pico", { p: [32, 0, 2.9], r: [0, PI, 0] }, E(t, 0, 0.3));
      go(s, "cutters", { p: [58.5, 27, -1], v: 1 }, E(t, 0.3, 0.45));
      go(s, "g2", { p: [0, 0, 16], v: 0 }, E(t, 0.45, 0.62));
      go(s, "cutters", { p: [58.5, 48, -1] }, E(t, 0.5, 0.62));
      go(s, "g3", { p: [0, 4, 16], v: 0 }, E(t, 0.64, 0.8));
      go(s, "cutters", { p: [80, 50, -10], v: 0 }, E(t, 0.75, 0.95));
    },
  },
  { // 13 Stack the boards
    dur: 4.6, view: { at: [13, 26, -10], az: -55, el: 22, d: 165 },
    labels: [{ txt: "USB-C at the USB end", at: [13.2, 54, -17], on: "pico", t: [0.25, 0.65] }, { txt: "Push till flush", at: [13.2, 26, -18], on: "pico", t: [0.75, 1] },
      { txt: "Trust M wedged in", at: [13.2, 30, -8], t: [0.82, 1] }],
    run(s, t) {
      go(s, "pico", { p: [32, 0, -20], r: [0, 0, 0] }, E(t, 0, 0.3));
      go(s, "pico", { p: [0, 0, -18] }, E(t, 0.3, 0.55));
      go(s, "pico", { p: [0, 0, 0] }, E(t, 0.6, 0.9));
      go(s, "chip", { p: CHIP_IN, r: [0, PI + 0.85, 0] }, E(t, 0.62, 0.86));
    },
  },
  { // 14 Test the boards
    dur: 5, view: { at: [13, 40, -14], az: -60, el: 38, d: 170 },
    labels: [{ txt: "Hold BOOTSEL", at: [16.5, 39.7, -18], t: [0.05, 0.5] }, { txt: "USB-C data cable", at: [13.2, 66, -17], t: [0.25, 0.5] },
      { txt: "Board ✓  Firmware ✓  Chip ✓", at: [13.2, 20, -20], t: [0.55, 0.9] }],
    run(s, t) {
      go(s, "tweezers", { p: [16.5, 39.7, -17.4], r: [-0.5, 0.4, -0.6], v: 1 }, E(t, 0, 0.2));
      go(s, "usb", { p: USB_OUT, v: 1 }, E(t, 0.12, 0.25));
      go(s, "usb", { p: USB_IN }, E(t, 0.25, 0.4));
      go(s, "tweezers", { p: [40, 70, -40], v: 0 }, E(t, 0.5, 0.65));
      num(s, "led", 1, E(t, 0.42, 0.45));
      go(s, "usb", { p: USB_OUT }, E(t, 0.88, 0.96));
      go(s, "usb", { v: 0 }, E(t, 0.95, 1));
      num(s, "led", 0, E(t, 0.88, 0.9));
    },
  },
  { // 15 Pick the base
    dur: 3.6, view: { at: [13, 26, -14], az: 0, el: 58, d: 300 },
    labels: [{ txt: "Red: Pico W + battery", at: [51, 26, -1], t: [0.55, 1] }, { txt: "Black: Trust M", at: [13, 26, -1], t: [0.55, 1] },
      { txt: "Gray: ATECC608", at: [-25, 26, -1], t: [0.55, 1] }],
    run(s, t) {
      go(s, "stack", { v: 0 }, E(t, 0, 0.25));
      go(s, "root", { r: [0, 0, PI / 2] }, E(t, 0.15, 0.45));
      go(s, "base", { v: 1 }, E(t, 0.4, 0.6));
      go(s, "baseR", { v: 1 }, E(t, 0.45, 0.65));
      go(s, "baseG", { v: 1 }, E(t, 0.5, 0.7));
      go(s, "baseR", { v: 0.3 }, E(t, 0.8, 1)); go(s, "baseG", { v: 0.3 }, E(t, 0.8, 1));
      go(s, "base", { p: [0, 0, 4] }, E(t, 0.8, 1));
    },
  },
  { // 16 Peel the screen protector
    dur: 3, view: { at: [13, 26, -8], az: 15, el: 50, d: 150 },
    labels: [{ txt: "Pull the blue tab", at: [-3, 34, 2.2], on: "hat", t: [0.15, 0.6] }],
    run(s, t) {
      go(s, "baseR", { v: 0 }, E(t, 0, 0.2)); go(s, "baseG", { v: 0 }, E(t, 0, 0.2)); go(s, "base", { v: 0, p: [0, 0, 0] }, E(t, 0, 0.2));
      go(s, "stack", { p: [0, 0, -2.9], v: 1 }, E(t, 0.1, 0.3));
      go(s, "film", { r: [0, 1.4, 0] }, E(t, 0.4, 0.7));
      go(s, "film", { p: [10, 0, 30], v: 0 }, E(t, 0.7, 1));
    },
  },
  { // 17 Case parts
    dur: 3, view: { at: [8, 26, -14], az: 0, el: 64, d: 330 },
    labels: [{ txt: "Lid", at: [13, -12, -6], t: [0.5, 1] }, { txt: "Base", at: [13, 64, -6], t: [0.5, 1] },
      { txt: "Joystick cap", at: [-18, 52, -18], t: [0.6, 1] }, { txt: "Green, gray, gray, red", at: [-18, 22, -18], t: [0.6, 1] }],
    run(s, t) {
      go(s, "stack", { p: [42, 0, -2.9] }, E(t, 0, 0.4));
      go(s, "shell", { v: 1 }, E(t, 0.2, 0.5)); go(s, "base", { v: 1, p: LAID_OUT.base }, E(t, 0.2, 0.5));
      go(s, "lid", { p: LAID_OUT.lid }, 1);
      CAPS.forEach((k) => go(s, k, { p: LAID_OUT[k] }, 1));
      go(s, "joy", { p: [-42 - 31, 6 - 0, -20.4], v: 1 }, 1);
    },
  },
  { // 18 Joystick cap
    dur: 3.2, view: { at: [13, 40, -4], az: -20, el: 40, d: 150 },
    labels: [{ txt: "Square hole on the joystick", at: [13.17, 46.13, 8], t: [0.15, 0.55] }, { txt: "Press hard till it snaps", at: [13.17, 46.13, 8], t: [0.65, 1] }],
    run(s, t) {
      go(s, "stack", { p: [0, 0, -2.9] }, E(t, 0, 0.3));
      go(s, "shell", { v: 0 }, E(t, 0, 0.3)); go(s, "base", { v: 0 }, E(t, 0, 0.3));
      go(s, "joy", { p: [0, 0, 14] }, E(t, 0.15, 0.5));
      go(s, "joy", { p: [0, 0, -0.6] }, E(t, 0.55, 0.72));
      go(s, "joy", { p: [0, 0, 0] }, E(t, 0.72, 0.8));
    },
  },
  { // 19 Buttons into the lid
    dur: 4.4, view: { at: [13, 26, -14], az: 0, el: 56, d: 170 },
    labels: [{ txt: "Lid face down", at: [13, 26, -4], on: "shell", t: [0.05, 0.3] }, { txt: "Green", at: [CAP_X.A, 4, -6], on: "shell", t: [0.3, 1] },
      { txt: "Red", at: [CAP_X.Y, 4, -6], on: "shell", t: [0.75, 1] }],
    run(s, t) {
      go(s, "stack", { p: [44, 0, -2.9] }, E(t, 0, 0.25)); go(s, "base", { p: [44, 64, 0] }, E(t, 0, 0.25));
      go(s, "shell", { v: 1, r: [0, PI, 0], p: [0, 0, 0] }, E(t, 0, 0.3));
      go(s, "lid", { p: [0, 0, 0] }, E(t, 0, 0.3));
      CAPS.forEach((k, i) => {
        go(s, k, { p: [0, 0, -22] }, E(t, 0.2 + i * 0.13, 0.32 + i * 0.13));
        go(s, k, { p: [0, 0, 0] }, E(t, 0.33 + i * 0.13, 0.42 + i * 0.13));
      });
    },
  },
  { // 20 Boards into the base
    dur: 4.2, view: { at: [13, 30, -10], az: -55, el: 32, d: 180 },
    labels: [{ txt: "USB-C end first", at: [13.2, 56, -16], on: "stack", t: [0.25, 0.75] }],
    run(s, t) {
      go(s, "shell", { p: [0, -70, 0] }, E(t, 0, 0.25));
      go(s, "base", { p: [0, 0, 0], v: 1 }, E(t, 0, 0.25));
      go(s, "stack", { p: [0, 8, 30], r: [-0.45, 0, 0] }, E(t, 0.15, 0.4));
      go(s, "stack", { p: [0, 2, 7], r: [-0.22, 0, 0] }, E(t, 0.42, 0.65));
      go(s, "stack", { p: [0, 0, 0], r: [0, 0, 0] }, E(t, 0.68, 0.92));
    },
  },
  { // 21 Check the USB-C fit
    dur: 2.4, view: { at: [13.2, 55, -14], az: -88, el: 18, d: 125 },
    labels: [{ txt: "Port right in the middle of the hole", at: [13.22, 54.6, -16.4], t: [0.2, 1] }],
    run() {},
  },
  { // 22 Close the case
    dur: 4.2, view: { at: [13, -20, -10], az: -25, el: 30, d: 230 },
    labels: [{ txt: "Flip it over", at: [13, 26, 0], on: "core", t: [0.1, 0.4] }, { txt: "Press hard till it snaps", at: [13, -44, 0], t: [0.75, 1] }],
    run(s, t) {
      go(s, "core", { p: [0, 0, 34] }, E(t, 0, 0.25));
      go(s, "core", { r: [0, PI, 0] }, E(t, 0.15, 0.45));
      go(s, "core", { p: [0, -70, 30] }, E(t, 0.35, 0.6));
      go(s, "core", { p: [0, -70, -0.6] }, E(t, 0.6, 0.84));
      go(s, "core", { p: [0, -70, 0] }, E(t, 0.86, 0.92));
    },
  },
  { // 23 Check the feel
    dur: 4.6, view: { at: [13, 26, -6], az: -15, el: 42, d: 150 },
    labels: [{ txt: "Every button clicks", at: [13, 4, 7], t: [0.3, 0.65] }, { txt: "Joystick, every way and in", at: [13.17, 46.13, 8], t: [0.65, 1] }],
    run(s, t) {
      for (const k of ["core", "shell"]) go(s, k, { p: [0, 0, 0], r: [0, 0, 0] }, E(t, 0, 0.3));
      CAPS.forEach((k, i) => { s.o[k].p[2] -= 1 * bump(t, 0.32 + i * 0.07, 0.4 + i * 0.07); });
      const j = s.o.joy;
      j.r[1] += 0.22 * bump(t, 0.62, 0.7); j.r[1] -= 0.22 * bump(t, 0.7, 0.78);
      j.r[0] += 0.22 * bump(t, 0.78, 0.86); j.r[0] -= 0.22 * bump(t, 0.86, 0.93);
      j.p[2] -= 0.6 * bump(t, 0.93, 1);
    },
  },
  { // 24 Full test
    dur: 7, view: { at: [13, 30, -6], az: -30, el: 45, d: 190 },
    labels: [{ txt: "Press green", at: [CAP_X.A, 4, 7], t: [0.4, 0.55] }, { txt: "Shake it", at: [13, 26, 10], t: [0.56, 0.78] }, { txt: "PASS", at: [13, 26, 8], t: [0.85, 1] }],
    run(s, t) {
      go(s, "usb", { p: USB_OUT, v: 1 }, E(t, 0, 0.08));
      go(s, "usb", { p: USB_IN }, E(t, 0.08, 0.16));
      num(s, "scr", 1, t > 0.17 ? 1 : 0); num(s, "scrK", 1, E(t, 0.17, 0.32));
      if (t > 0.32) s.n.scr = 2;
      if (t > 0.4) s.n.scr = 3;
      s.o.A.p[2] -= 1 * bump(t, 0.5, 0.55);
      if (t > 0.56) s.n.scr = 4;
      const sh = bump(t, 0.58, 0.8) * Math.sin(t * 160);
      s.o.root.r[0] += sh * 0.05; s.o.root.p[2] += Math.abs(sh) * 4;
      if (t > 0.84) s.n.scr = 5;
    },
  },
  { // 25 Box it
    dur: 4, view: { at: [13, 26, -8], az: -10, el: 55, d: 220 },
    labels: [{ txt: "Done. Build the next one", at: [13, 26, 12], t: [0.8, 1] }],
    run(s, t) {
      go(s, "usb", { p: USB_OUT }, E(t, 0, 0.12)); go(s, "usb", { v: 0 }, E(t, 0.1, 0.18));
      num(s, "scr", 0, t > 0.15 ? 1 : 0);
      for (const k of ["core", "shell"]) go(s, k, { p: [0, 0, 44] }, E(t, 0.1, 0.35));
      go(s, "box", { v: 1 }, E(t, 0.2, 0.4));
      for (const k of ["core", "shell"]) go(s, k, { p: [0, 0, 0] }, E(t, 0.4, 0.65));
      go(s, "boxlid", { r: [0, 0, 0] }, E(t, 0.68, 0.95));
    },
  },
];

// ---- the models ------------------------------------------------------------------------------------
const std = (color: number, roughness = 0.55, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const plastic = (color: number, roughness = 0.5) => new THREE.MeshPhysicalMaterial({ color, roughness, clearcoat: 0.2, clearcoatRoughness: 0.5 });
const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b;
};

/** A 4-pin JST-SH plug: wires leave along +y, at x = (i - 1.5) * 1.1. */
function jstPlug() {
  const g = new THREE.Group();
  g.add(box(5.8, 4.2, 3, std(0xf1ede2, 0.7)));
  return g;
}
/** Pliers-like hand tool: jaws at the origin pointing -x, handles out along +x. */
function pliers(handle: number) {
  const g = new THREE.Group(), steel = std(0xb9bcc0, 0.3, 0.9);
  g.add(box(16, 5, 3, steel, 2, 0, 0));
  const h1 = box(62, 7, 5, plastic(handle, 0.6), 40, 6, 0); h1.rotation.z = 0.12;
  const h2 = box(62, 7, 5, plastic(handle, 0.6), 40, -6, 0); h2.rotation.z = -0.12;
  g.add(h1, h2);
  return g;
}
function tapeRoll() {
  const g = new THREE.Group();
  const pts = [[9, -6], [15, -6], [15, 6], [9, 6], [9, -6]].map(([x, y]) => new THREE.Vector2(x, y));
  const ring = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), std(0x161616, 0.35));
  ring.rotation.x = PI / 2;
  g.add(ring);
  return g;
}
/** The stiff jumper wire: gold tip at the origin pointing +z, black housing, a short bit of wire. */
function poker() {
  const g = new THREE.Group();
  g.add(box(0.64, 0.64, 6, std(0xd4a94a, 0.3, 0.9), 0, 0, -3));
  g.add(box(2.5, 2.5, 14, std(0x151515, 0.6), 0, 0, -13));
  const w = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 50, 10), std(0x2f6fd6, 0.45));
  w.rotation.x = PI / 2; w.position.z = -45;
  g.add(w);
  return g;
}
/** Tweezers: tips at the origin, the arms running up along +z. */
function tweezers() {
  const g = new THREE.Group(), steel = std(0xc7c9cc, 0.25, 0.9);
  for (const s of [-1, 1]) { const a = box(0.9, 3.2, 95, steel, s * 1.8, 0, 47); a.rotation.y = -s * 0.035; g.add(a); }
  return g;
}
/** A USB-C plug and its cable: the tip's front at the origin, pointing -y. */
function usbPlug() {
  const g = new THREE.Group();
  g.add(box(8.3, 6.5, 2.5, std(0xc9ccd0, 0.25, 0.95), 0, 3.25, 0));
  g.add(box(11, 18, 6, std(0x2a2b2d, 0.6), 0, 15.5, 0));
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 24, 0), new THREE.Vector3(0, 40, 0), new THREE.Vector3(8, 70, 0), new THREE.Vector3(26, 110, 0)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 1.8, 10, false), std(0x2a2b2d, 0.6)));
  return g;
}
/** A cardboard box around the closed wedgie (case mm), open at the top. */
function cardboard() {
  const g = new THREE.Group(), m = std(0xc49a6c, 0.9);
  const [x0, x1, y0, y1, z0, z1] = [-6, 32.4, -6, 58.5, -21.6, 9];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, l = y1 - y0, h = z1 - z0;
  g.add(box(w, l, 1, m, cx, cy, z0));
  g.add(box(1, l, h, m, x0, cy, cz), box(1, l, h, m, x1, cy, cz), box(w, 1, h, m, cx, y0, cz), box(w, 1, h, m, cx, y1, cz));
  return g;
}

// The cutting mat under it all, like the photos.
function matTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 1024;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1d7f5f"; g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = "rgba(255,255,255,.55)";
  for (let i = 0; i <= 16; i++) { g.lineWidth = i % 4 === 0 ? 3 : 1.4; const x = i * 64; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1024); g.moveTo(0, x); g.lineTo(1024, x); g.stroke(); }
  g.lineWidth = 2; g.beginPath(); g.moveTo(0, 1024); g.lineTo(1024, 0); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ---- the stage -------------------------------------------------------------------------------------
export async function mountPlayground(el: HTMLElement): Promise<Playground> {
  const { meta, bin } = await loadGeo();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const cv = renderer.domElement;
  cv.className = "pg-canvas";
  cv.tabIndex = 0;
  cv.setAttribute("aria-label", "The wedgie in 3D. Drag to turn it, scroll or pinch to zoom.");
  el.appendChild(cv);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(30, 1, 5, 4000);
  camera.up.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-60, -80, 260);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 8;
  key.shadow.bias = -0.0004;
  Object.assign(key.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 20, far: 600 });
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x9aa7a0, 0.5));
  scene.fog = new THREE.Fog(0xe2e2de, 450, 1400);           // the mat fades into the stage, no edge
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.92 }));
  (mat.material as THREE.MeshStandardMaterial).map!.wrapS = (mat.material as THREE.MeshStandardMaterial).map!.wrapT = THREE.RepeatWrapping;
  (mat.material as THREE.MeshStandardMaterial).map!.repeat.set(4, 4);
  mat.position.z = -30;
  mat.receiveShadow = true;
  scene.add(mat);

  // Objects: a handle group (moved by the state) holding the content, offset so it turns about `pivot`.
  type Obj = { g: THREE.Group; c: THREE.Group; pivot: V3; meshes: THREE.Mesh[]; parent: string | null; v: number };
  const objs: Record<string, Obj> = {};
  const order: string[] = [];
  function obj(name: string, parent: string | null, content: THREE.Object3D | THREE.Object3D[], pivot: V3 = [0, 0, 0]) {
    const g = new THREE.Group(), c = new THREE.Group();
    c.position.set(-pivot[0], -pivot[1], -pivot[2]);
    g.add(c);
    for (const x of Array.isArray(content) ? content : [content]) c.add(x);
    const meshes: THREE.Mesh[] = [];
    c.traverse((m) => {
      if (!(m as THREE.Mesh).isMesh) return;
      const mesh = m as THREE.Mesh;
      mesh.material = (mesh.material as THREE.Material).clone();
      if (!mesh.userData.noShadow) mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.op = (mesh.material as THREE.Material).opacity;
      meshes.push(mesh);
    });
    (parent ? objs[parent].c : scene).add(g);
    objs[name] = { g, c, pivot, meshes, parent, v: 1 };
    order.push(name);
    return objs[name];
  }
  const part = (name: string, m: THREE.Material) => new THREE.Mesh(partGeometry(meta.parts.find((q) => q.name === name)!, bin), m);

  obj("root", null, [], C);
  obj("core", "root", [], C);
  obj("stack", "core", [], C);
  obj("base", "core", part("base", plastic(COLORS.base, 0.55)), C);
  obj("baseR", "root", part("base", plastic(0xb3302a, 0.55)), C);
  obj("baseG", "root", part("base", plastic(0x9a9da1, 0.55)), C);
  obj("shell", "root", [], C);
  obj("lid", "shell", part("lid", plastic(COLORS.lid)), C);
  for (const k of CAPS) obj(k, "shell", part(k, plastic(COLORS[k], 0.8)), C);

  // the screen board, its glass and the live screen, the protector film
  const G = meta.glass;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(G.w, G.h), new THREE.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.08, clearcoat: 1 }));
  glass.position.set(G.cx, G.cy, G.z + 0.02);
  const scr = document.createElement("canvas");
  scr.width = scr.height = 240;
  const sg = scr.getContext("2d")!;
  const scrTex = new THREE.CanvasTexture(scr);
  scrTex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(23.4, 23.4), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false, transparent: true }));
  screen.position.set(G.cx, G.cy, G.z + 0.05);
  screen.rotation.z = -PI / 2;
  screen.userData.noShadow = true;
  obj("hat", "stack", [part("hat", std(PART_COLORS.hat, 0.6)), glass, screen], C);
  const filmM = new THREE.MeshPhysicalMaterial({ color: 0x9fc4ff, roughness: 0.15, transparent: true, opacity: 0.45, clearcoat: 1 });
  const film = new THREE.Mesh(new THREE.BoxGeometry(G.w + 0.6, G.h + 0.6, 0.12), filmM);
  film.position.set(G.cx, G.cy, G.z + 0.14);
  const filmTab = box(6, 5, 0.14, std(0x2f6fd6, 0.5), -2.2, 34, G.z + 0.14);
  obj("film", "hat", [film, filmTab], [25.7, 26.1, G.z + 0.14]);

  // the Pico: its pins, the extra board on its end, the 3 plastic guards of a Pico 2 W
  const picoMesh = part("pico", std(PART_COLORS.pico, 0.55));
  const led = box(1.4, 1, 0.5, new THREE.MeshBasicMaterial({ color: 0x3a3a3a }), 7.2, 49, -15.8);
  const port = [box(8.9, 7.3, 3.1, std(0xc9ccd0, 0.25, 0.95), 13.22, 50.6, -16.36), box(7, 0.1, 1.5, std(0x111111, 0.8), 13.22, 54.26, -16.36)];
  obj("pico", "stack", [picoMesh, picoPins(), led, ...port], C);
  obj("tab", "pico", box(20.8, 2.9, 1.23, std(PART_COLORS.pico, 0.55), 13.22, -0.72, -14.88), [13.22, 0.73, -14.26]);
  const guard = (y: number) => box(ROW_L - ROW_R - 2.5, 2, 2.5, std(0x151515, 0.7), 13.22, y, -13.01);
  obj("g1", "pico", guard(5), C); obj("g2", "pico", guard(27), C); obj("g3", "pico", guard(48), C);

  // the chip and the cable
  obj("chip", "stack", chipBoard());
  obj("plug", "stack", jstPlug());
  const off: THREE.Mesh[] = WIRES.map((c, i) => {            // the cut-off half of the cable, on the far plug
    const x = -(i - 1.5) * 1.1;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 2.1, 0), new THREE.Vector3(x, 25, 0.4), new THREE.Vector3(x, 50, 0)]);
    return new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.5, 8, false), std(c, 0.45));
  });
  obj("plug2", "stack", [jstPlug(), ...off]);
  const ins = WIRES.map((c) => new THREE.Mesh(new THREE.BufferGeometry(), std(c, 0.45)));
  const cu = WIRES.map(() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 8), copper()); return m; });
  const slugs = WIRES.map((c) => new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 5, 10), std(c, 0.45)));
  obj("wires", "stack", [...ins, ...cu]);
  obj("slugs", "stack", slugs);
  const tapeM = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.35, transparent: true, opacity: 0.9 });
  obj("tape1", "stack", box(6.4, 9.6, 0.16, tapeM));
  obj("tape2", "stack", box(6.4, 7.6, 0.16, tapeM));
  // the four sockets the wires use, ringed in their colors; the 4th on the right, struck out
  const marks: THREE.Mesh[] = [];
  HOLES.forEach(([x, y], i) => {
    const r = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.6, 28), new THREE.MeshBasicMaterial({ color: i === 2 ? 0x8a8a8a : WIRES[i], side: THREE.DoubleSide, toneMapped: false, transparent: true }));
    r.position.set(x, y, HDR - 0.05); r.userData.noShadow = true; marks.push(r);
  });
  for (const a of [PI / 4, -PI / 4]) {
    const x = box(3.2, 0.5, 0.05, new THREE.MeshBasicMaterial({ color: 0xe3312c, toneMapped: false, transparent: true }), ROW_R, pinY(4), HDR - 0.08);
    x.rotation.z = a; x.userData.noShadow = true; marks.push(x);
  }
  obj("marks", "stack", marks);
  // holes poked open: a dark dot through the tape
  const opened = HOLES.map(([x, y]) => { const d = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, transparent: true })); d.position.set(x, y, HDR - 0.2); d.userData.noShadow = true; return d; });
  obj("holes", "stack", opened);
  obj("joy", "stack", part("joystick", plastic(COLORS.joystick, 0.8)), STICK);
  obj("usb", "stack", usbPlug());

  // tools, lying on the mat (board face down: the mat is case z = FLAT)
  obj("cutters", "root", pliers(0xd8322c));
  obj("strippers", "root", pliers(0xf2c417));
  obj("roll", "root", tapeRoll());
  obj("poker", "stack", poker());
  obj("tweezers", "root", tweezers());
  obj("box", "root", cardboard());
  const lidBox = box(39.4, 65.5, 1, std(0xc49a6c, 0.9), -19.7, 0, 0);
  obj("boxlid", "box", lidBox, [32.9, 26.25, 9.5]);     // hinged on the far long edge, folds over the top
  lidBox.position.set(32.9 - 19.7, 26.25, 9.5);

  // ---- the first state: everything where step 1 finds it -------------------------------------------
  const o = (p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], v = 1): O => ({ p, r, v });
  const s0: S = {
    o: {
      root: o([-C[0], -C[1], -9.2], [0, PI, PI / 2]), core: o(), stack: o(), shell: o([0, 0, 0], [0, 0, 0], 0),
      base: o([0, 0, 0], [0, 0, 0], 0), baseR: o([38, 0, 0], [0, 0, 0], 0), baseG: o([-38, 0, 0], [0, 0, 0], 0),
      lid: o(), A: o(), B: o(), X: o(), Y: o(),
      hat: o([0, 0, -24], [0, 0, 0], 0), film: o(), pico: o([32, 0, -10], [0, 0, 0], 0), tab: o(), g1: o(), g2: o(), g3: o(),
      chip: o([-24, 18, -10], [0, PI, 0], 0), plug: o([13, 72, FLAT - 1.5], [0, 0, PI]), plug2: o([13, -28, FLAT - 1.5]),
      wires: o(), slugs: o(), tape1: o([ROW_R, 40.6, -26], [0, 0, 0], 0), tape2: o([ROW_L, 36.2, -26], [0, 0, 0], 0),
      marks: o(), holes: o(), joy: o([0, 0, 0], [0, 0, 0], 0), usb: o(USB_OUT, [0, 0, 0], 0),
      cutters: o([-30, 50, FLAT - 2.5], [0, 0, 0], 0), strippers: o([-30, 2, FLAT - 2.5], [0, 0, 0], 0), roll: o([60, 50, FLAT - 6], [0, 0, 0], 0),
      poker: o([48, 12, FLAT - 1.3], [0, PI / 2, 0.3], 0), tweezers: o([48, -20, FLAT - 1.8], [0, PI / 2, 0.1], 0),
      box: o([0, 0, 0], [0, 0, 0], 0), boxlid: o([0, 0, 0], [0, 2.2, 0]),
    },
    n: { strip: 0, fan: 0, w0: 0, w1: 0, w2: 0, w3: 0, plugIn: 0, marks: 0, open0: 0, open1: 0, open2: 0, open3: 0, led: 0, scr: 0, scrK: 0 },
  };
  const clone = (s: S): S => ({ o: Object.fromEntries(Object.entries(s.o).map(([k, v]) => [k, { p: [...v.p] as V3, r: [...v.r] as V3, v: v.v }])), n: { ...s.n } });
  const ends: S[] = [];
  let prev = s0;
  for (const st of STEPS3D) { const s = clone(prev); st.run(s, 1); ends.push(s); prev = s; }
  const stateAt = (i: number, t: number) => { const s = clone(i ? ends[i - 1] : s0); STEPS3D[i].run(s, t); return s; };

  // ---- state -> scene --------------------------------------------------------------------------------
  const v3 = new THREE.Vector3(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  const plugM = new THREE.Matrix4(), freeM = new THREE.Matrix4(), chipPlug = new THREE.Matrix4();
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), sc = new THREE.Vector3();
  function opacity(ob: Obj, v: number) {
    ob.g.visible = v > 0.005;
    for (const m of ob.meshes) {
      const mt = m.material as THREE.Material, want = (m.userData.op as number) * v, tr = want < 0.999;
      mt.opacity = want;
      if (mt.transparent !== tr) { mt.transparent = tr; mt.needsUpdate = true; }
      mt.depthWrite = want > 0.6;
    }
  }

  function apply(s: S) {
    for (const name of order) {
      const ob = objs[name], st = s.o[name] || { p: [0, 0, 0], r: [0, 0, 0], v: 1 };
      ob.g.position.set(ob.pivot[0] + st.p[0], ob.pivot[1] + st.p[1], ob.pivot[2] + st.p[2]);
      ob.g.rotation.set(st.r[0], st.r[1], st.r[2], name === "root" ? "ZYX" : "XYZ");
      ob.v = st.v * (ob.parent ? objs[ob.parent].v : 1);
      opacity(ob, ob.v);
    }
    // the plug: free, or lined up with the chip's socket (plugIn 0.5), or in it (1)
    const pl = objs.plug, ch = objs.chip;
    ch.g.updateMatrix(); pl.g.updateMatrix();
    freeM.copy(pl.g.matrix);
    const k = s.n.plugIn;
    if (k > 0) {
      const out = k < 0.5 ? 7 : 7 * (1 - ease((k - 0.5) / 0.5));
      chipPlug.copy(ch.g.matrix).multiply(new THREE.Matrix4().makeTranslation(PLUG.x, PLUG.y + 0.5 + out, PLUG.z));
      freeM.decompose(pa, qa, sc); chipPlug.decompose(pb, qb, sc);
      const f = k < 0.5 ? ease(k / 0.5) : 1;
      pa.lerp(pb, f); qa.slerp(qb, f);
      pl.g.position.copy(pa); pl.g.quaternion.copy(qa);
      pl.g.updateMatrix();
    }
    plugM.copy(pl.g.matrix);
    placeWires(s);
    opacity(objs.marks, objs.marks.v * s.n.marks);
    opened.forEach((d, i) => { d.visible = s.n["open" + i] > 0.5; });
    (led.material as THREE.MeshBasicMaterial).color.set(s.n.led > 0.5 ? 0x5dff7a : 0x3a3a3a);
    drawScreen(s.n.scr, s.n.scrK);
  }

  const dirFree = new THREE.Vector3(), tipFree = new THREE.Vector3(), start = new THREE.Vector3(), d0 = new THREE.Vector3();
  function placeWires(s: S) {
    q.setFromRotationMatrix(plugM);
    d0.set(0, 1, 0).applyQuaternion(q);
    const cuLen = 5 * clamp(s.n.strip * 2);
    WIRES.forEach((_, i) => {
      start.set((i - 1.5) * 1.1, 2.1, 0).applyMatrix4(plugM);
      tipFree.copy(start).addScaledVector(d0, 48);
      const side = new THREE.Vector3((i - 1.5) * 1.1 * 6 * s.n.fan, 0, 0).applyQuaternion(q);
      tipFree.add(side);
      dirFree.copy(d0);
      const w = s.n["w" + i];
      const H = new THREE.Vector3(...HOLES[i]), hover = H.clone().add(new THREE.Vector3(0, 0, -9)), into = new THREE.Vector3(0, 0, 1);
      const end = new THREE.Vector3(), dir = new THREE.Vector3();
      if (w < 0.6) { const f = ease(w / 0.6); end.copy(tipFree).lerp(hover, f); dir.copy(dirFree).lerp(into, f).normalize(); }
      else { end.copy(hover).lerp(H, ease((w - 0.6) / 0.4)); dir.copy(into); }
      end.addScaledVector(dir, -0.2);
      const a = start.clone().addScaledVector(d0, 6), b = end.clone().addScaledVector(dir, -7);
      const mid = a.clone().lerp(b, 0.5);
      ins[i].geometry.dispose();
      ins[i].geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([start, a, mid, b, end]), 48, 0.5, 8, false);
      cu[i].visible = cuLen > 0.05;
      cu[i].scale.set(1, cuLen || 0.001, 1);
      cu[i].position.copy(end).addScaledVector(dir, cuLen / 2);
      cu[i].quaternion.setFromUnitVectors(UP, dir);
      const sl = slugs[i];
      sl.visible = s.n.strip > 0.02 && s.n.strip < 0.98;
      sl.position.copy(end).addScaledVector(dir, 2.5 + s.n.strip * 14);
      sl.quaternion.setFromUnitVectors(UP, dir);
    });
  }

  // the screen: off, booting (the logo and the bar), home, FULL CONTROL, shake, PASS
  const logo = new Image();
  logo.src = "/img/loader-logo.webp";
  let lastScr = "";
  function drawScreen(mode: number, k: number) {
    const id = mode + ":" + (mode === 1 ? k.toFixed(2) : "") + logo.complete;
    if (id === lastScr) return;
    lastScr = id;
    screen.visible = mode > 0.5;
    const R = (x: number, y: number, w: number, h: number, r: number) => { sg.beginPath(); sg.roundRect(x, y, w, h, r); };
    const txt = (t: string, y: number, size: number, color: string) => { sg.fillStyle = color; sg.font = `${size}px Silkscreen, monospace`; sg.textAlign = "center"; sg.textBaseline = "middle"; sg.fillText(t, 120, y); };
    sg.fillStyle = "#fefefe"; sg.fillRect(0, 0, 240, 240);
    if (mode === 1 || mode === 2) {
      if (logo.complete) sg.drawImage(logo, 72, mode === 1 ? 74 : 60, 96, 77);
      if (mode === 1) {
        const x = 45, y = 166, w = 150, h = 30;
        sg.fillStyle = "#eceded"; R(x, y, w, h, 15); sg.fill();
        sg.fillStyle = "#c9cacc"; R(x + 11, y + 7, w - 22, h - 14, 8); sg.fill();
        const gr = sg.createLinearGradient(0, y + 9, 0, y + 21);
        gr.addColorStop(0, k >= 0.95 ? "#46cd64" : "#7c7d7f"); gr.addColorStop(1, k >= 0.95 ? "#168c34" : "#48494b");
        sg.fillStyle = gr; R(x + 13, y + 9, 12 + (w - 38) * k, h - 18, 6); sg.fill();
      } else txt("wedgie.dev", 170, 22, "#1a1b1a");
    } else if (mode === 3) {
      sg.fillStyle = "#d8322c"; sg.fillRect(0, 0, 240, 240);
      txt("FULL", 90, 34, "#fff"); txt("CONTROL", 130, 34, "#fff");
      sg.fillStyle = "#27a84a"; sg.beginPath(); sg.arc(120, 190, 16, 0, PI * 2); sg.fill();
    } else if (mode === 4) {
      txt("SHAKE", 100, 40, "#1a1b1a"); txt("12", 160, 30, "#6b6e6b");
    } else if (mode === 5) {
      sg.fillStyle = "#27a84a"; sg.fillRect(0, 0, 240, 240);
      txt("PASS", 120, 52, "#fff");
    }
    scrTex.needsUpdate = true;
  }

  // ---- labels: pills with an arrow down to the spot -----------------------------------------------
  const labelEls: HTMLElement[] = [];
  const getLabel = (i: number) => {
    while (labelEls.length <= i) {
      const d = document.createElement("div");
      d.className = "pg-label";
      d.innerHTML = "<span></span><i></i>";
      el.appendChild(d);
      labelEls.push(d);
    }
    return labelEls[i];
  };
  const lp = new THREE.Vector3();
  function placeLabels(i: number, t: number) {
    const ls = STEPS3D[i].labels || [];
    labelEls.forEach((d, j) => { if (j >= ls.length) d.style.opacity = "0"; });
    ls.forEach((l, j) => {
      const d = getLabel(j);
      const span = d.firstElementChild as HTMLElement;
      if (span.textContent !== l.txt) span.textContent = l.txt;
      d.classList.toggle("bad", !!l.bad);
      const [a, b] = l.t || [0, 1];
      const show = t < a || t > b ? 0 : Math.min(a === 0 ? 1 : clamp((t - a) / 0.06), b >= 1 ? 1 : clamp((b - t) / 0.06));
      lp.set(...l.at);
      objs[l.on || "root"].c.localToWorld(lp);
      lp.project(camera);
      const vis = show > 0 && lp.z < 1;
      d.style.opacity = vis ? String(clamp(show)) : "0";
      if (vis) d.style.transform = `translate(${((lp.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-lp.y * 0.5 + 0.5) * H).toFixed(1)}px)`;
    });
  }

  // ---- camera: free to orbit; each new step swings it to that step's view ------------------------
  const controls = new OrbitControls(camera, cv);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 30;
  controls.maxDistance = 900;
  controls.maxPolarAngle = PI * 0.62;
  controls.zoomToCursor = true;
  let W = 0, H = 0;
  type Cam = { tg: THREE.Vector3; az: number; el: number; d: number };
  const camOf = (): Cam => {
    const off = camera.position.clone().sub(controls.target), d = off.length();
    return { tg: controls.target.clone(), az: Math.atan2(off.x, -off.y), el: Math.asin(off.z / d), d };
  };
  const setCam = (c: Cam) => {
    controls.target.copy(c.tg);
    camera.position.set(c.tg.x + c.d * Math.sin(c.az) * Math.cos(c.el), c.tg.y - c.d * Math.cos(c.az) * Math.cos(c.el), c.tg.z + c.d * Math.sin(c.el));
    camera.lookAt(c.tg);
  };
  let tween: { from: Cam; to: Cam; t0: number } | null = null;
  controls.addEventListener("start", () => { tween = null; });
  function viewFor(i: number): Cam {
    apply(ends[i]);
    scene.updateMatrixWorld(true);
    const v = STEPS3D[i].view;
    const tg = new THREE.Vector3(...v.at);
    objs[v.on || "root"].c.localToWorld(tg);
    const narrow = W / H < 1.25 ? Math.pow(1.25 / (W / H), 0.85) : 1;
    return { tg, az: (v.az * PI) / 180, el: (v.el * PI) / 180, d: v.d * narrow };
  }
  function swing(i: number, now = false) {
    const to = viewFor(i);
    if (now) { tween = null; setCam(to); return; }
    const from = camOf();
    let da = to.az - from.az;
    while (da > PI) da -= 2 * PI;
    while (da < -PI) da += 2 * PI;
    to.az = from.az + da;
    tween = { from, to, t0: performance.now() };
  }

  const resize = () => {
    W = el.clientWidth; H = el.clientHeight;
    renderer.setSize(W, H, false);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  let cur = -1, curT = 0, dirty = true;
  function show(i: number, t: number) {
    i = Math.max(0, Math.min(STEPS3D.length - 1, i));
    const fresh = i !== cur;
    if (fresh) swing(i, cur < 0);
    cur = i; curT = clamp(t); dirty = true;
  }

  let raf = 0, dead = false;
  function loop() {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden || cur < 0) return;
    if (tween) {
      const k = ease((performance.now() - tween.t0) / 1100), a = tween.from, b = tween.to;
      setCam({ tg: a.tg.clone().lerp(b.tg, k), az: lerp(a.az, b.az, k), el: lerp(a.el, b.el, k), d: lerp(a.d, b.d, k) });
      if (k >= 1) tween = null;
    }
    controls.update();
    if (dirty) { apply(stateAt(cur, curT)); dirty = false; }
    renderer.render(scene, camera);
    placeLabels(cur, curT);
  }
  loop();

  return {
    show,
    resetView() { if (cur >= 0) swing(cur); },
    steps: STEPS3D.length,
    durations: STEPS3D.map((s) => s.dur),
    destroy() {
      dead = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); pmrem.dispose(); cv.remove();
      labelEls.forEach((d) => d.remove());
    },
  };
}
