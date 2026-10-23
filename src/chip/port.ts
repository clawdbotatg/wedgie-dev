// A virtual wedgie's USB serial port, for any wedgie.dev tab: the same shape as a Web Serial port, so
// wedgies.ts, Repl, install and /safe talk to it unchanged. The wedgie itself runs in the /virtual tab's
// worker (worker.ts); this end and that one talk over the BroadcastChannel "wedgie-emu":
//   tab -> emu: {t:"who"} {t:"open", id, from} {t:"close", id, from} {t:"tx", id, from, data}
//   emu -> tab: {t:"here", id, usb} {t:"usb", id, up} {t:"opened"|"refused", id, to} {t:"rx", id, to, data} {t:"bye", id}
// A port appears when its USB is up (enumerated) and drops when it goes down, as a real one replugs.
// Same origin only: BroadcastChannel never leaves wedgie.dev.
export const VIRTUAL_PID = 0x0005;

type Fn = (p: VirtualPort) => void;
const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("wedgie-emu") : null;
const ports = new Map<string, VirtualPort>();
const onConnect = new Set<Fn>(), onDisconnect = new Set<Fn>();
const sessions = new Map<string, VirtualPort>();      // open session id -> its port

export class VirtualPort extends EventTarget {
  readonly id: string;
  readonly virtual = true;
  connected = true;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private me = "";
  private rx: ReadableStreamDefaultController<Uint8Array> | null = null;
  private unlock: (() => void) | null = null;
  constructor(id: string) { super(); this.id = id; }

  getInfo() { return { usbVendorId: 0x2e8a, usbProductId: VIRTUAL_PID }; }

  async open(_o?: unknown) {
    if (this.readable) throw new DOMException("The port is already open.", "InvalidStateError");
    if (!this.connected || !ch) throw new DOMException("Failed to open serial port.", "NetworkError");
    const me = crypto.randomUUID();
    // held while open: the emu frees the port when this tab is gone (worker.ts)
    await new Promise<void>((held) => navigator.locks.request("wedgie-emu-port-" + me, () => new Promise<void>((r) => { this.unlock = r; held(); })));
    const ok = await new Promise<boolean>((res) => {
      const t = setTimeout(() => { ch.removeEventListener("message", f); res(false); }, 2000);
      const f = (e: MessageEvent) => {
        const m = e.data;
        if (m.id !== this.id || m.to !== me || (m.t !== "opened" && m.t !== "refused")) return;
        clearTimeout(t); ch.removeEventListener("message", f); res(m.t === "opened");
      };
      ch.addEventListener("message", f);
      ch.postMessage({ t: "open", id: this.id, from: me });
    });
    if (!ok) { this.unlock?.(); this.unlock = null; throw new DOMException("Failed to open serial port.", "NetworkError"); }
    this.me = me;
    sessions.set(me, this);
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { this.rx = c; } });
    this.writable = new WritableStream<Uint8Array>({
      write: (b) => {
        if (!this.connected) throw new DOMException("The device has been lost.", "NetworkError");
        ch.postMessage({ t: "tx", id: this.id, from: me, data: b.slice() });
      },
    });
  }

  async close() {
    if (!this.me) return;
    ch?.postMessage({ t: "close", id: this.id, from: this.me });
    this.end();
  }

  /** The emu's data for this session. */
  feed(b: Uint8Array) { try { this.rx?.enqueue(b); } catch {} }

  private end(lost = false) {
    sessions.delete(this.me);
    this.me = "";
    try { if (lost) this.rx?.error(new DOMException("The device has been lost.", "NetworkError")); else this.rx?.close(); } catch {}
    this.rx = null; this.readable = null; this.writable = null;
    this.unlock?.(); this.unlock = null;
  }

  /** Unplugged (its USB dropped, or the /virtual tab closed). */
  lost() {
    this.connected = false;
    if (this.me) this.end(true);
    this.dispatchEvent(new Event("disconnect"));
  }
}

function up(id: string) {
  if (ports.has(id)) return;
  const p = new VirtualPort(id);
  ports.set(id, p);
  onConnect.forEach((f) => f(p));
}
function down(id: string) {
  const p = ports.get(id);
  if (!p) return;
  ports.delete(id);
  p.lost();
  onDisconnect.forEach((f) => f(p));
}

let started = false;
/** Start listening for virtual wedgies (any page; touches no hardware, prompts nothing). */
export function start() {
  if (started || !ch) return;
  started = true;
  ch.addEventListener("message", (e) => {
    const m = e.data;
    if (m.t === "here" || m.t === "usb") (m.t === "here" ? m.usb : m.up) ? up(m.id) : down(m.id);
    else if (m.t === "bye") down(m.id);
    else if (m.t === "rx") sessions.get(m.to)?.feed(m.data);
  });
  ch.postMessage({ t: "who" });
  // The /virtual tab holds this lock while it runs: gone without a word (crashed, killed) = unplugged.
  setInterval(async () => {
    if (!ports.size || !navigator.locks?.query) return;
    const q = await navigator.locks.query();
    if (!q.held?.some((l) => l.name === "wedgie-emu-run")) for (const id of [...ports.keys()]) down(id);
  }, 2000);
}

export const virtualPorts = () => [...ports.values()];
export function onVirtual(connect: Fn, disconnect: Fn) { onConnect.add(connect); onDisconnect.add(disconnect); }
export const isVirtual = (p: unknown): p is VirtualPort => p instanceof VirtualPort;
