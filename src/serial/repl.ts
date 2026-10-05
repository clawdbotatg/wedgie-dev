// MicroPython raw REPL over WebSerial. Ported from picowallet factory/index.html (MIT, same author).
// Board code prints results as "@<tag> <json>" lines; those stream to onLine as they arrive.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RAW_PROMPT = "raw REPL; CTRL-B to exit\r\n>";

type Waiter = { str: string; res: (before: string) => void; rej: (e: Error) => void; t: number };

export class Repl {
  port: SerialPort;
  private buf = "";
  private lineBuf = "";
  private waiters: Waiter[] = [];
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  alive = false;
  /** What the wedgie's screen says this computer is doing (files.ts busy): set while it has the REPL. */
  busy: { title: string; what: string; p: number; ok: boolean } | null = null;
  onLine: ((tag: string, v: any) => void) | null = null;
  onJson: ((v: any) => void) | null = null;
  onText: ((s: string) => void) | null = null;

  constructor(port: SerialPort) {
    this.port = port;
  }

  async open() {
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable!.getWriter();
    this.reader = this.port.readable!.getReader();
    this.alive = true;
    (async () => {
      const dec = new TextDecoder("latin1");
      try {
        while (true) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          const s = dec.decode(value);
          this.onText?.(s);
          this.buf += s;
          this.feedLines(s);
          this.check();
        }
      } catch {}
      this.gone();
    })();
    navigator.serial?.addEventListener("disconnect", this.onGone);
  }

  // Unplugged (or its restart dropped the port): the read ends, or only the disconnect event says so.
  private onGone = (e: Event) => { if (((e as any).port || e.target) === this.port) this.gone(); };
  private gone() {
    this.alive = false;
    this.check(true);
    navigator.serial?.removeEventListener("disconnect", this.onGone);
    // Requests fail now, not at their timeout: a checked install's yes restarts the wedgie, and the first
    // restart after a plug-in drops the port (install.ts job() then finds it again by its ID).
    for (const [id, p] of this.pending) { clearTimeout(p.t); this.pending.delete(id); p.rej(new Error("wedgie unplugged")); }
  }

  private feedLines(s: string) {
    this.lineBuf += s;
    let i;
    while ((i = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, i).replace(/\r$/, "").replace(/^[\x04>]*(OK)?/, "");
      this.lineBuf = this.lineBuf.slice(i + 1);
      if (line.startsWith("@") && this.onLine) {
        const sp = line.indexOf(" ");
        try { this.onLine(line.slice(1, sp), JSON.parse(line.slice(sp + 1))); } catch {}
      } else if (line.startsWith("{")) {
        let v: any;
        try { v = JSON.parse(line); } catch { continue; }
        this.json(v);
      }
    }
  }

  private check(dead = false) {
    this.waiters = this.waiters.filter((w) => {
      const i = this.buf.indexOf(w.str);
      if (i >= 0) {
        const before = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + w.str.length);
        clearTimeout(w.t);
        w.res(before);
        return false;
      }
      if (dead) { clearTimeout(w.t); w.rej(new Error("wedgie unplugged")); return false; }
      return true;
    });
  }

  waitFor(str: string, ms = 5000): Promise<string> {
    return new Promise((res, rej) => {
      const w: Waiter = { str, res, rej, t: 0 };
      w.t = window.setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        rej(new Error("wedgie did not answer"));
      }, ms);
      this.waiters.push(w);
      this.check();
    });
  }

  async write(s: string | Uint8Array) {
    const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
    for (let i = 0; i < bytes.length; i += 256) {
      await this.writer!.write(bytes.slice(i, i + 256));
      if (bytes.length > 256) await sleep(5);
    }
  }

  private nextId = 100;
  private pending = new Map<number, { parts: any[]; res: (v: any) => void; rej: (e: Error) => void; t: number }>();

  /** One JSON request to the wedgie firmware (slot.py). Shots and files arrive in parts; they're joined. */
  request(msg: Record<string, unknown>, ms = 5000): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => { this.pending.delete(id); rej(new Error("wedgie did not answer")); }, ms);
      this.pending.set(id, { parts: [], res, rej, t });
      this.write(JSON.stringify({ ...msg, id }) + "\n").catch(rej);
    });
  }

  /** A request whose line is followed by raw bytes (a raw put: msg.n = raw.length, firmware 0.3.16+). */
  requestRaw(msg: Record<string, unknown>, raw: Uint8Array, ms = 5000): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => { this.pending.delete(id); rej(new Error("wedgie did not answer")); }, ms);
      this.pending.set(id, { parts: [], res, rej, t });
      this.write(JSON.stringify({ ...msg, n: raw.length, id }) + "\n").then(() => this.write(raw)).catch(rej);
    });
  }

  private json(v: any) {
    const p = v && typeof v.id === "number" ? this.pending.get(v.id) : undefined;
    if (!p) { this.onJson?.(v); return; }
    if (v.type === "shot" || v.type === "file") {
      p.parts[v.i] = v.type === "file" ? atob(v.data) : v.data;
      clearTimeout(p.t);                 // a big file takes a while: each part buys it time
      p.t = window.setTimeout(() => { this.pending.delete(v.id); p.rej(new Error("wedgie did not answer")); }, 5000);
      if (p.parts.filter((x) => x !== undefined).length < v.n) return;
      v = v.type === "shot" ? { id: v.id, type: "shot", w: v.w, h: v.h, fmt: v.fmt, data: p.parts.join("") }
        : { id: v.id, type: "file", size: v.size, bytes: Uint8Array.from(p.parts.join(""), (c: string) => c.charCodeAt(0)) };
    }
    clearTimeout(p.t);
    this.pending.delete(v.id);
    p.res(v);
  }

  /** Ask a running wedgie firmware who it is, without interrupting it. Null if nothing answers. */
  async hello(ms = 700): Promise<any | null> {
    let got: any = null;
    const prev = this.onJson;
    const p = new Promise<void>((res) => {
      this.onJson = (v) => { if (v && v.type === "hello") { got = v; res(); } };
      setTimeout(res, ms);
    });
    await this.write('{"id":1,"type":"hello"}\n');
    await p;
    this.onJson = prev;
    return got;
  }

  /** Stop whatever runs, raw REPL, soft reset so no app timers keep running (main.py is skipped in raw mode). */
  // reset: false stops what runs (Ctrl-C) without a soft reset. ON A WEDGIE ALWAYS USE reset: false.
  // Wedgie firmware adds its WEDGIE USB drive at power-up, which re-enumerates USB and drops this port;
  // 0.1.3+ skips that on a soft reset, but 0.1.1-0.1.2 didn't, and neither does the first soft reset
  // after updating from them (firmware/boot.py). A soft reset is only for boards without wedgie
  // firmware, and for booting a new firmware (then the port may drop; wedgies.ts finds it by its ID).
  // On 0.1.x a launcher app's Timer survived Ctrl-C: install.ts takeOver asks it to stop first.
  // A Ctrl-C that lands while the firmware is inside a Timer callback is lost (firmware/slot.py), so
  // it's sent again until the raw REPL answers (seen on a real wedgie running Speed lab, 2026-09-29).
  async enter(opts: { reset?: boolean } = {}) {
    for (let i = 0; ; i++) {
      await this.write("\r\x03\x03");
      await sleep(150);
      this.buf = "";
      await this.write("\x01");
      try { await this.waitFor(RAW_PROMPT, i < 4 ? 1200 : 4000); break; } catch (e) { if (i >= 4) throw e; }
    }
    if (opts.reset === false) return;
    await this.write("\x04");
    await this.waitFor("soft reboot", 4000);
    await this.waitFor(RAW_PROMPT, 25000); // boot.py may bring WiFi up
  }

  /** Run code. Resolves with its stdout when it finishes; @tag lines stream to onLine as they print. */
  async exec(code: string, ms = 30000): Promise<string> {
    this.buf = "";
    this.lineBuf = "";
    await this.write(code + "\x04");
    await this.waitFor("OK", 5000);
    const out = await this.waitFor("\x04", ms);
    const err = await this.waitFor("\x04", 5000);
    await this.waitFor(">", 2000).catch(() => {});
    if (err.trim()) throw new Error(err.trim().split("\n").pop());
    return out;
  }

  interrupt() { return this.write("\x03"); }

  /** Leave raw mode and soft reset: the wedgie's main.py runs again. */
  // reset: false starts the wedgie's app again: a soft reset when the board marks soft resets (0.1.3+,
  // boot.py's watchdog mark: the port stays up), so the app gets a fresh heap; a job's leftovers cut it
  // up and Grove died of it ("memory allocation failed": Austin, 2026-10-04). Without the mark (older
  // firmware, Y held at plug-in, the emulator) it runs main.py as before. public/wedgie.py LEAVE: the same line.
  // A reset boots new firmware, or a newly picked app.
  async leave(opts: { reset?: boolean } = {}) {
    this.busy = null;
    try {
      await this.write("\x02"); await sleep(50);
      if (opts.reset === false) await this.write(LEAVE + "\r");
      else await this.write("\x04");
    } catch {}
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
    this.alive = false;
    navigator.serial?.removeEventListener("disconnect", this.onGone);
  }
}

/** Typed at the plain REPL to start the app again (Repl.leave reset: false). */
export const LEAVE = `exec("import machine, sys\\ntry:\\n    _w = machine.mem32[(0x400D8000 if 'RP2350' in sys.implementation._machine else 0x40058000) + 0x0C] == 0x57ED61E0\\nexcept Exception:\\n    _w = False\\nif _w:\\n    machine.soft_reset()\\nexec(open('main.py').read())")`;

/** Python source literal for a string (for writing files through exec). */
export const pyStr = (s: string) => JSON.stringify(s);
