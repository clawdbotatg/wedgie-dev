// The virtual wedgie's machine: MicroPython (WebAssembly) plus the JS half of the `machine` shim.
// Ported from picowallet's emu/core/runtime.mjs (MIT, same author). Runs inside the Worker
// (worker.ts); nothing here touches the DOM.
//
// The screen is captured from the ST7789 command stream on SPI1 (DC on GP8), so what the page shows
// is exactly what the firmware sent to the panel. Keys are GPIOs that read low while held.

export const KEY_ORDER = ["A", "B", "X", "Y", "up", "down", "left", "right", "press"] as const;
export type KeyName = (typeof KEY_ORDER)[number];
// GPIO -> key, from firmware/lcd.py (KEYS)
const KEY_PINS: Record<number, KeyName> = { 15: "A", 17: "B", 19: "X", 21: "Y", 2: "up", 18: "down", 16: "left", 20: "right", 3: "press" };
/** The shared key array, 9 slots per row in KEY_ORDER: levels (1 = held, page writes), press
 * counters (page writes), the last press any Pin read as low (worker writes), and the last press after
 * which a Pin read the key as up again (worker writes). The last two let press() wait for the app. */
export const PRESSES = 16, SEEN_DOWN = 32, SEEN_UP = 48, KEY_SLOTS = 64;
export const W = 240, H = 240, FRAME_BYTES = W * H * 2;
export const DEFAULT_HEAP = 250 * 1024;   // NOT calibrated yet: the smallest heap where the Wallet and a checked install run (245 is too small). Needs gc.mem_free() from a real wedgie running Hello. Our own MicroPython build (src/emu/mp, tools/emu-mp/build.sh) has a fixed heap; the npm build grew it without limit

export type Shims = Record<string, string>;
type MP = {
  _module: { getValue(addr: number, type: string): number };
  FS: { mkdir(p: string): void; writeFile(p: string, d: string | Uint8Array): void; readdir(p: string): string[] };
  registerJsModule(name: string, mod: object): void;
  runPython(code: string): unknown;
};
type LoadMicroPython = (o: object) => Promise<MP>;

export interface DeviceOpts {
  loadMicroPython: LoadMicroPython;
  url?: string;                         // the .wasm
  keys: Int32Array;                     // KEY_SLOTS: level per KEY_ORDER entry (1 = held), then press counts
  files: Record<string, string | Uint8Array>;   // the flash
  shims: Shims;                         // /lib/*.py; `_bootstrap` runs first
  uid?: number[];                       // machine.unique_id()
  heapsize?: number;
  stdin?: () => number | null;          // USB stdin, one byte or null when empty
  onFrame?: (frame: Uint8Array) => void;   // RGB565 big-endian, after every full push to the panel
  onStdout?: (line: string) => void;
  onPwm?: (pin: number, frac: number) => void;
  onPin?: (pin: number | string, v: number) => void;
  onReset?: () => void;
  onBusy?: () => void;                  // called from inside long Python runs (pin reads, SPI): flush work
}

export interface Device {
  run(code: string): void;
  exec(code: string): void;
  writeFile(name: string, data: string | Uint8Array): void;
  writeStdin(text: string): void;
  dispose(): void;
  frame: Uint8Array;
  readonly frames: number;
}

export async function createDevice(opts: DeviceOpts): Promise<Device> {
  const keys = opts.keys;
  const stdout = opts.onStdout || (() => {});
  const busy = opts.onBusy || (() => {});
  const inq: number[] = [];
  const stdin = opts.stdin || (() => (inq.length ? inq.shift()! : null));
  const frame = new Uint8Array(FRAME_BYTES);
  const pinOut = new Map<number | string, number>();
  const timers = new Map<number, { h: ReturnType<typeof setTimeout>; periodic: boolean }>();
  let timerSeq = 0, disposed = false, frames = 0;
  const seenPress = new Map<number, { seen: number; last: number }>();   // (Pin object, key) -> presses it has seen, last value read
  let M: MP["_module"];

  // ---- display ----------------------------------------------------------------------------
  const lcd = { cmd: 0, xs: 0, xe: W - 1, ys: 0, ye: H - 1, cur: 0, args: [] as number[] };
  // SPI costs real time on the Pico: 115200 bytes a frame. rp2 clocks the peripherals at 48 MHz
  // unless machine.freq(cpu, peri) raises it, which caps SPI at 24 MHz (38 ms a frame).
  const clock = { periHz: 48e6, spiBaud: { 0: 1e6, 1: 1e6 } as Record<number, number> };
  function spiCost(id: number, n: number) {
    const hz = Math.min(clock.spiBaud[id] || 1e6, clock.periHz / 2);
    const ms = ((n * 8) / hz) * 1000;
    if (ms < 0.05) return;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { /* the bus is busy, like on the board */ }
  }

  function readBytes(addr: number, n: number) {
    const out = new Uint8Array(n);
    let i = 0;
    if ((addr & 3) === 0) {
      for (; i + 4 <= n; i += 4) {
        const v = M.getValue(addr + i, "i32");
        out[i] = v & 255; out[i + 1] = (v >> 8) & 255; out[i + 2] = (v >> 16) & 255; out[i + 3] = (v >>> 24) & 255;
      }
    }
    for (; i < n; i++) out[i] = M.getValue(addr + i, "i8") & 255;
    return out;
  }

  function spiWrite(id: number, addr: number, n: number) {
    spiCost(id, n);
    if (pinOut.get(8) === 0) {
      lcd.cmd = M.getValue(addr, "i8") & 255;
      lcd.args = [];
      if (lcd.cmd === 0x2c) lcd.cur = 0;
      return;
    }
    if (lcd.cmd === 0x2a || lcd.cmd === 0x2b) {
      for (const x of readBytes(addr, n)) lcd.args.push(x);
      if (lcd.args.length >= 4) {
        const s = (lcd.args[0] << 8) | lcd.args[1], e = (lcd.args[2] << 8) | lcd.args[3];
        if (lcd.cmd === 0x2a) { lcd.xs = s; lcd.xe = e; } else { lcd.ys = s; lcd.ye = e; }
      }
      return;
    }
    if (lcd.cmd !== 0x2c) return;
    const full = lcd.xs === 0 && lcd.ys === 0 && lcd.xe === W - 1 && lcd.ye === H - 1;
    if (full && lcd.cur === 0 && n === FRAME_BYTES) {
      frame.set(readBytes(addr, n));
      lcd.cur = n;
    } else {
      const b = readBytes(addr, n);
      const ww = lcd.xe - lcd.xs + 1;
      for (let i = 0; i + 1 < b.length; i += 2) {
        const p = lcd.cur >> 1;
        const x = lcd.xs + (p % ww), y = lcd.ys + Math.floor(p / ww);
        if (x < W && y < H) { const o = (y * W + x) * 2; frame[o] = b[i]; frame[o + 1] = b[i + 1]; }
        lcd.cur += 2;
      }
    }
    frames++;
    if (opts.onFrame) opts.onFrame(frame);
  }

  // ---- the _emu bridge module -----------------------------------------------------------
  type PyFn = (...a: unknown[]) => unknown;
  const irqs = new Map<number, { handler: PyFn; trigger: number; pin: unknown; last: number }>();
  let irqPoll: ReturnType<typeof setInterval> | null = null;
  const pyError = (e: unknown) => String((e as Error)?.message || e).replace(/^PythonError:\s*/, "").trimEnd();
  const bridge = {
    pin_read(id: number, reader?: number) {
      busy();
      const k = KEY_PINS[id];
      if (k !== undefined) {
        // keys[i] is the level, keys[PRESSES + i] counts presses. Every press reaches every Pin
        // object as a low read with a high read between presses, even when it was shorter than the
        // app's poll (a tap, or several press() calls while a slow frame is drawn).
        const i = KEY_ORDER.indexOf(k), n = keys[PRESSES + i], level = keys[i] ? 0 : 1;
        if (reader === undefined) return level;
        const tag = reader * 16 + i;
        let st = seenPress.get(tag);
        if (!st) seenPress.set(tag, (st = { seen: n, last: level }));
        if (st.seen < n) {
          if (st.last === 0) return (st.last = 1);
          st.seen++;
          if (st.seen > keys[SEEN_DOWN + i]) Atomics.store(keys, SEEN_DOWN + i, st.seen);
          return (st.last = 0);
        }
        if (level === 0 && n > keys[SEEN_DOWN + i]) Atomics.store(keys, SEEN_DOWN + i, n);
        if (level === 1 && n > keys[SEEN_UP + i]) Atomics.store(keys, SEEN_UP + i, n);
        return (st.last = level);
      }
      const v = pinOut.get(id);
      return v === undefined ? 1 : v;
    },
    pin_write(id: number, v: number) {
      pinOut.set(id, v);
      if (opts.onPin) opts.onPin(id, v);
    },
    pin_irq(id: number, handler: PyFn | null, trigger: number, pin: unknown) {
      if (handler == null) { irqs.delete(id); return; }
      irqs.set(id, { handler, trigger, pin, last: bridge.pin_read(id) });
      if (!irqPoll) irqPoll = setInterval(pollIrqs, 5);
    },
    spi_write(id: number, addr: number, n: number) { spiWrite(id, addr, n); busy(); },
    spi_init(id: number, baud: number) { clock.spiBaud[id] = baud; },
    set_freq(_cpu: number, peri: number) { if (peri) clock.periHz = peri; return 150e6; },
    pwm(id: number, frac: number) { if (opts.onPwm) opts.onPwm(id, frac); },
    adc_read(id: number) { return id === 29 ? 42000 : id === 4 ? 27000 : 0; },
    timer_start(cb: PyFn, ms: number, periodic: boolean, timerObj: unknown) {
      const id = ++timerSeq;
      const fire = () => {
        if (disposed) return;
        if (!periodic) timers.delete(id);
        try { cb(timerObj); } catch (e) { stdout(pyError(e)); }
      };
      const h = periodic ? setInterval(fire, ms) : setTimeout(fire, ms);
      timers.set(id, { h, periodic });
      return id;
    },
    timer_stop(id: number) {
      const t = timers.get(id);
      if (!t) return;
      (t.periodic ? clearInterval : clearTimeout)(t.h);
      timers.delete(id);
    },
    random(n: number) {
      const b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return Array.from(b);
    },
    uid() { return opts.uid || [0x77, 0x65, 0x64, 0x67, 0x69, 0x65, 0x0e, 0x40]; },
    reset() { if (opts.onReset) setTimeout(() => opts.onReset!(), 0); },
    frames() { return frames; },
  };

  function pollIrqs() {
    for (const [id, s] of irqs) {
      const v = bridge.pin_read(id);
      if (v === s.last) continue;
      const rising = v === 1;
      s.last = v;
      if ((rising && s.trigger & 1) || (!rising && s.trigger & 2)) {
        try { s.handler(s.pin); } catch (e) { stdout(pyError(e)); }
      }
    }
  }

  // ---- boot ------------------------------------------------------------------------------
  const mp = await opts.loadMicroPython({
    url: opts.url,
    heapsize: opts.heapsize || DEFAULT_HEAP,
    stdout: (line: string) => stdout(line),
    stdin,
    linebuffer: true,
  });
  M = mp._module;
  mp.registerJsModule("_emu", bridge);
  const FS = mp.FS;
  try { FS.mkdir("/lib"); } catch { /* exists */ }
  for (const [name, src] of Object.entries(opts.shims)) FS.writeFile(`/lib/${name}.py`, src);
  for (const [name, data] of Object.entries(opts.files)) writeFile(name, data);
  mp.runPython("import _bootstrap");

  // The compiler refuses @micropython.viper/@micropython.native without a native emitter, so they
  // become the identity decorator from _bootstrap (same result, runs as bytecode).
  function writeFile(name: string, data: string | Uint8Array) {
    if (typeof data === "string" && name.endsWith(".py")) data = data.replace(/^(\s*)@micropython\.(viper|native)\b/gm, "$1@__emu_plain__");
    const dirs = name.split("/").slice(0, -1);     // saves/<game>/<name>.json: its folders first
    for (let i = 1; i <= dirs.length; i++) { try { FS.mkdir("/" + dirs.slice(0, i).join("/")); } catch { /* exists */ } }
    FS.writeFile("/" + name, data);
  }

  return {
    run(code) { mp.runPython(code); },
    // One REPL entry, in __main__: expressions echo their repr like the prompt does (`import x; x.y`
    // too); several lines run as a block. Tracebacks are printed, never raised.
    exec(code) {
      mp.runPython(
        `import sys, __main__\n_c = ${JSON.stringify(code)}\ntry:\n    try:\n        _v = eval(compile(_c, "<stdin>", "eval"), __main__.__dict__)\n` +
        `        if _v is not None:\n            print(repr(_v))\n    except SyntaxError:\n        try:\n            _k = compile(_c, "<stdin>", "single")\n` +
        `        except SyntaxError:\n            _k = compile(_c, "<stdin>", "exec")\n        exec(_k, __main__.__dict__)\n` +
        `except BaseException as _e:\n    sys.print_exception(_e)\n`,
      );
    },
    writeFile,
    writeStdin(text) { for (const b of new TextEncoder().encode(text)) inq.push(b); },
    dispose() {
      disposed = true;
      for (const t of timers.values()) (t.periodic ? clearInterval : clearTimeout)(t.h);
      timers.clear();
      if (irqPoll) clearInterval(irqPoll);
    },
    frame,
    get frames() { return frames; },
  };
}

/** RGB565 big-endian frame -> RGBA. */
export function frameToRGBA(frame: Uint8Array, out: Uint8ClampedArray) {
  for (let i = 0, o = 0; i < FRAME_BYTES; i += 2, o += 4) {
    const c = (frame[i] << 8) | frame[i + 1];
    out[o] = (c >> 8) & 0xf8; out[o + 1] = (c >> 3) & 0xfc; out[o + 2] = (c << 3) & 0xf8; out[o + 3] = 255;
  }
  return out;
}
