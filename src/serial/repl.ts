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
      } else if (line.startsWith("{") && this.onJson) {
        try { this.onJson(JSON.parse(line)); } catch {}
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
  async enter() {
    await this.write("\r\x03\x03");
    await sleep(150);
    this.buf = "";
    await this.write("\x01");
    await this.waitFor(RAW_PROMPT, 4000);
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
  async leave() {
    try { await this.write("\x02"); await sleep(50); await this.write("\x04"); } catch {}
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
