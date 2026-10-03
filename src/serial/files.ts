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

/** Write a file (raw REPL only): its folders made, a temp file, then renamed into place. */
export async function put(r: Repl, path: string, bytes: Uint8Array) {
  const dirs = path.split("/").slice(1, -1).map((_, i, a) => "/" + a.slice(0, i + 1).join("/"));
  const tmp = path + ".tmp";
  await r.exec(`import os, binascii\nfor _d in ${JSON.stringify(dirs)}:\n    try:\n        os.mkdir(_d)\n    except OSError:\n        pass\n_f = open(${JSON.stringify(tmp)}, "wb")`);
  for (let i = 0; i < bytes.length; i += 1024) await r.exec(`_f.write(binascii.a2b_base64(${JSON.stringify(b64(bytes.subarray(i, i + 1024)))}))`);
  await r.exec(`_f.close()\ntry:\n    os.remove(${JSON.stringify(path)})\nexcept OSError:\n    pass\nos.rename(${JSON.stringify(tmp)}, ${JSON.stringify(path)})\ntry:\n    os.sync()\nexcept AttributeError:\n    pass`);
}

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
