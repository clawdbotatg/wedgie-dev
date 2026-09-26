// Every wedgie on this computer's USB. The browser only shows us ports the person granted once
// (requestPort); after that getPorts() and the connect/disconnect events keep the list live.
// Identify: a running wedgie firmware answers {"type":"hello"} without being interrupted; any other
// MicroPython board is stopped, asked for its unique ID in the raw REPL, and soft-reset back into
// whatever it was running.
import { Repl } from "./repl";

export const RPI_VID = 0x2e8a;

export type Wedgie = {
  key: number;
  port: SerialPort;
  state: "identifying" | "ready" | "busy" | "error" | "gone";
  uid?: string;          // board unique_id hex
  short?: string;        // what we print next to it
  board?: string;        // Pico 2 W / Pico W / RP2040 board
  cpu?: string;
  micropython?: string;
  files?: string[];
  firmware?: string;     // what it runs, if it said
  kind?: "wedgie" | "wallet" | "micropython";
  version?: string;      // wedgie firmware version
  apps?: string[];
  chip?: any;            // from probe chip()
  error?: string;
  log: string;
};

type Listener = () => void;

let nextKey = 1;
const list: Wedgie[] = [];
const listeners = new Set<Listener>();
let probeSrc: Promise<string> | null = null;

export const supported = () => "serial" in navigator;
export const wedgies = () => list.filter((w) => w.state !== "gone");
export function onChange(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => fn());
/** Something about a wedgie changed outside identify (the panel updated it): repaint. */
export const touch = emit;

export function boardName(cpu: string, wifi: boolean, machine = "") {
  if (cpu === "RP2350") return wifi ? "Pico 2 W" : "Pico 2";
  if (cpu === "RP2040") return wifi ? "Pico W" : "RP2040 Pico";
  return machine || "MicroPython board";
}

export const shortId = (uid: string) => uid.slice(-6).toUpperCase();

function add(port: SerialPort) {
  const have = list.find((w) => w.port === port && w.state !== "gone");
  if (have) return have;
  const w: Wedgie = { key: nextKey++, port, state: "identifying", log: "" };
  list.push(w);
  emit();
  identify(w);
  return w;
}

// One conversation with a wedgie at a time.
const locks = new Map<number, Promise<unknown>>();
export function withRepl<T>(w: Wedgie, fn: (r: Repl) => Promise<T>): Promise<T> {
  const prev = locks.get(w.key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const r = new Repl(w.port);
    r.onText = (s) => { w.log = (w.log + s.replace(/[\x01-\x08]/g, (c) => "^" + String.fromCharCode(64 + c.charCodeAt(0)))).slice(-30000); };
    await r.open();
    try { return await fn(r); } finally { await r.close(); }
  });
  locks.set(w.key, run);
  return run;
}

export function probe() {
  if (!probeSrc) probeSrc = fetch("/device/probe.py").then((r) => { if (!r.ok) throw new Error("probe.py missing"); return r.text(); });
  return probeSrc;
}

const ID_PY = `import sys, os, machine
m = sys.implementation._machine
w = False
try:
    import network
    w = True
except ImportError:
    pass
import json
print("@id", json.dumps({"uid": machine.unique_id().hex(), "machine": m, "mp": os.uname().release, "files": sorted(os.listdir()), "wifi": w}))`;

async function identify(w: Wedgie) {
  w.state = "identifying"; w.error = undefined; emit();
  try {
    await withRepl(w, async (r) => {
      await new Promise((res) => setTimeout(res, 150));
      const h = await r.hello();
      if (h) {
        // wedgie firmware (or the wallet app): take what it says, leave it running.
        w.firmware = `${h.name || "wedgie"} ${h.version || h.fw || ""}`.trim();
        w.kind = String(h.fw || "").startsWith("wedgie-") ? "wedgie" : "wallet";
        w.version = h.version;
        w.apps = h.apps;
        w.uid = h.uid || h.serial;
        w.micropython = h.micropython;
        w.cpu = h.cpu;
        if (h.backend) w.chip = { type: h.backend === "atecc608" ? "ATECC608" : h.backend, serial: h.serial };
        w.board = h.board || "wedgie";
        return;
      }
      let got: any = null;
      r.onLine = (tag, v) => { if (tag === "id") got = v; };
      await r.write("\r\x03\x03");
      await new Promise((res) => setTimeout(res, 120));
      await r.write("\x01");
      await r.waitFor("raw REPL; CTRL-B to exit\r\n>", 3000).catch(() => { throw new Error("No MicroPython answered. Is it flashed?"); });
      await r.exec(ID_PY, 5000);
      await r.leave(); // back to normal REPL + soft reset: its main.py starts again
      if (!got) throw new Error("no answer");
      const cpu = got.machine.includes("RP2350") ? "RP2350" : got.machine.includes("RP2040") ? "RP2040" : "?";
      w.uid = got.uid; w.cpu = cpu; w.micropython = got.mp; w.files = got.files;
      w.board = boardName(cpu, got.wifi, got.machine);
      w.firmware = got.files.includes("main.py") ? "its own main.py" : "nothing yet";
      w.kind = "micropython";
    });
    w.short = w.uid ? shortId(w.uid) : "??????";
    w.state = "ready";
  } catch (e: any) {
    w.state = "error";
    w.error = e?.message || String(e);
    if (/open|busy|access/i.test(w.error || "")) w.error = "The port is busy. Close other tabs or tools (mpremote, Thonny) using this wedgie.";
  }
  emit();
}

export function reidentify(w: Wedgie) { identify(w); }

export async function connectNew() {
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] });
  return add(port);
}

/** Count plugged-in wedgies without talking to them (the header's Connect button, on any page).
 *  Only ports this site was granted once are visible; opening none of them interrupts nothing. */
export function watchCount(cb: (n: number) => void) {
  if (!supported()) { cb(0); return; }
  const count = async () => cb((await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === RPI_VID && (p as any).connected !== false).length);
  count();
  navigator.serial.addEventListener("connect", () => setTimeout(count, 300));
  navigator.serial.addEventListener("disconnect", () => setTimeout(count, 300));
}

export async function start() {
  if (!supported()) return;
  for (const p of await navigator.serial.getPorts()) if (p.getInfo().usbVendorId === RPI_VID) add(p);
  navigator.serial.addEventListener("connect", (e: Event) => {
    const port = ((e as any).port || e.target) as SerialPort;
    setTimeout(() => add(port), 1200); // let it boot
  });
  navigator.serial.addEventListener("disconnect", (e: Event) => {
    const port = ((e as any).port || e.target) as SerialPort;
    for (const w of list) if (w.port === port) w.state = "gone";
    emit();
  });
}
