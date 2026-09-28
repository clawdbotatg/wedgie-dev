// Put software on a wedgie: the firmware core, and cartridges (apps). /fw/manifest.json (tools/fw.mjs)
// lists every file with its sha256, which files are the core, and each cart's files and v.
// Only files whose sha256 differs are written; each goes base64 (binary-safe) into a temp file, is
// checked on the board, then renamed into place, so a cut-short copy never leaves half a file. main.py
// goes last in a core install so a cut-short install never boots half a firmware. A stale .mpy of a
// module we ship as .py is removed (MicroPython would import the old bytecode first).
//
// apps.json on the wedgie is its own list of what's in its launcher: {mod, name, entry?, about?, v}
// per cart, plus apps people saved themselves (kept as they are). Every write here rewrites it from
// what is really on the flash, so it can't drift.
//
// USB and resets: every step here runs in MicroPython's raw REPL with NO soft reset. Wedgie firmware
// 0.1.1+ adds its WEDGIE USB drive at power-up, which disconnects and reconnects USB; boot.py skips
// that on a soft reset (a watchdog scratch mark), but a soft reset still runs boot.py and older
// firmware re-adds the drive there, dropping this port mid-copy. Only installCore's caller reboots
// (it must, to run the new core), and then the wedgie comes back as a new port (wedgies.ts).
import type { Repl } from "./repl";

export type FileInfo = { name: string; size: number; sha256: string };
export type Cart = { mod: string; name: string; entry?: string; about?: string; files: string[]; v: string; size: number; label: string; icon: string[] };
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

/** Stop what the wedgie runs and take its raw REPL, without a soft reset. A launcher-run app is closed
 *  properly first (its Timer would otherwise keep drawing over everything). */
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

/** apps.json rebuilt from the flash: every cart whose files are all there (v from their real hashes,
 *  so a changed file shows as an update), in catalog order, then the person's own apps as they were. */
async function writeApps(r: Repl, m: Manifest, have: Have, drop: string[] = []) {
  const known = new Set(m.carts.map((c) => c.mod));
  const list: any[] = [];
  for (const c of m.carts) {
    if (drop.includes(c.mod) || c.files.some((n) => !have.hashes[n])) continue;
    list.push({ mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), about: c.about, v: await cartV(c.files.map((n) => have.hashes[n])) });
  }
  for (const a of have.apps || []) if (a && a.mod && !known.has(a.mod) && !drop.includes(a.mod)) list.push(a);
  await r.exec(`import json, os\n_f = open("apps.json", "w")\n_f.write(${JSON.stringify(JSON.stringify(list))})\n_f.close()\ntry:\n    os.sync()\nexcept AttributeError:\n    pass`);
  return list;
}
const allNames = (m: Manifest) => [...new Set([...m.core, ...m.carts.flatMap((c) => c.files)])];
const fileInfo = (m: Manifest, names: string[]) => names.map((n) => m.files.find((f) => f.name === n)!);

/** Install or update the firmware core (not the carts; the ones already on it stay). Leaves the board in
 *  raw REPL; the caller reboots it (the new core only runs after one). */
export async function installCore(r: Repl, onProgress: (p: number, what: string) => void, opts: { launcher?: boolean; screen?: boolean } = {}) {
  const m = await firmwareManifest();
  onProgress(0, "stopping what it runs");
  if (opts.launcher === false) await r.enter({ reset: false });   // a board already in the raw REPL (/test's bench)
  else await takeOver(r);
  onProgress(0.02, "checking what's on it");
  const have = await look(r, allNames(m));
  const stale = m.files.filter((f) => f.name.endsWith(".py")).map((f) => f.name.replace(/\.py$/, ".mpy"))
    .filter((n) => have.files.includes(n) && !m.files.some((f) => f.name === n));
  if (stale.length) await r.exec(`import os\nfor n in ${JSON.stringify(stale)}:\n    os.remove(n)`);
  const screen = opts.screen ? await deviceScreen(r, "updating", `wedgie ${m.version}`) : undefined;
  const todo = await copy(r, fileInfo(m, m.core), have, (p, w) => onProgress(0.05 + 0.9 * p, w), screen);
  const apps = await writeApps(r, m, have);
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

/** Put a cart on (or update it): its files that differ, then apps.json. The launcher comes back
 *  and opens it (the caller: leave, then launch). Stale copies of its modules are dropped from memory. */
export async function installCart(r: Repl, cart: Cart, onProgress: (p: number, what: string) => void, opts: { launcher?: boolean } = {}) {
  const m = await firmwareManifest();
  onProgress(0, "opening the slot");
  if (opts.launcher === false) await r.enter({ reset: false });
  else await takeOver(r);
  const have = await look(r, allNames(m));
  const need = cart.files.reduce((n, f) => n + (have.hashes[f] ? 0 : m.files.find((x) => x.name === f)!.size), 0);
  const screen = await deviceScreen(r, "inserting", cart.name);
  const free = await r.exec(`import os\n_s = os.statvfs("/")\nprint(_s[0] * _s[3])`).then((s) => parseInt(s.trim())).catch(() => NaN);
  if (free < need + 8192) throw new Error(`not enough room: it needs ${Math.ceil(need / 1024)} KB, ${Math.floor(free / 1024)} KB free. Remove a cartridge first.`);
  const todo = await copy(r, fileInfo(m, cart.files), have, onProgress, screen);
  const mods = todo.filter((f) => f.name.endsWith(".py")).map((f) => f.name.slice(0, -3));
  if (mods.length) await r.exec(`import sys\nfor _n in ${JSON.stringify(mods)}:\n    sys.modules.pop(_n, None)`);
  await screen?.(1);
  await writeApps(r, m, have);
  onProgress(1, todo.length ? "in" : "already in");
  return { written: todo.length };
}

/** Take a cart out: its files that no other cart on it (and not the core) still needs, then apps.json. */
export async function removeCart(r: Repl, cart: Cart) {
  const m = await firmwareManifest();
  await takeOver(r);
  const have = await look(r, allNames(m));
  const others = m.carts.filter((c) => c.mod !== cart.mod && c.files.every((n) => have.hashes[n]));
  const keep = new Set([...m.core, ...others.flatMap((c) => c.files)]);
  const gone = cart.files.filter((n) => !keep.has(n) && have.hashes[n]);
  if (gone.length) await r.exec(`import os, sys\nfor _n in ${JSON.stringify(gone)}:\n    os.remove(_n)\n    sys.modules.pop(_n.rsplit(".", 1)[0], None)`);
  for (const n of gone) have.hashes[n] = null;
  await writeApps(r, m, have, [cart.mod]);
}
