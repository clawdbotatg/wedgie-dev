// The virtual wedgie runs in this Worker so a busy loop in Python never freezes the page. Keys and
// serial input arrive through SharedArrayBuffers (readable even while Python is busy); frames and
// console lines go out with postMessage. Port of picowallet's emu/web/worker.js (MIT).
import mpUrl from "@micropython/micropython-webassembly-pyscript/micropython.mjs?url";
import wasmUrl from "@micropython/micropython-webassembly-pyscript/micropython.wasm?url";
import machinePy from "./shims/machine.py?raw";
import rp2Py from "./shims/rp2.py?raw";
import bootstrapPy from "./shims/_bootstrap.py?raw";
import { createDevice, type Device } from "./runtime";
import { loadFlash, BOOT } from "./flash";

// tsconfig has the DOM lib, not WebWorker: type just what this file uses of the worker scope.
const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

let dev: Device | null = null;
let keys: Int32Array;
let serialCtl: Int32Array | null = null, serialBuf: Uint8Array | null = null;

// Serial ring: Int32 [head, tail] then bytes. The page writes at head, this thread reads at tail.
function stdinByte(): number | null {
  const c = serialCtl!, b = serialBuf!;
  const t = Atomics.load(c, 1);
  if (t === Atomics.load(c, 0)) return null;
  const v = b[t % b.length];
  Atomics.store(c, 1, t + 1);
  return v;
}

// Frames go out at most every ~16 ms. A pending one is flushed by a timer when Python is idle, or
// from inside Python's own pin reads / SPI writes when an app owns the CPU (timers cannot fire then).
let lastPost = 0, pending = false, pendingTimer: ReturnType<typeof setTimeout> | null = null;
function post() {
  if (!dev) return;
  pending = false;
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  lastPost = performance.now();
  const copy = dev.frame.slice();
  scope.postMessage({ type: "frame", buf: copy.buffer, frames: dev.frames }, [copy.buffer]);
}
function onFrame() {
  const dt = performance.now() - lastPost;
  if (dt >= 16) return post();
  pending = true;
  if (!pendingTimer) pendingTimer = setTimeout(post, 16 - dt);
}
function onBusy() { if (pending && performance.now() - lastPost >= 16) post(); }

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "boot") {
      keys = new Int32Array(m.keys);
      if (m.serial) { serialCtl = new Int32Array(m.serial, 0, 2); serialBuf = new Uint8Array(m.serial, 8); }
      const [{ files, manifest }, { loadMicroPython }] = await Promise.all([loadFlash(m.fwBase, m.app, m.extra), import(/* @vite-ignore */ mpUrl)]);
      dev = await createDevice({
        loadMicroPython, url: wasmUrl, keys, files, uid: m.uid,
        shims: { _bootstrap: bootstrapPy, machine: machinePy, rp2: rp2Py },
        stdin: serialCtl ? stdinByte : undefined,
        onFrame, onBusy,
        onStdout: (line) => scope.postMessage({ type: "out", line }),
        onPwm: (pin, frac) => scope.postMessage({ type: "pwm", pin, frac }),
        onPin: (pin, v) => scope.postMessage({ type: "pin", pin, v }),
        onReset: () => scope.postMessage({ type: "reset" }),
      });
      scope.postMessage({ type: "ready", version: manifest.version, apps: manifest.carts.map((a) => a.mod) });
      dev.run(BOOT);
      scope.postMessage({ type: "booted" });
    } else if (m.type === "exec") {
      if (!dev) throw new Error("not booted");
      scope.postMessage({ type: "execStart", id: m.id });
      dev.exec(m.code);
      scope.postMessage({ type: "done", id: m.id });
    } else if (m.type === "keys") {
      keys.set(m.state); // levels + press counts only; fallback without SharedArrayBuffer: only seen between Python runs
    } else if (m.type === "send") {
      dev?.writeStdin(m.text); // fallback without SharedArrayBuffer
    }
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (m.id) scope.postMessage({ type: "done", id: m.id, error: msg });
    else scope.postMessage({ type: "error", error: msg });
  }
};
