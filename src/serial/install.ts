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
// Apps from GitHub repos (src/apps/repos.ts): the reviewed ones are carts in the manifest like any other
// (their files are published to /fw/); one someone added themselves is a cart whose files carry a `url`,
// passed in with `manifest`. Either way apps.json records a repo app's `repo` and `files`, so whatever
// switches away from it (this, wedgie.py, another browser) knows which files to take off.
//
// USB and resets: every step here runs in MicroPython's raw REPL with NO soft reset. Wedgie firmware
// 0.1.1+ adds its WEDGIE USB drive at power-up, which disconnects and reconnects USB; boot.py skips
// that on a soft reset (a watchdog scratch mark), but a soft reset still runs boot.py and older
// firmware re-adds the drive there, dropping this port mid-copy. Only installCore's caller reboots
// (it must, to run the new core), and then the wedgie comes back as a new port (wedgies.ts).
import type { Repl } from "./repl";

/** url: where to fetch it, when it isn't /fw/<name> (an app from a repo someone added). */
export type FileInfo = { name: string; size: number; sha256: string; url?: string };
/** chip: the secure chip it needs ("ATECC608" / "OPTIGA Trust M", as the chip check names them), if any.
 *  fw: the oldest wedgie firmware it runs on. repo/sha: an app from a GitHub repo, at that commit; unreviewed: added on this browser, not on the shelf. */
export type Cart = { mod: string; name: string; entry?: string; usb?: boolean; chip?: string; fw?: string; about?: string; files: string[]; v: string; size: number; label: string; icon: string[]; repo?: string; sha?: string; unreviewed?: boolean };
/** Core files a newer core dropped: an update deletes them (0.2.0: the menu went). */
const RETIRED = ["menu.py", "menu.mpy"];
/** What the firmware keeps free for saves and itself (save.py FLOOR). */
const FLOOR = 32 * 1024;
/** Bytes per write while copying: small, so each needs little RAM in one piece (RP2040). */
const CHUNK = 1024;
export type Manifest = { version: string; files: FileInfo[]; core: string[]; carts: Cart[]; signed?: boolean };

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

const hex = (d: ArrayBuffer) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
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
_n = ${JSON.stringify(names)}
for _x in _a:
    _n += [f for f in _x.get("files", []) if isinstance(f, str)]
print("@hashes", json.dumps({"hashes": {n: _h(n) for n in _n}, "files": os.listdir(), "apps": _a}))`;

async function look(r: Repl, names: string[]): Promise<Have> {
  let have: Have | null = null;
  r.onLine = (t, v) => { if (t === "hashes") have = v; };
  await r.exec(HASHES(names), 30000);
  if (!have) throw new Error("the wedgie didn't list its files");
  return have;
}

// Ctrl-C stops the app but leaves everything it loaded in RAM (the app, the slot, their data). On an
// RP2040 that leaves too little room in one piece for a copy's chunk ("MemoryError: allocating 2733
// bytes"). So everything but the screen driver comes out of memory (lcd keeps the 115 KB framebuffer,
// which can't be allocated again on a used heap), then a collect. Code run after this imports what it needs.
const FREE_PY = `def _free():
    import gc, sys
    for n in list(sys.modules):
        if n not in ("lcd", "splash", "micropython") and n[0] != "_":   # _: the host's own (the emulator's _emu)
            del sys.modules[n]
    l = sys.modules.get("lcd")
    if l:
        del l._keys[:]          # every Keys() the app and the slot made
        l._on_show = None       # the loader's hook
    g = globals()
    for n in list(g):
        if not n.startswith("__"):
            del g[n]
    gc.collect()
_free()`;

/** Stop what the wedgie runs and take its raw REPL, without a soft reset, with its RAM freed. The app is
 *  stopped properly first (on 0.1.x its Timer would otherwise keep drawing over everything; 0.2 stops
 *  it on Ctrl-C too). 0.2.5+ is sealed: the person lets this computer in first (letIn). */
export async function takeOver(r: Repl, ask = askHint, job = "") {
  await letIn(r, ask, job);
  await r.request({ type: "stop" }, 800).catch(() => {});
  await r.enter({ reset: false });
  await r.exec(FREE_PY, 10000).catch(() => {});
}

export const ASK_TEXT = "Press A on the wedgie to let this computer in";
/** Where a page shows ASK_TEXT while the wedgie waits for its person ("" when they answered). */
export let askHint: (s: string) => void = () => {};
export function setAskHint(fn: (s: string) => void) { askHint = fn; }

/** A sealed wedgie (0.2.5+: its hello says sealed) turns Ctrl-C off, so the REPL is shut until its person
 *  presses A on its own screen ({"type": "open"}; Y or a minute with no answer is a no). Once they have,
 *  it stays open until its app starts again (the end of this job) and answers at once. Anything else (older firmware, bare
 *  MicroPython, a board already in its REPL) has no lock and is left alone. */
export async function letIn(r: Repl, ask: (s: string) => void = askHint, job = "") {
  const h = await r.hello(700).catch(() => null);
  if (!h?.sealed || h.open) return;
  ask(ASK_TEXT);
  const close = typeof document !== "undefined" ? (await import("../ui/askmodal")).askModal(job) : () => {};
  let v: any;
  try { v = await r.request({ type: "open", for: job }, 65000); }   // job: what the wedgie's screen asks
  catch { throw new Error("nobody pressed A on the wedgie"); }
  finally { ask(""); close(); }
  if (v.type === "open") return;
  if (v.type === "refused") throw new Error("the wedgie said no (Y on its screen)");
  if (v.type === "busy") throw new Error("the wedgie is busy signing; try again after");
  throw new Error(`the wedgie said ${v.error || v.type}`);
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
    const res = await fetch(f.url || "/fw/" + f.name, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${f.name}: couldn't fetch it (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A deploy since this page loaded: the manifest it read is older than the files it gets now.
    if (!f.url && hex(await crypto.subtle.digest("SHA-256", buf)) !== f.sha256) throw new Error("wedgie.dev was updated since this page opened. Reload the page, then try again");
    const tmp = "_wedgie.tmp";
    await r.exec(`import binascii\n_f = open(${JSON.stringify(tmp)}, "wb")`);
    for (let i = 0; i < buf.length; i += CHUNK) {
      await r.exec(`_f.write(binascii.a2b_base64(${JSON.stringify(b64(buf.subarray(i, i + CHUNK)))}))`);
      await at((done + Math.min(buf.length, i + CHUNK)) / total, f.name);
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
  const list = await appsFor(m, have, only);
  await r.exec(`import json, os\n_f = open("apps.json", "w")\n_f.write(${JSON.stringify(JSON.stringify(list))})\n_f.close()\ntry:\n    os.sync()\nexcept AttributeError:\n    pass`);
  return list;
}
/** What apps.json should say once `only` is the app (have: the files as they'll be). */
async function appsFor(m: Manifest, have: Have, only: string | null) {
  const list: any[] = [];
  const c = m.carts.find((x) => x.mod === only);
  if (c && c.files.every((n) => have.hashes[n])) {
    list.push({ mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), about: c.about, v: await cartV(c.files.map((n) => have.hashes[n])),
      ...(c.repo ? { repo: c.repo, files: c.files } : {}) });
  } else if (!c && only) {
    const own = (have.apps || []).find((a) => a && a.mod === only);
    if (own) list.push(own);
  }
  return list;
}

// ---- checked installs (firmware 0.3.0+, firmware/job.py) -----------------------------------------------
// The wedgie installs signed files itself: it checks /fw/release.txt against our key, asks its person
// ("Install Buttons?"), takes the files in chunks, checks each one's sha256 against the list, then puts
// them in place and restarts itself. The site never gets the REPL. Used when the wedgie can (hello says
// jobs), the manifest is signed, and every file is in the signed list (a GitHub app's aren't: those, the
// file explorer and /debug still ask for full access).

/** `have` without the REPL, or null when a checked install can't be used. */
async function checkedHave(r: Repl, m: Manifest, hash?: string[]): Promise<Have | null> {
  if (!m.signed) return null;
  const h = await r.hello(700).catch(() => null);
  if (!h?.jobs) return null;
  // hash: the files whose contents matter (the rest only need to be there or not; hashing the whole
  // flash took seconds before every question). 0.3.0-0.3.3 don't know exists: they get it all hashed.
  const rest = hash ? allNames(m).filter((n) => !hash.includes(n)) : [];
  let v = await r.request({ type: "sums", names: hash || allNames(m), exists: rest }, 30000).catch(() => null);
  if (v?.sums && rest.some((n) => !(n in v.sums))) v = await r.request({ type: "sums", names: allNames(m) }, 30000).catch(() => null);
  if (!v?.sums) return null;
  return { hashes: v.sums, files: Object.keys(v.sums).filter((n) => v.sums[n]), apps: v.apps || [] };
}

let release: Promise<{ text: string; sig: string }> | null = null;
const signedList = () => release ||= Promise.all(["release.txt", "release.sig"].map((n) => fetch("/fw/" + n, { cache: "no-cache" }).then((x) => x.text())))
  .then(([text, sig]) => ({ text, sig: sig.trim() }));

/** Run one checked job. False (nothing asked, nothing changed) when a file isn't in the signed list. */
async function job(r: Repl, m: Manifest, title: string, write: string[], del: string[], apps: any[] | null, onProgress: (p: number, what: string) => void) {
  const rel = await signedList();
  const listed = new Set(rel.text.split("\n").slice(2).map((l) => l.split("  ")[1]).filter(Boolean));
  if (!write.every((n) => listed.has(n) && !m.files.find((f) => f.name === n)?.url)) return false;
  const fetched = Promise.all(write.map(async (n) => {      // downloads while the wedgie asks
    const f = m.files.find((x) => x.name === n)!;
    const buf = new Uint8Array(await (await fetch("/fw/" + n, { cache: "no-cache" })).arrayBuffer());
    if (hex(await crypto.subtle.digest("SHA-256", buf)) !== f.sha256) throw new Error("wedgie.dev was updated since this page opened. Reload the page, then try again");
    return { n, buf };
  }));
  fetched.catch(() => {});
  askHint(ASK_TEXT); onProgress(0, ASK_TEXT);
  const close = (await import("../ui/askmodal")).askModal(title, true);
  let v: any;
  try { v = await r.request({ type: "job", job: title, release: rel.text, sig: rel.sig, write, delete: del, apps: apps && JSON.stringify(apps) }, 120000); }
  catch { throw new Error("nobody pressed A on the wedgie"); }
  finally { askHint(""); close(); }
  if (v.type === "refused") throw new Error("the wedgie said no (Y on its screen)");
  if (v.type === "busy") throw new Error("the wedgie is busy signing; try again after");
  if (v.type !== "go") throw new Error(`the wedgie said ${v.error || v.type}`);
  let files: { n: string; buf: Uint8Array }[];
  try { files = await fetched; } catch (e) { await r.request({ type: "abort" }, 5000).catch(() => {}); throw e; }
  const total = files.reduce((t, f) => t + f.buf.length, 0) || 1;
  let done = 0;
  for (const { n, buf } of files) {
    for (let o = 0; o < Math.max(buf.length, 1); o += CHUNK) {
      const a = await r.request({ type: "put", name: n, data: b64(buf.subarray(o, o + CHUNK)), end: o + CHUNK >= buf.length }, 15000);
      if (a.type !== "ok") throw new Error(`the wedgie stopped: ${a.error || a.type}`);
      done += Math.min(CHUNK, buf.length - o);
      onProgress(done / total, n);
    }
  }
  const d = await r.request({ type: "commit" }, 30000);
  if (d.type !== "done") throw new Error(`the wedgie stopped: ${d.error || d.type}`);
  return true;       // it restarts itself now: the caller doesn't leave() (its port may drop)
}
/** The app it runs now: the first in apps.json whose files are there (0.1.x kept several). */
function activeOf(m: Manifest, have: Have): string | null {
  for (const a of have.apps || []) {
    const c = m.carts.find((x) => x.mod === a?.mod);
    if (c ? c.files.every((n) => have.hashes[n]) : a?.mod && (have.files.includes(a.mod + ".py") || have.files.includes(a.mod + ".mpy"))) return a.mod;
  }
  return null;
}
/** Every app file on it (a cart's, or one apps.json lists for a repo app) that neither the core nor `keep` needs. */
function others(m: Manifest, have: Have, keep: string | null) {
  const listed = (have.apps || []).filter((a) => Array.isArray(a?.files));
  const filesOf = (mod: string | null) => m.carts.find((c) => c.mod === mod)?.files || listed.find((a) => a.mod === mod)?.files || [];
  const need = new Set([...m.core, ...filesOf(keep)]);
  return [...new Set([...m.carts.flatMap((c) => c.files), ...listed.flatMap((a) => a.files)])]
    .filter((n) => !need.has(n) && !m.core.includes(n) && have.hashes[n]);
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
  const ch = opts.launcher === false ? null : await checkedHave(r, m);
  if (ch) {
    const act = activeOf(m, ch);
    const sha = (n: string) => m.files.find((f) => f.name === n)!.sha256;
    const keep = m.carts.find((c) => c.mod === act)?.files || [];      // its app's files come up to date too
    const write = [...new Set([...m.core, ...keep])].filter((n) => ch.hashes[n] !== sha(n));
    const del = others(m, ch, act);
    for (const n of write) ch.hashes[n] = sha(n);
    for (const n of del) ch.hashes[n] = null;
    const apps = await appsFor(m, ch, act);
    if (!write.length && !del.length && JSON.stringify(apps) === JSON.stringify(ch.apps)) {
      onProgress(1, "already up to date");      // nothing to ask for; it keeps running
      return { version: m.version, written: 0, outdated: [] as Cart[], restarted: false, untouched: true };
    }
    if (await job(r, m, `Update firmware to ${m.version}`, write, del, apps, (p, w) => onProgress(0.02 + 0.96 * p, w))) {
      onProgress(1, write.length ? `${write.length} files updated` : "already up to date");
      return { version: m.version, written: write.length, outdated: m.carts.filter((c) => apps.some((a) => a.mod === c.mod && a.v !== c.v)), restarted: true, untouched: false };
    }
  }
  onProgress(0, "stopping what it runs");
  if (opts.launcher === false) await r.enter({ reset: false });   // a board already in the raw REPL (/format's bench)
  else await takeOver(r, (s) => { askHint(s); if (s) onProgress(0, s); }, `Update firmware to ${m.version}`);
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
  return { version: m.version, written: todo.length, outdated, restarted: false, untouched: false };
}

// The wedgie's own screen while software goes on: the boot screen and the boot bar (loader.screen, 0.3.3+).
// Older firmware has no loader.screen: it gets the old drawing below.
const INSERT_PY = `_ld = None
try:
    import loader as _ld
except ImportError:
    pass
if _ld and hasattr(_ld, "screen"):
    _bar = None
    def _ins(title, name, p):
        global _bar
        if _bar is None:
            _bar = _ld.screen(title, name) or False
        if _bar:
            _bar.to(p)
else:
    import lcd as _L
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
export async function useApp(r: Repl, cart: Cart, onProgress: (p: number, what: string) => void, opts: { launcher?: boolean; manifest?: Manifest } = {}) {
  const m = opts.manifest || await firmwareManifest();
  const ch = opts.launcher === false ? null : await checkedHave(r, m, cart.files);
  if (ch) {
    const sha = (n: string) => m.files.find((f) => f.name === n)?.sha256 || "";
    const write = cart.files.filter((n) => ch.hashes[n] !== sha(n));
    const del = others(m, ch, cart.mod);
    for (const n of write) ch.hashes[n] = sha(n);
    for (const n of del) ch.hashes[n] = null;
    if (await job(r, m, `Install ${cart.name}`, write, del, await appsFor(m, ch, cart.mod), onProgress)) {
      onProgress(1, write.length ? "in" : "already in");
      return { written: write.length, restarted: true };
    }
  }
  onProgress(0, "opening the slot");
  if (opts.launcher === false) await r.enter({ reset: false });
  else await takeOver(r, (s) => { askHint(s); if (s) onProgress(0, s); }, `Install ${cart.name}`);
  const have = await look(r, allNames(m));
  const size = (n: string) => m.files.find((x) => x.name === n)?.size ?? 0;   // 0: an old repo app's file (not in m); it frees its room anyway
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
  return { written: todo.length, restarted: false };
}

/** Take its app off: the app's files the core doesn't need, then an empty apps.json ("no software"). */
export async function removeApp(r: Repl) {
  const m = await firmwareManifest();
  const ch = await checkedHave(r, m, []);
  if (ch && await job(r, m, "Take its app off", [], others(m, ch, null), [], () => {})) return { restarted: true };
  await takeOver(r, askHint, "Take its app off");
  const have = await look(r, allNames(m));
  await removeFiles(r, have, others(m, have, null));
  await writeApps(r, m, have, null);
  return { restarted: false };
}
