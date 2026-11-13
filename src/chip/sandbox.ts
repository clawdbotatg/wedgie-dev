// wedgie.dev/sandbox's wedgie: the real firmware and Safe Signer on a virtual RP2040 (sim.ts), in a Worker, driven
// the way tools/safechip.mjs drives one: a transaction in (with its clear-signing bundle), A pressed once a second
// of the chip's time, every page it shows out. It starts from public/sandbox/safe-fs.img.gz (tools/sandboximage.mjs):
// a stand-in secure chip that can't sign, so the last yes ends in the app's error answer. Nothing is kept.
//
// Page -> worker: {t:"boot"} {t:"run", n, tx, clear}     (clear: the bundle as hex, or null)
// Worker -> page: {t:"boot", pct} {t:"ready", hello} {t:"frame", buf} {t:"page", n, buf} {t:"done", n, answer, secs}
//                 {t:"error", error}
import { boot, flashFromUf2, type Chip } from "./sim";

const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
let chip: Chip, out = "", hello: any = null, id = 100, busy = false, frameDue = false, lastFrame = 0;

// the event loop gets a turn every 25 ms of real time, so a frame reaches the page while the chip runs
const tick = new MessageChannel();
let woke: (() => void) | null = null, yielded = 0;
tick.port1.onmessage = () => { const w = woke; woke = null; w?.(); };
const breathe = () => new Promise<void>((res) => { woke = res; tick.port2.postMessage(0); });
function frame() {
  if (!frameDue || performance.now() - lastFrame < 60) return;
  frameDue = false; lastFrame = performance.now();
  const copy = chip.frame.slice();
  scope.postMessage({ t: "frame", buf: copy.buffer }, [copy.buffer]);
}
/** Run until fn(out) is true or ms of the chip's time pass. */
async function until(fn: (b: string) => boolean, ms: number, step = 10) {
  const end = chip.ms + ms;
  while (chip.ms < end) {
    if (fn(out)) return true;
    chip.run(step);
    if (performance.now() - yielded > 25) { frame(); await breathe(); yielded = performance.now(); }
  }
  return fn(out);
}
const write = (s: string) => chip.write(new TextEncoder().encode(s));
/** A JSON request to the app; the answer whose id matches, or null. */
async function req(msg: any, ms = 20000) {
  let got: any = null;
  const re = new RegExp(`\\{[^\\n]*"id": ${msg.id}[,}][^\\n]*\\n`);
  out = "";
  write(JSON.stringify(msg) + "\n");
  await until((b) => { const m = b.match(re); if (m) { try { got = JSON.parse(m[0]); } catch { got = null; } } return !!m; }, ms);
  return got;
}
async function press(k: string) { chip.key(k, true); await until(() => false, 150); chip.key(k, false); await until(() => false, 100); }

async function start() {
  const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const [rom, uf2, gz] = await Promise.all([get("/virtual/bootrom-b1.bin"), get("/mp/RPI_PICO.uf2"), get("/sandbox/safe-fs.img.gz")]);
  const flash = flashFromUf2(uf2);
  const fs = gz[0] === 0x1f && gz[1] === 0x8b
    ? new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : gz;
  flash.set(fs, 0xa0000);      // where a Pico's filesystem starts
  const dec = new TextDecoder("latin1");
  chip = boot({ rom, flash, uid: new Uint8Array([0xe6, 0x60, 0x58, 0x38, 0x83, 0xee, 0xe0, 0x00]),
    onData: (b) => { out += dec.decode(b); }, onFrame: () => { frameDue = true; } });
  const t0 = chip.ms;
  let said = 0;
  const up = await until((b) => {       // ~12 s of the chip's time to its "ready" line
    const pct = Math.min(95, Math.round((chip.ms - t0) / 130));
    if (pct !== said) { said = pct; scope.postMessage({ t: "boot", pct }); }
    return b.includes('"ready"');
  }, 60000, 20);
  if (!up) throw new Error("the wedgie didn't start");
  await until(() => false, 1500);
  hello = await req({ type: "hello", id: ++id }, 8000);
  if (hello?.running !== "safe") throw new Error("Safe Signer didn't start");
  scope.postMessage({ t: "ready", hello });
}

/** A page of the transaction (not the "reading" screen or a half-drawn one): the dark title bar and the red no bar,
 *  as tools/clear_gallery.py's is_page. */
function isPage(f: Uint8Array) {
  const px = (x: number, y: number) => { const v = (f[2 * (y * 240 + x)] << 8) | f[2 * (y * 240 + x) + 1]; return [(v >> 11) << 3, ((v >> 5) & 63) << 2, (v & 31) << 3]; };
  const a = px(120, 2), b = px(20, 232);
  return a[0] === 24 && a[1] === 24 && a[2] === 24 && b[0] === 224 && b[1] === 48 && b[2] === 40;
}

async function run(n: number, tx: any, clear: string | null) {
  const chunk = hello.safe_chunk || 512;
  for (let o = 0; clear && o < clear.length; o += chunk)        // the bundle first, in pieces
    await req({ id: ++id, type: "safe_clear", at: o / 2, hex: clear.slice(o, o + chunk), ...(o ? {} : { n: clear.length / 2 }) });
  let msg: any = { type: "safe_sign", tx, fresh: 1 };
  if (JSON.stringify({ id: 1000, ...msg }).length > 3000) {    // a long one: its data in pieces, then "@" (as /safe)
    let at = 0;
    for (let o = 2; o < tx.data.length; o += chunk) {
      const hex = tx.data.slice(o, o + chunk);
      const a = await req({ id: ++id, type: "safe_data", at, hex });
      at += hex.length / 2;
      if (a?.type !== "safe_data" || a.have !== at) throw new Error("the wedgie didn't take the data" + (a?.error ? ": " + a.error : ""));
    }
    msg = { ...msg, tx: { ...tx, data: "@" } };
  }
  const rid = ++id, t0 = chip.ms, re = new RegExp(`\\{[^\\n]*"id": ${rid}[,}][^\\n]*\\n`);
  out = "";
  write(JSON.stringify({ id: rid, ...msg }) + "\n");
  let got: any = null, last: Uint8Array | null = null;
  for (let s = 0; s < 240 && !got; s++) {
    await until((b) => { const m = b.match(re); if (m) got = JSON.parse(m[0]); return !!m; }, 1000, 20);
    if (got) break;
    const f = chip.frame;
    if (!last || f.some((v, i) => v !== last![i])) {
      last = f.slice();
      if (isPage(last)) { const copy = last.slice(); scope.postMessage({ t: "page", n, buf: copy.buffer }, [copy.buffer]); }
    }
    await press("A");
  }
  scope.postMessage({ t: "done", n, answer: got, secs: Math.round((chip.ms - t0) / 100) / 10 });
}

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.t === "boot" && !chip) await start();
    else if (m.t === "run" && hello && !busy) { busy = true; try { await run(m.n, m.tx, m.clear); } finally { busy = false; } }
  } catch (err) {
    scope.postMessage({ t: "error", n: m.n, error: String((err as Error)?.message || err) });
  }
};
