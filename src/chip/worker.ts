// The virtual wedgie's chip, in a Worker so the page never waits on it (sim.ts). It is also the
// wedgie's USB end: wedgie.dev tabs reach its serial port over a BroadcastChannel (port.ts), one tab at
// a time, like a real port. Its flash and board ID are kept in this browser (IndexedDB), so it is the
// same wedgie, with what was installed on it, every time /emu opens.
//
// Page -> worker: {t:"boot"} {t:"key", k, down} {t:"power"} {t:"wipe"}
// Worker -> page: {t:"frame", buf} {t:"stat", speed, usb, owner, id} {t:"error", error}
// Channel "wedgie-emu" (both ways, every tab): see port.ts.
import { boot, flashFromUf2, FLASH_BYTES, type Chip } from "./sim";
import { trustM, newTrustM, type TrustMState } from "./trustm";

const scope = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const ch = new BroadcastChannel("wedgie-emu");
let chip: Chip | null = null, id = "", owner: string | null = null, rom: Uint8Array;

// ---- this browser's copy of the board: flash + ID ----------------------------------------------
const db = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open("wedgie-emu", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function kv(key: string, val?: unknown, del = false): Promise<any> {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction("kv", val === undefined && !del ? "readonly" : "readwrite"), s = tx.objectStore("kv");
    const r = del ? s.delete(key) : val === undefined ? s.get(key) : s.put(val, key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let flash: Uint8Array, dirty = 0, chipState: TrustMState, chipDirty = false;
// Saved once the flash has been quiet for a second (an install writes for a while); the secure chip's
// keys and objects as soon as they change.
setInterval(() => {
  if (dirty && performance.now() - dirty > 1000) { dirty = 0; kv("flash", flash.slice()).catch(() => {}); }
  if (chipDirty) { chipDirty = false; kv("trustm", JSON.parse(JSON.stringify(chipState))).catch(() => {}); }
}, 500);

// fresh: a wiped flash, as a reflash leaves a real one. The board's ID (its flash chip's) and its secure
// chip, keys and all, stay: they're hardware.
async function load(fresh = false) {
  if (!rom) rom = new Uint8Array(await (await fetch("/emu/bootrom-b1.bin")).arrayBuffer());
  let uid: Uint8Array | undefined = await kv("uid").catch(() => undefined);
  if (!uid) { uid = crypto.getRandomValues(new Uint8Array(8)); await kv("uid", uid).catch(() => {}); }
  id = [...uid].map((b) => b.toString(16).padStart(2, "0")).join("");
  const saved: Uint8Array | undefined = fresh ? undefined : await kv("flash").catch(() => undefined);
  // New: a wedgie as the bench leaves one (firmware + Welcome, tools/emuimage.mjs); without that image, a
  // Pico with only MicroPython on it, which /emu then sets up over USB (slow).
  flash = saved?.length === FLASH_BYTES ? saved : await newFlash();
  if (!saved) await kv("flash", flash.slice()).catch(() => {});
  chipState = (await kv("trustm").catch(() => undefined)) || newTrustM();
  chipDirty = true;
  const tm = trustM(chipState, () => chip?.ms ?? 0, () => { chipDirty = true; });
  chip = boot({
    rom, flash, uid, i2c: tm,
    onData: (b) => { if (owner) ch.postMessage({ t: "rx", id, to: owner, data: b }); },
    onUsb: (up) => { if (!up) owner = null; ch.postMessage({ t: "usb", id, up }); stat(); },
    onFrame: () => { frameDue = true; },
    onFlash: () => { dirty = performance.now(); },
  });
}

async function newFlash() {
  const img = flashFromUf2(new Uint8Array(await (await fetch("/mp/RPI_PICO.uf2")).arrayBuffer()));
  const r = await fetch("/emu/wedgie-fs.img.gz").catch(() => null);
  if (r?.ok) {
    let fs = new Uint8Array(await r.arrayBuffer());
    if (fs[0] === 0x1f && fs[1] === 0x8b) fs = new Uint8Array(await new Response(new Blob([fs]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    img.set(fs, 0xa0000);      // where a Pico's filesystem starts
  }
  return img;
}

// ---- frames and stats to the page --------------------------------------------------------------
let frameDue = false, lastFrame = 0;
function frame() {
  if (!frameDue || !chip || performance.now() - lastFrame < 33) return;
  frameDue = false; lastFrame = performance.now();
  const copy = chip.frame.slice();
  scope.postMessage({ t: "frame", buf: copy.buffer }, [copy.buffer]);
}
let speed = 0;
const stat = () => scope.postMessage({ t: "stat", speed, usb: !!chip?.connected, owner: !!owner, id });

// ---- the run loop: the chip's time never runs ahead of the wall clock ----------------------------
// It usually runs behind (JS is slower than the chip): then it runs flat out and doesn't try to catch up.
let wall0 = 0, chip0 = 0, sWall = 0, sChip = 0;
const tick = new MessageChannel();
tick.port1.onmessage = loop;
function loop() {
  if (!chip) return;
  const now = performance.now();
  const ahead = chip.ms - chip0 - (now - wall0);
  if (ahead > 0) { releaseDue(); setTimeout(loop, Math.min(20, ahead)); frame(); return; }
  if (ahead < -100) { wall0 = now; chip0 = chip.ms; }
  const c = chip.ms;
  chip.run(8);
  releaseDue();
  sChip += chip.ms - c;
  if (now - sWall > 1000) { speed = sChip / (now - sWall); sWall = now; sChip = 0; stat(); }
  frame();
  tick.port2.postMessage(0);
}
function go() { wall0 = sWall = performance.now(); chip0 = chip!.ms; sChip = 0; loop(); }

// ---- keys: every press lasts at least MIN_PRESS of the chip's own time. A down and its up can land in
// the same gap between run slices (a quick click); the firmware polls every ~20 ms and would miss it.
const MIN_PRESS = 120;
const downAt = new Map<string, number>(), upDue = new Map<string, number>();
function key(k: string, down: boolean) {
  if (!chip) return;
  if (down) { upDue.delete(k); downAt.set(k, chip.ms); chip.key(k, true); return; }
  const due = (downAt.get(k) ?? 0) + MIN_PRESS;
  if (chip.ms >= due) chip.key(k, false); else upDue.set(k, due);
}
function releaseDue() {
  for (const [k, due] of upDue) if (chip && chip.ms >= due) { upDue.delete(k); chip.key(k, false); }
}

// ---- the USB serial port, for any wedgie.dev tab ---------------------------------------------------
// A tab opens it holding a Web Lock named for its session; the lock goes when the tab does (closed,
// crashed), so a port left open by a gone tab frees itself, like a real port whose program quit.
ch.onmessage = (e) => {
  const m = e.data;
  if (!chip || (m.id && m.id !== id)) return;
  if (m.t === "who") ch.postMessage({ t: "here", id, usb: chip.connected });
  else if (m.t === "open") {
    const ok = chip.connected && (!owner || owner === m.from);
    if (ok) owner = m.from;
    ch.postMessage({ t: ok ? "opened" : "refused", id, to: m.from });
    stat();
  } else if (m.t === "close" && owner === m.from) { owner = null; stat(); }
  else if (m.t === "tx" && owner === m.from) chip.write(m.data);
};
setInterval(async () => {
  if (!owner || !navigator.locks?.query) return;
  const q = await navigator.locks.query();
  if (owner && !q.held?.some((l) => l.name === "wedgie-emu-port-" + owner)) { owner = null; stat(); }
}, 2000);

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.t === "boot") { await load(); go(); ch.postMessage({ t: "here", id, usb: chip!.connected }); stat(); }
    else if (m.t === "key") key(m.k, m.down);
    else if (m.t === "power") { owner = null; chip?.powerCycle(); }
    else if (m.t === "wipe") {
      owner = null;
      if (chip?.connected) ch.postMessage({ t: "usb", id, up: false });
      chip = null;
      await kv("flash", undefined, true);
      await load(true); go(); stat();
    }
  } catch (err) {
    scope.postMessage({ t: "error", error: String((err as Error)?.message || err) });
  }
};
