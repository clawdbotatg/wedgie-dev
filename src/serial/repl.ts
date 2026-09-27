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
      this.alive = false;
      this.check(true);
    })();
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

  async write(s: string) {
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < bytes.length; i += 256) {
      await this.writer!.write(bytes.slice(i, i + 256));
      if (bytes.length > 256) await sleep(5);
    }
  }

  private nextId = 100;
  private pending = new Map<number, { parts: any[]; res: (v: any) => void; rej: (e: Error) => void; t: number }>();

  /** One JSON request to the wedgie launcher (menu.py). Shots arrive in parts; they're joined. */
  request(msg: Record<string, unknown>, ms = 5000): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => { this.pending.delete(id); rej(new Error("wedgie did not answer")); }, ms);
      this.pending.set(id, { parts: [], res, rej, t });
      this.write(JSON.stringify({ ...msg, id }) + "\n").catch(rej);
    });
  }

  private json(v: any) {
    const p = v && typeof v.id === "number" ? this.pending.get(v.id) : undefined;
    if (!p) { this.onJson?.(v); return; }
    if (v.type === "shot") {
      p.parts[v.i] = v.data;
      if (p.parts.filter((x) => x !== undefined).length < v.n) return;
      v = { id: v.id, type: "shot", w: v.w, h: v.h, fmt: v.fmt, data: p.parts.join("") };
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
  // reset: false stops what runs (Ctrl-C) without a soft reset. Wedgie firmware 0.1.1+ re-adds its USB
  // drive in boot.py, and a soft reset runs boot.py, which re-enumerates USB and drops this port.
  async enter(opts: { reset?: boolean } = {}) {
    await this.write("\r\x03\x03");
    await sleep(150);
    this.buf = "";
    await this.write("\x01");
    await this.waitFor(RAW_PROMPT, 4000);
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
  // reset: false goes back to the launcher by running main.py again, with no soft reset (so the port
  // stays up); use it after tests. A reset is needed to boot new firmware after an install.
  async leave(opts: { reset?: boolean } = {}) {
    try {
      await this.write("\x02"); await sleep(50);
      if (opts.reset === false) await this.write('exec(open("main.py").read())\r');
      else await this.write("\x04");
    } catch {}
  }

  async close() {
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
    this.alive = false;
  }
}

/** Python source literal for a string (for writing files through exec). */
export const pyStr = (s: string) => JSON.stringify(s);
