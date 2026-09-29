// Put software on a wedgie: the firmware core, and the one app it runs. /fw/manifest.json (tools/fw.mjs)
// lists every file with its sha256, which files are the core, and each cart's files and v.
// Only files whose sha256 differs are written; each goes base64 (binary-safe) into a temp file, is
// checked on the board, then renamed into place, so a cut-short copy never leaves half a file. main.py
// goes last in a core install so a cut-short install never boots half a firmware. A stale .mpy of a
// module we ship as .py is removed (MicroPython would import the old bytecode first).
//
// apps.json on the wedgie names the one app it runs: [{mod, name, entry?, usb?, about?, v}] for a cart,
// or an app people saved themselves (kept as it is). Every write here rewrites it from what is really
// on the flash, so it can't drift. Picking another app takes the old one's files off (a wedgie holds
// one app); /saves is never touched.
//
// USB and resets: every step here runs in MicroPython's raw REPL with NO soft reset. Wedgie firmware
// 0.1.1+ adds its WEDGIE USB drive at power-up, which disconnects and reconnects USB; boot.py skips
// that on a soft reset (a watchdog scratch mark), but a soft reset still runs boot.py and older
// firmware re-adds the drive there, dropping this port mid-copy. Only installCore's caller reboots
// (it must, to run the new core), and then the wedgie comes back as a new port (wedgies.ts).
import type { Repl } from "./repl";

export type FileInfo = { name: string; size: number; sha256: string };
export type Cart = { mod: string; name: string; entry?: string; usb?: boolean; about?: string; files: string[]; v: string; size: number; label: string; icon: string[] };
/** Core files a newer core dropped: an update deletes them (0.2.0: the menu went). */
const RETIRED = ["menu.py", "menu.mpy"];
/** What the firmware keeps free for saves and itself (save.py FLOOR). */
const FLOOR = 32 * 1024;
export type Manifest = { version: string; files: FileInfo[]; core: string[]; carts: Cart[] };

let manifest: Promise<Manifest> | null = null;
export function firmwareManifest(): Promise<Manifest> {
  if (!manifest) manifest = fetch("/fw/manifest.json", { cache: "no-cache" }).then((r) => r.json());
  return manifest;
}

/** A cart's version from its files' sha256s, in carts.json order. Same as cartV in tools/fw.mjs. */
export async function cartV(hashes: (string | null)[]) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashes.join("\n")));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const b64 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

type Have = { hashes: Record<string, string | null>; files: string[]; apps: any[] };
const HASHES = (names: string[]) => `import os, json, hashlib, binascii
def _h(n):
    try:
        h = hashlib.sha256()
        with open(n, "rb") as f:
            while True:
                b = f.read(1024)
                if not b: break
                h.update(b)
        return binascii.hexlify(h.digest()).decode()
    except OSError:
        return None
try:
    _a = json.load(open("apps.json"))
except Exception:
    _a = []
print("@hashes", json.dumps({"hashes": {n: _h(n) for n in ${JSON.stringify(names)}}, "files": os.listdir(), "apps": _a}))`;

async function look(r: Repl, names: string[]): Promise<Have> {
  let have: Have | null = null;
  r.onLine = (t, v) => { if (t === "hashes") have = v; };
  await r.exec(HASHES(names), 30000);
  if (!have) throw new Error("the wedgie didn't list its files");
  return have;
}

/** Stop what the wedgie runs and take its raw REPL, without a soft reset. The app is stopped properly
 *  first (on 0.1.x its Timer would otherwise keep drawing over everything; 0.2 stops it on Ctrl-C too). */
export async function takeOver(r: Repl) {
  await r.request({ type: "home" }, 800).catch(() => {});
  await r.enter({ reset: false });
}

async function copy(r: Repl, files: FileInfo[], have: Have, onProgress: (p: number, what: string) => void, screen?: (p: number) => Promise<void>) {
  const todo = files.filter((f) => have.hashes[f.name] !== f.sha256)
    .sort((a, b) => (a.name === "main.py" ? 1 : b.name === "main.py" ? -1 : 0));
  const total = todo.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0, drawn = -1;
  const at = async (p: number, what: string) => {
    onProgress(p, what);
    if (screen && p - drawn >= 0.12) { drawn = p; await screen(p); }
  };
  for (const f of todo) {
    await at(done / total, f.name);
    const buf = new Uint8Array(await (await fetch("/fw/" + f.name, { cache: "no-cache" })).arrayBuffer());
    const tmp = "_wedgie.tmp";
    await r.exec(`import binascii\n_f = open(${JSON.stringify(tmp)}, "wb")`);
    for (let i = 0; i < buf.length; i += 2048) {
      await r.exec(`_f.write(binascii.a2b_base64(${JSON.stringify(b64(buf.subarray(i, i + 2048)))}))`);
      await at((done + Math.min(buf.length, i + 2048)) / total, f.name);
    }
    await r.exec("_f.close()");
    let check: string | null = null;
    r.onLine = (t, v) => { if (t === "sha") check = v; };
    await r.exec(`print("@sha", json.dumps(_h(${JSON.stringify(tmp)})))`, 20000); // _h from HASHES, still defined
    if (check !== f.sha256) throw new Error(`${f.name} didn't copy cleanly; try again`);
    await r.exec(`import os\ntry:\n    os.remove(${JSON.stringify(f.name)})\nexcept OSError:\n    pass\nos.rename(${JSON.stringify(tmp)}, ${JSON.stringify(f.name)})`);
    have.hashes[f.name] = f.sha256;
    done += f.size;
  }
  return todo;
}

/** apps.json rebuilt from the flash: the one app (`only`: a cart whose files are all there, v from their
 *  real hashes so a changed file shows as an update, or the person's own app as it was), or none. */
async function writeApps(r: Repl, m: Manifest, have: Have, only: string | null) {
  const list: any[] = [];
  const c = m.carts.find((x) => x.mod === only);
  if (c && c.files.every((n) => have.hashes[n])) {
    list.push({ mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), about: c.about, v: await cartV(c.files.map((n) => have.hashes[n])) });
  } else if (!c && only) {
    const own = (have.apps || []).find((a) => a && a.mod === only);
    if (own) list.push(own);
  }
  await r.exec(`import json, os\n_f = open("apps.json", "w")\n_f.write(${JSON.stringify(JSON.stringify(list))})\n_f.close()\ntry:\n    os.sync()\nexcept AttributeError:\n    pass`);
  return list;
}
/** The app it runs now: the first in apps.json whose files are there (0.1.x kept several). */
function activeOf(m: Manifest, have: Have): string | null {
  for (const a of have.apps || []) {
    const c = m.carts.find((x) => x.mod === a?.mod);
    if (c ? c.files.every((n) => have.hashes[n]) : a?.mod && (have.files.includes(a.mod + ".py") || have.files.includes(a.mod + ".mpy"))) return a.mod;
  }
  return null;
}
/** Every cart file on it that neither the core nor `keep` needs. */
function others(m: Manifest, have: Have, keep: string | null) {
  const need = new Set([...m.core, ...(m.carts.find((c) => c.mod === keep)?.files || [])]);
  return [...new Set(m.carts.flatMap((c) => c.files))].filter((n) => !need.has(n) && have.hashes[n]);
}
async function removeFiles(r: Repl, have: Have, names: string[]) {
  if (!names.length) return;
  await r.exec(`import os, sys\nfor _n in ${JSON.stringify(names)}:\n    try:\n        os.remove(_n)\n    except OSError:\n        pass\n    sys.modules.pop(_n.rsplit(".", 1)[0], None)`);
  for (const n of names) have.hashes[n] = null;
}
const allNames = (m: Manifest) => [...new Set([...m.core, ...m.carts.flatMap((c) => c.files)])];
const fileInfo = (m: Manifest, names: string[]) => names.map((n) => m.files.find((f) => f.name === n)!);

/** Install or update the firmware core (not the carts; the ones already on it stay). Leaves the board in
 *  raw REPL; the caller reboots it (the new core only runs after one). */
export async function installCore(r: Repl, onProgress: (p: number, what: string) => void, opts: { launcher?: boolean; screen?: boolean } = {}) {
  const m = await firmwareManifest();
  onProgress(0, "stopping what it runs");
  if (opts.launcher === false) await r.enter({ reset: false });   // a board already in the raw REPL (/format's bench)
  else await takeOver(r);
  onProgress(0.02, "checking what's on it");
  const have = await look(r, allNames(m));
  const stale = m.files.filter((f) => f.name.endsWith(".py")).map((f) => f.name.replace(/\.py$/, ".mpy"))
    .filter((n) => have.files.includes(n) && !m.files.some((f) => f.name === n));
  const retired = RETIRED.filter((n) => have.files.includes(n));
  if (stale.length || retired.length) await r.exec(`import os\nfor n in ${JSON.stringify([...stale, ...retired])}:\n    os.remove(n)`);
  const screen = opts.screen ? await deviceScreen(r, "updating", `wedgie ${m.version}`) : undefined;
  const fromMenu = retired.length > 0;          // 0.1.x (the menu): it starts with no app, the person picks one
  const todo = await copy(r, fileInfo(m, m.core), have, (p, w) => onProgress(0.05 + 0.9 * p, w), screen);
  // One app from 0.2 on: it keeps its app; the other carts' files go (never its saves).
  const act = fromMenu ? null : activeOf(m, have);
  await removeFiles(r, have, others(m, have, act));
  const apps = await writeApps(r, m, have, act);
  onProgress(1, todo.length ? `${todo.length} files updated` : "already up to date");
  const outdated = m.carts.filter((c) => apps.some((a) => a.mod === c.mod && a.v !== c.v));
  return { version: m.version, written: todo.length, outdated };
}

// The wedgie's own screen while software goes on: the waistband, what's happening, a bar.
const INSERT_PY = `import lcd as _L
_d = _L.LCD()
def _ins(title, name, p):
    W, I, M = _L.color(254, 254, 254), _L.color(26, 27, 26), _L.color(120, 123, 120)
    _d.fill(W)
    for y, c in ((10, _L.color(34, 196, 82)), (19, _L.color(169, 170, 171)), (28, _L.color(227, 49, 44))):
        _d.fill_rect(0, y, 240, 5, c)
    _d.center_text(title, 92, M, 2)
    _d.center_text(name, 120, I, 2)
    _d.rect(30, 160, 180, 14, _L.color(200, 200, 196))
    _d.fill_rect(32, 162, int(176 * p), 10, _L.color(34, 196, 82))
    _d.show()`;

/** Draw on the wedgie's own screen while we work (needs its lcd.py; a board without one shows nothing). */
async function deviceScreen(r: Repl, title: string, name: string) {
  try {
    await r.exec(INSERT_PY, 8000);
    const draw = async (p: number) => { await r.exec(`_ins(${JSON.stringify(title)}, ${JSON.stringify(name.slice(0, 14))}, ${p.toFixed(2)})`, 8000).catch(() => {}); };
    await draw(0);
    return draw;
  } catch { return undefined; }
}

/** Make `cart` the app it runs: the old app's files come off, its files that differ go on, apps.json
 *  names it. Leaves the board in raw REPL; the caller restarts it (Repl.leave: a soft reset, the port
 *  stays, a fresh heap for the app). Checked for room first, so a switch that can't fit changes nothing. */
export async function useApp(r: Repl, cart: Cart, onProgress: (p: number, what: string) => void, opts: { launcher?: boolean } = {}) {
  const m = await firmwareManifest();
  onProgress(0, "opening the slot");
  if (opts.launcher === false) await r.enter({ reset: false });
  else await takeOver(r);
  const have = await look(r, allNames(m));
  const size = (n: string) => m.files.find((x) => x.name === n)!.size;
  const need = cart.files.reduce((t, f) => t + (have.hashes[f] ? 0 : size(f)), 0);
  const gone = others(m, have, cart.mod);
  const freed = gone.reduce((t, f) => t + size(f), 0);
  const free = await r.exec(`import os\n_s = os.statvfs("/")\nprint(_s[0] * _s[3])`).then((s) => parseInt(s.trim())).catch(() => NaN);
  if (free + freed < need + FLOOR) throw new Error(`not enough room: it needs ${Math.ceil(need / 1024)} KB and ${Math.floor((free + freed - FLOOR) / 1024)} KB is free. Delete some saves or files first.`);
  const screen = await deviceScreen(r, "installing", cart.name);
  await removeFiles(r, have, gone);
  const todo = await copy(r, fileInfo(m, cart.files), have, onProgress, screen);
  const mods = todo.filter((f) => f.name.endsWith(".py")).map((f) => f.name.slice(0, -3));
  if (mods.length) await r.exec(`import sys\nfor _n in ${JSON.stringify(mods)}:\n    sys.modules.pop(_n, None)`);
  await screen?.(1);
  await writeApps(r, m, have, cart.mod);
  onProgress(1, todo.length ? "in" : "already in");
  return { written: todo.length };
}

/** Take its app off: the app's files the core doesn't need, then an empty apps.json ("no software"). */
export async function removeApp(r: Repl) {
  const m = await firmwareManifest();
  await takeOver(r);
  const have = await look(r, allNames(m));
  await removeFiles(r, have, others(m, have, null));
  await writeApps(r, m, have, null);
}
