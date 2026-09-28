// Every wedgie on this computer's USB. The browser only shows us ports the person granted once
// (requestPort); after that getPorts() and the connect/disconnect events keep the list live.
// Nothing here touches navigator.serial until this browser has asked for a wedgie once (armed): on a
// Mac, Chrome's first look for serial ports (getPorts included) also looks for Bluetooth ones, and
// macOS pops "Chrome would like to use Bluetooth" at a visitor who only came to read.
// Identify: a running wedgie firmware answers {"type":"hello"} without being interrupted; any other
// MicroPython board is stopped, asked for its unique ID in the raw REPL, and soft-reset back into
// whatever it was running.
import { Repl } from "./repl";
import { checkChip, type ChipCheck } from "./chipcheck";

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
  carts?: { mod: string; v?: string }[];   // 0.1.4+: what's in its launcher, with the version each went on at
  running?: string | null; // the app on its screen (null: the launcher)
  free?: number;         // bytes free on its flash
  chip?: any;            // what answered on I2C: { type, serial? }
  proof?: ChipCheck & { state: "checking" | "done" | "unknown" };   // the chip proven working (once per plug-in)
  error?: string;
  log: string;
};

type Listener = () => void;

let nextKey = 1;
const list: Wedgie[] = [];
const listeners = new Set<Listener>();
let probeSrc: Promise<string> | null = null;

export const supported = () => "serial" in navigator;

const ARM = "wedgie.serial";
let armedNow = false;
try { armedNow = localStorage.getItem(ARM) === "1"; } catch {}
const onArm: (() => void)[] = [];
/** This browser has asked for a wedgie here before, so looking at its serial ports prompts nothing new. */
export const armed = () => armedNow;
/** Start looking at serial ports: a deliberate act (a Connect tap, the /test bench). */
export function arm() {
  if (armedNow) return;
  armedNow = true;
  try { localStorage.setItem(ARM, "1"); } catch {}
  onArm.splice(0).forEach((fn) => fn());
}
const whenArmed = (fn: () => void) => (armedNow ? fn() : onArm.push(fn));
const isMac = () => /Mac/.test(navigator.platform || navigator.userAgent);
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
v = None
if "wedgie.py" in os.listdir():
    try:
        import wedgie
        v = wedgie.VERSION
    except Exception:
        pass
import json
print("@id", json.dumps({"uid": machine.unique_id().hex(), "machine": m, "mp": os.uname().release, "files": sorted(os.listdir()), "wifi": w, "wedgie": v}))`;

async function identify(w: Wedgie) {
  w.state = "identifying"; w.error = undefined; emit();
  try {
    // A board that just rebooted or re-plugged its USB can't be opened for a moment: retry that.
    for (let tries = 0; ; tries++) {
      try { await talk(w); break; } catch (e: any) {
        if (tries >= 5 || !/failed to open|busy|access denied|already open/i.test(e?.message || "")) throw e;
        await new Promise((res) => setTimeout(res, 700));
      }
    }
    w.short = w.uid ? shortId(w.uid) : "??????";
    w.state = "ready";
  } catch (e: any) {
    w.state = "error";
    w.error = e?.message || String(e);
    if (/failed to open|busy|access denied|already open/i.test(w.error || "")) w.error = "Something else has this wedgie open: another wedgie.dev tab, mpremote or Thonny. Close it, then unplug and replug.";
  }
  emit();
}

// Plugging in: the WEDGIE drive (0.1.1+) disconnects and reconnects USB about a second after power-up,
// so a wedgie that was just plugged in shows up, vanishes and shows up again as a new port. That's why
// the connect listener waits before identifying, why identify retries a port that won't open yet, and
// why nothing here soft-resets a wedgie: a soft reset used to re-add the drive, drop the port, and
// the replug got identified again (a restart loop). See firmware/boot.py.
function talk(w: Wedgie) {
  return withRepl(w, async (r) => {
    await new Promise((res) => setTimeout(res, 150));
    // A wedgie that just plugged in may still be booting (logo, loader): keep asking for ~4 s before
    // falling back to the REPL, which would interrupt it.
    let h: any = null;
    for (let i = 0; i < 6 && !h; i++) h = await r.hello(700);
    if (!h) {
      let got: any = null;
      r.onLine = (tag, v) => { if (tag === "id") got = v; };
      await r.write("\r\x03\x03");
      await new Promise((res) => setTimeout(res, 120));
      await r.write("\x01");
      await r.waitFor("raw REPL; CTRL-B to exit\r\n>", 8000).catch(() => { throw new Error("No MicroPython answered. Is it flashed?"); });
      await r.exec(ID_PY, 5000);
      // Back to what it was running, without a soft reset (see above).
      await r.leave({ reset: false });
      if (!got) throw new Error("no answer");
      const cpu = got.machine.includes("RP2350") ? "RP2350" : got.machine.includes("RP2040") ? "RP2040" : "?";
      w.uid = got.uid; w.cpu = cpu; w.micropython = got.mp; w.files = got.files;
      w.board = boardName(cpu, got.wifi, got.machine);
      if (!got.wedgie) {
        w.firmware = got.files.includes("main.py") ? "its own main.py" : "nothing yet";
        w.kind = "micropython";
        return;
      }
      // Wedgie firmware busy in an app that owns the CPU (Demo, Wallet): we stopped it, and main.py
      // (just run by leave) starts the launcher, which can now answer.
      for (let i = 0; i < 8 && !h; i++) h = await r.hello(700);
      if (!h) { w.kind = "wedgie"; w.version = got.wedgie; w.firmware = `wedgie ${got.wedgie}`; w.running = null; return; }
    }
    // wedgie firmware (or the wallet app): take what it says, leave it running.
    w.firmware = `${h.name || "wedgie"} ${h.version || h.fw || ""}`.trim();
    w.kind = String(h.fw || "").startsWith("wedgie-") ? "wedgie" : "wallet";
    w.version = h.version;
    w.apps = h.apps;
    w.carts = h.carts;
    w.free = h.free ?? undefined;
    w.running = w.kind === "wallet" ? "usbwallet" : h.running ?? null;
    w.uid = h.uid || h.serial;
    w.micropython = h.micropython;
    w.cpu = h.cpu;
    if (h.backend) w.chip = { type: h.backend === "atecc608" ? "ATECC608" : h.backend, serial: h.serial };
    w.board = h.board || "wedgie";
    if (w.kind === "wedgie" && h.carts) await prove(w, r);
    else w.proof = { state: "unknown", pass: false, facts: [],
      detail: w.kind === "wallet" ? "The Wallet is running; it checks the chip itself" : "Update the firmware to check the chip" };
  });
}

/** The chip proven working, once per plug-in, without stopping anything: firmware 0.1.4's launcher
 *  does the chip work on request and the page checks the answer (chipcheck.ts). */
async function prove(w: Wedgie, r: Repl) {
  w.proof = { state: "checking", pass: false, detail: "checking the chip", facts: [] };
  emit();
  try {
    const d = await r.request({ type: "chip" }, 15000);
    w.chip = d.chip ? { type: d.chip, serial: d.serial, configLocked: d.configLocked } : { type: "none" };
    if (!d.kind) {
      w.proof = { state: "done", pass: false, facts: [], detail: d.error ? `No chip answered, but the I2C lines have power: a data wire and the power wire are probably swapped` :
        "No chip: the I2C lines have no power, so it isn't connected" };
      return;
    }
    w.proof = { state: "done", ...(await checkChip(d)) };
  } catch (e: any) {
    w.proof = { state: "unknown", pass: false, facts: [], detail: `Couldn't check the chip: ${e?.message || e}` };
  }
}

/** Ask a wedgie to prove its chip again (the detail page's re-check). r: the page's open session. */
export async function reprove(w: Wedgie, r: Repl) { await prove(w, r); emit(); }

export function reidentify(w: Wedgie) { identify(w); }

// A new grant fires no connect event, so the header's count is told directly.
const granted = new Set<() => void>();

// Before the first picker on a Mac: say why the computer is about to ask about Bluetooth.
function explain() {
  return new Promise<boolean>((done) => {
    const el = document.createElement("div");
    el.className = "panel-wrap";
    el.innerHTML = `<div class="card bt-ask" role="dialog" aria-label="Bluetooth access">
      <h3>Your Mac will ask about Bluetooth</h3>
      <p>To find your wedgie, Chrome looks at this computer's serial ports, and macOS counts that as Bluetooth. When it asks, press <b>Allow</b>. wedgie.dev only talks to wedgies plugged into USB.</p>
      <div class="row"><button class="btn btn-green" id="bt-go">OK, find my wedgie</button><button class="btn" id="bt-no">Not now</button></div>
    </div>`;
    const close = (go: boolean) => { el.remove(); done(go); };
    el.addEventListener("click", (e) => { if (e.target === el) close(false); });
    el.querySelector<HTMLElement>("#bt-go")!.onclick = () => close(true);
    el.querySelector<HTMLElement>("#bt-no")!.onclick = () => close(false);
    document.body.appendChild(el);
    el.querySelector<HTMLElement>("#bt-go")!.focus();
  });
}

/** The browser's device picker. Grants this site the port; talks to nothing. */
export async function allow() {
  if (!armedNow && isMac() && !(await explain())) throw new DOMException("not now", "AbortError");
  const pick = navigator.serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] });
  arm(); // picked or cancelled, the Mac has asked by now
  const port = await pick;
  granted.forEach((fn) => fn());
  return port;
}

export async function connectNew() {
  return add(await allow());
}

/** Count plugged-in wedgies without talking to them (the header's Connect button, on any page).
 *  Only ports this site was granted once are visible; opening none of them interrupts nothing. */
export function watchCount(cb: (n: number) => void) {
  if (!supported()) { cb(0); return; }
  if (!armedNow) cb(0);
  whenArmed(() => watchPorts(cb));
}
function watchPorts(cb: (n: number) => void) {
  const count = async () => cb((await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === RPI_VID && (p as any).connected !== false).length);
  count();
  granted.add(count);
  navigator.serial.addEventListener("connect", () => setTimeout(count, 300));
  navigator.serial.addEventListener("disconnect", () => setTimeout(count, 300));
}

export function start() {
  if (supported()) whenArmed(startPorts);
}
async function startPorts() {
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
