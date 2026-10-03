// Files on a wedgie: list, read, delete, write. Two ways in:
//  - live: while its app runs, the slot (firmware 0.2+) answers ls / get / rm on USB, so looking at
//    files or saves stops nothing;
//  - raw: the raw REPL, for writes and for an app that has USB to itself (the Wallet). The caller
//    stops the app first (install.ts takeOver) and starts it again after.
// Saves live in /saves/<game>/ (firmware/save.py). A bundle ({"wedgie-saves": 1, files: {path: base64}})
// is how they leave the wedgie and come back: the Saves card's download, and /format's backup.
import type { Repl } from "./repl";

export type Entry = { path: string; size: number; dir: boolean };
export type Listing = { files: Entry[]; free: number | null };
export type Bundle = { "wedgie-saves": 1; id?: string; at?: string; files: Record<string, string> };

const entries = (raw: [string, number][]): Entry[] => raw.map(([p, n]) => ({ path: p.replace(/\/$/, ""), size: n, dir: p.endsWith("/") }));
export const b64 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function ls(r: Repl, path = "/", live = true): Promise<Listing> {
  if (live) {
    const v = await r.request({ type: "ls", path }, 8000);
    return { files: entries(v.files || []), free: v.free ?? null };
  }
  let got: any = null;
  r.onLine = (t, v) => { if (t === "ls") got = v; };
  await r.exec(`import wedgie, json\nprint("@ls", json.dumps({"files": wedgie.ls(${JSON.stringify(path)}), "free": wedgie.free()}))`, 20000);
  if (!got) throw new Error("the wedgie didn't list its files");
  return { files: entries(got.files), free: got.free ?? null };
}

/** A locked wedgie reads and deletes only saves over live USB (firmware/slot.py saves_only); anything
 *  else goes through the raw REPL, which its person lets in with A. */
export const isSave = (p: string) => p.startsWith("/saves/") && !p.split("/").includes("..");

export async function get(r: Repl, path: string, live = true): Promise<Uint8Array> {
  if (live) {
    const v = await r.request({ type: "get", path }, 8000);
    if (v.type === "error") throw new Error(v.error);
    return v.bytes;
  }
  const parts: string[] = [];
  r.onLine = (t, v) => { if (t === "b") parts.push(v); };
  await r.exec(`import binascii, json\nwith open(${JSON.stringify(path)}, "rb") as _f:\n    while True:\n        _b = _f.read(2048)\n        if not _b:\n            break\n        print("@b", json.dumps(binascii.b2a_base64(_b).decode().strip()))`, 60000);
  const chunks = parts.map(unb64);          // each line is its own base64 (2048 bytes pads): decode apart
  const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function rm(r: Repl, path: string, live = true) {
  if (live) {
    const v = await r.request({ type: "rm", path }, 8000);
    if (v.type === "error") throw new Error(v.error);
    return;
  }
  await r.exec(`import wedgie\nwedgie.rm(${JSON.stringify(path)})`, 20000);
}

// ---- the wedgie's screen while a computer works on it --------------------------------------------------
// Anything a computer does with the raw REPL shows the boot screen and the boot bar on the wedgie, titled
// with what it's doing (docs/STYLE.md: never "working..."). busy() puts it up (takeOver does, for every
// job); writeFile, the one way a file is written, moves the bar and refuses to write without it, so no
// path can copy files under a blank or stale screen. tools/test_style.py fails on any other writer.

// loader.screen (0.3.3+): the boot logo, the title over it, the bar, `what` under it. Older firmware has
// no loader.screen: it gets the old drawing below. A new title draws the screen again (an empty bar).
const BUSY_PY = `_ld = None
try:
    import loader as _ld
except ImportError:
    pass
_bs = [None, None, None]
if _ld and hasattr(_ld, "screen"):
    def _ins(title, what, p):
        if _bs[0] != title:
            _bs[2] = None
            import gc
            gc.collect()
            _bs[0], _bs[1] = title, what
            _bs[2] = _ld.screen(title, what) or False
        elif _bs[1] != what:
            _bs[1] = what
            _ld.what(what)
        if _bs[2]:
            _bs[2].to(p)
else:
    import lcd as _L
    _d = _L.LCD()
    def _ins(title, what, p):
        W, I, M = _L.color(254, 254, 254), _L.color(26, 27, 26), _L.color(120, 123, 120)
        _d.fill(W)
        for y, c in ((10, _L.color(34, 196, 82)), (19, _L.color(169, 170, 171)), (28, _L.color(227, 49, 44))):
            _d.fill_rect(0, y, 240, 5, c)
        _d.center_text(title, 92, M, 2)
        _d.center_text(what[:28], 120, I)
        _d.rect(30, 160, 180, 14, _L.color(200, 200, 196))
        _d.fill_rect(32, 162, int(176 * p), 10, _L.color(34, 196, 82))
        _d.show()`;

/** Put the boot screen up on the wedgie, titled with what this computer is doing ("Updating firmware",
 *  "Uploading"): call it before any write (takeOver does). A board without a screen shows nothing. */
export async function busy(r: Repl, title: string, what = "") {
  if (!r.busy) {
    r.busy = { title, what, p: 0, ok: false };
    r.busy.ok = await r.exec(BUSY_PY, 8000).then(() => true, () => false);
  }
  Object.assign(r.busy, { title, what, p: 0 });
  await draw(r);
}

/** Move the wedgie's bar (0..1, forward only) and change the line under it. Cheap to call often: the
 *  wedgie is told only when the bar moved a step or the line changed. */
export async function progress(r: Repl, p: number, what?: string) {
  const b = r.busy;
  if (!b) throw new Error("nothing on the wedgie's screen says what's happening: call busy() first");
  const w = what ?? b.what;
  if (w === b.what && (p <= b.p || (p - b.p < 0.08 && p < 1))) return;
  b.p = Math.max(b.p, p); b.what = w;
  await draw(r);
}

const draw = async (r: Repl) => {
  const b = r.busy!;
  if (b.ok) await r.exec(`_ins(${JSON.stringify(b.title)}, ${JSON.stringify(b.what.slice(0, 28))}, ${b.p.toFixed(2)})`, 8000).catch(() => {});
};

/** The one way a file is written on a wedgie (raw REPL): its folders made, a temp file, checked when sha
 *  is given, then renamed into place, so a cut-short write never leaves half a file. The bar moves from
 *  span[0] to span[1] as it goes (where this file sits in the whole job). */
export async function writeFile(r: Repl, path: string, bytes: Uint8Array, opts: { span?: [number, number]; what?: string; sha?: string; onChunk?: (p: number) => void } = {}) {
  const [a, z] = opts.span || [0, 1], what = opts.what ?? path.replace(/^\//, "");
  const at = async (i: number) => {
    const p = a + (z - a) * (bytes.length ? i / bytes.length : 1);
    opts.onChunk?.(p);
    await progress(r, p, what);
  };
  await at(0);
  const dirs = path.split("/").slice(1, -1).map((_, i, x) => "/" + x.slice(0, i + 1).join("/"));
  const tmp = "_wedgie.tmp", q = JSON.stringify;
  await r.exec(`import os, binascii\nfor _d in ${q(dirs)}:\n    try:\n        os.mkdir(_d)\n    except OSError:\n        pass\n_f = open(${q(tmp)}, "wb")`);
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await r.exec(`_f.write(binascii.a2b_base64(${q(b64(bytes.subarray(i, i + CHUNK)))}))`);
    await at(Math.min(bytes.length, i + CHUNK));
  }
  await r.exec("_f.close()");
  if (opts.sha) {
    let got: string | null = null;
    r.onLine = (t, v) => { if (t === "sha") got = v; };
    await r.exec(`import hashlib, json\n_s = hashlib.sha256()\nwith open(${q(tmp)}, "rb") as _f:\n    while True:\n        _b = _f.read(1024)\n        if not _b:\n            break\n        _s.update(_b)\nprint("@sha", json.dumps(binascii.hexlify(_s.digest()).decode()))`, 20000);
    if (got !== opts.sha) throw new Error(`${path.replace(/^\//, "")} didn't copy cleanly; try again`);
  }
  await r.exec(`try:\n    os.remove(${q(path)})\nexcept OSError:\n    pass\nos.rename(${q(tmp)}, ${q(path)})\ntry:\n    os.sync()\nexcept AttributeError:\n    pass`);
}
/** Base64 pieces: small, so the board never needs much RAM in one piece (RP2040). */
const CHUNK = 1024;

/** Write a file (raw REPL only). */
export const put = (r: Repl, path: string, bytes: Uint8Array) => writeFile(r, path, bytes);

/** Every save on it (or one game's), as a bundle. */
export async function saves(r: Repl, live = true, game?: string): Promise<Bundle> {
  const root = game ? `/saves/${game}` : "/saves";
  const { files } = await ls(r, root, live);
  const out: Bundle = { "wedgie-saves": 1, files: {} };
  for (const f of files) if (!f.dir) out.files[f.path] = b64(await get(r, f.path, live));
  return out;
}

/** Put a bundle's saves back (raw REPL). Only paths under /saves/ are written. */
export async function restore(r: Repl, b: Bundle) {
  const paths = Object.keys(b.files || {}).filter((p) => /^\/saves\/[^/]+\/[^/]+$/.test(p) && !p.includes(".."));
  for (const p of paths) await put(r, p, unb64(b.files[p]));
  return paths.length;
}

export function download(name: string, data: Uint8Array | string, type = "application/octet-stream") {
  const blob = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
