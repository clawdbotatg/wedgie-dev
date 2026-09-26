// The page half of the virtual wedgie: the plastic device (deviceSvg) with a live 240x240 canvas on
// its screen, clickable/touchable buttons, keyboard while focused, and the Worker that runs the
// firmware. Loaded only by mountVirtualWedgie() (index.ts).
import { deviceSvg, setKey } from "../ui/device";
import type { VirtualWedgie, VirtualWedgieOptions, FrameInfo } from "./index";

// Same order and layout as runtime.ts (see KEY_SLOTS there).
const KEY_ORDER = ["A", "B", "X", "Y", "up", "down", "left", "right", "press"];
const PRESSES = 16, SEEN_DOWN = 32, SEEN_UP = 48, KEY_SLOTS = 64;
// Keyboard while the device has focus: arrows = joystick, Enter/Space = joystick press, A B X Y = buttons.
const KEYMAP: Record<string, string> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "press", " ": "press",
  a: "A", b: "B", x: "X", y: "Y", A: "A", B: "B", X: "X", Y: "Y",
};
// The screen in the SVG: x=118 y=38 104x104 in viewBox "-14 -8 368 214".
const VB = { x: -14, y: -8, w: 368, h: 214 }, SCR = { x: 118, y: 38, w: 104 };
const JOY = { cx: 58, cy: 90, press: 15 };
const BL_PIN = 13;

const CSS = `
.vw{position:relative;outline:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;border-radius:28px}
.vw:focus-visible{box-shadow:0 0 0 3px #fefefe,0 0 0 6px #22c452}
.vw svg{display:block;width:100%;height:auto;overflow:visible}
.vw canvas{position:absolute;left:${pct(SCR.x - VB.x, VB.w)};top:${pct(SCR.y - VB.y, VB.h)};width:${pct(SCR.w, VB.w)};height:${pct(SCR.w, VB.h)};
  border-radius:3%;opacity:0;transition:opacity .12s;pointer-events:none}
.vw .k,.vw .joy{cursor:pointer;touch-action:none}
.vw .k .cap{transition:filter .08s}
.vw .k.down .cap{filter:brightness(1.45) saturate(1.3)}
.vw .arrow{fill:#b9b8b3}
.vw .arrow.down{fill:#f2b233}
.vw .kl{font:700 11px/1 system-ui,sans-serif;fill:#fff;pointer-events:none}
`;
function pct(a: number, b: number) { return ((a / b) * 100).toFixed(3) + "%"; }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number) {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await sleep(5);
}

export async function mount(el: HTMLElement, opts: VirtualWedgieOptions): Promise<VirtualWedgie> {
  if (!document.getElementById("vw-css")) {
    const st = document.createElement("style");
    st.id = "vw-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = document.createElement("div");
  root.className = "vw";
  root.tabIndex = 0;
  root.setAttribute("role", "application");
  root.setAttribute("aria-label", "virtual wedgie: arrows move the joystick, Enter presses it, A B X Y are the buttons");
  root.innerHTML = deviceSvg({ kind: "loading", p: 0.35 });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  root.appendChild(canvas);
  el.appendChild(root);
  const svg = root.querySelector("svg")!;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(240, 240);

  // ---- keys: a SharedArrayBuffer the worker reads even mid-loop, else postMessage ----------
  const sab = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
  const keyBuf = sab ? new SharedArrayBuffer(KEY_SLOTS * 4) : new ArrayBuffer(KEY_SLOTS * 4);
  const keys = new Int32Array(keyBuf);
  const serialSab = sab ? new SharedArrayBuffer(8 + 65536) : null;
  const serialCtl = serialSab ? new Int32Array(serialSab, 0, 2) : null;
  const serialBuf = serialSab ? new Uint8Array(serialSab, 8) : null;

  let worker: Worker | null = null;
  let frames = 0, fpsCount = 0, fps = 0, seq = 0, destroyed = false;
  const frameCbs = new Set<(f: FrameInfo) => void>();
  const outCbs = new Set<(line: string) => void>();
  const waiting = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; lines: string[] }>();
  let capturing: { lines: string[] } | null = null;
  let booted: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const fpsTimer = setInterval(() => { fps = fpsCount; fpsCount = 0; }, 1000);

  function hold(key: string, down: boolean) {
    const name = KEY_ORDER.find((k) => k.toLowerCase() === String(key).toLowerCase());
    if (!name) throw new Error(`key must be one of ${KEY_ORDER.join(" ")}`);
    const i = KEY_ORDER.indexOf(name);
    if (sab) { if (down) Atomics.add(keys, PRESSES + i, 1); Atomics.store(keys, i, down ? 1 : 0); }
    else { if (down) keys[PRESSES + i]++; keys[i] = down ? 1 : 0; worker?.postMessage({ type: "keys", state: Array.from(keys.subarray(0, SEEN_DOWN)) }); }
    setKey(svg, name, down ? "down" : "");
  }
  function releaseAll() { for (const k of KEY_ORDER) if (keys[KEY_ORDER.indexOf(k)]) hold(k, false); }

  function onMsg(e: MessageEvent) {
    const m = e.data;
    if (m.type === "frame") {
      const b = new Uint8Array(m.buf), d = img.data;
      for (let i = 0, o = 0; i < b.length; i += 2, o += 4) {
        const c = (b[i] << 8) | b[i + 1];
        d[o] = (c >> 8) & 0xf8; d[o + 1] = (c >> 3) & 0xfc; d[o + 2] = (c << 3) & 0xf8; d[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      frames = m.frames; fpsCount++;
      for (const cb of frameCbs) cb({ frames, fps, canvas });
    } else if (m.type === "out") {
      if (capturing) capturing.lines.push(m.line);
      for (const cb of outCbs) cb(m.line);
    } else if (m.type === "pwm" || m.type === "pin") {
      if (m.pin === BL_PIN) canvas.style.opacity = String(m.type === "pwm" ? Math.max(0, Math.min(1, m.frac)) : m.v ? 1 : 0);
    } else if (m.type === "reset") {
      void reboot();
    } else if (m.type === "booted") {
      booted?.resolve(); booted = null;
    } else if (m.type === "error") {
      for (const cb of outCbs) cb("virtual wedgie: " + m.error);
      booted?.reject(new Error(m.error)); booted = null;
    } else if (m.type === "execStart") {
      capturing = waiting.get(m.id) || null;
    } else if (m.type === "done") {
      const w = waiting.get(m.id);
      capturing = null;
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(w.lines.join("\n"));
    }
  }

  function reboot(): Promise<void> {
    if (destroyed) return Promise.reject(new Error("destroyed"));
    worker?.terminate();
    for (const w of waiting.values()) w.reject(new Error("rebooted"));
    waiting.clear();
    capturing = null;
    booted?.reject(new Error("rebooted"));
    releaseAll();
    keys.fill(0);
    if (serialCtl) { Atomics.store(serialCtl, 0, 0); Atomics.store(serialCtl, 1, 0); }
    canvas.style.opacity = "0";
    frames = 0;
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onMsg;
    worker.onerror = (e) => { for (const cb of outCbs) cb("virtual wedgie worker: " + e.message); booted?.reject(new Error(e.message)); booted = null; };
    const p = new Promise<void>((resolve, reject) => { booted = { resolve, reject }; });
    worker.postMessage({ type: "boot", keys: keyBuf, serial: serialSab, fwBase: opts.fwBase || "/fw/", uid: uidBytes(opts.uid) });
    return p;
  }

  function exec(code: string): Promise<string> {
    if (!worker) return Promise.reject(new Error("not running"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, lines: [] });
      worker!.postMessage({ type: "exec", id, code });
    });
  }

  function write(text: string) {
    if (!serialCtl || !serialBuf) { worker?.postMessage({ type: "send", text }); return; }
    let h = Atomics.load(serialCtl, 0);
    for (const b of new TextEncoder().encode(text)) serialBuf[h++ % serialBuf.length] = b;
    Atomics.store(serialCtl, 0, h);
  }

  // ---- pointer: buttons, and the joystick as a zone (centre = press, else the nearest direction)
  const pointers = new Map<number, string>();   // pointer id -> key it holds
  const joyPointers = new Set<number>();        // pointers that went down on the joystick and steer it
  function svgPoint(e: PointerEvent) {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  function joyKey(e: PointerEvent) {
    const { x, y } = svgPoint(e);
    const dx = x - JOY.cx, dy = y - JOY.cy;
    if (Math.hypot(dx, dy) < JOY.press) return "press";
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  }
  function setPointer(id: number, key: string | null) {
    const was = pointers.get(id);
    if (was === key) return;
    if (was) { pointers.delete(id); if (![...pointers.values()].includes(was)) hold(was, false); }
    if (key) { pointers.set(id, key); hold(key, true); }
  }
  svg.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    const joy = t.closest(".joy");
    const k = joy ? joyKey(e) : t.closest("[data-k]")?.getAttribute("data-k");
    root.focus({ preventScroll: true });
    if (!k) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    setPointer(e.pointerId, k);
    if (joy) joyPointers.add(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (joyPointers.has(e.pointerId) && pointers.has(e.pointerId)) setPointer(e.pointerId, joyKey(e));
  });
  const up = (e: PointerEvent) => { joyPointers.delete(e.pointerId); setPointer(e.pointerId, null); };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  svg.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- keyboard, only while focused ------------------------------------------------------
  const kbd = new Set<string>();
  root.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = KEYMAP[e.key];
    if (!k) return;
    e.preventDefault();
    if (e.repeat || kbd.has(e.key)) return;
    kbd.add(e.key);
    hold(k, true);
  });
  root.addEventListener("keyup", (e) => {
    const k = KEYMAP[e.key];
    if (!k || !kbd.delete(e.key)) return;
    e.preventDefault();
    hold(k, false);
  });
  root.addEventListener("blur", () => { kbd.clear(); pointers.clear(); joyPointers.clear(); releaseAll(); });

  const vw: VirtualWedgie = {
    // Held at least ms and until the firmware has read it down, then released and waited for until
    // it has read it up (each wait gives up after a second: an app that never reads that key).
    // So press(a); press(b) reaches the app in that order even while it is busy drawing.
    async press(key, ms = 80) {
      hold(key, true);
      const i = KEY_ORDER.findIndex((k) => k.toLowerCase() === String(key).toLowerCase());
      const n = keys[PRESSES + i];
      await sleep(ms);
      if (sab) await until(() => Atomics.load(keys, SEEN_DOWN + i) >= n, 1000);
      hold(key, false);
      if (sab) await until(() => Atomics.load(keys, SEEN_UP + i) >= n, 1000);
      else await sleep(120);
    },
    hold,
    screenshotPNG: () => canvas.toDataURL("image/png"),
    reboot,
    exec,
    write,
    onOutput(cb) { outCbs.add(cb); return () => outCbs.delete(cb); },
    onFrame(cb) { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    get fps() { return fps; },
    el: root,
    destroy() {
      destroyed = true;
      worker?.terminate(); worker = null;
      clearInterval(fpsTimer);
      for (const w of waiting.values()) w.reject(new Error("destroyed"));
      waiting.clear();
      booted?.reject(new Error("destroyed")); booted = null;
      frameCbs.clear(); outCbs.clear();
      root.remove();
    },
  };
  if (opts.onOutput) outCbs.add(opts.onOutput);
  if (opts.autofocus) root.focus({ preventScroll: true });
  await reboot();
  return vw;
}

function uidBytes(hex?: string) {
  if (!hex || !/^([0-9a-f]{2})+$/i.test(hex)) return undefined;
  return hex.match(/../g)!.map((b) => parseInt(b, 16));
}
