// Put wedgie firmware (/fw/manifest.json) on a board that runs MicroPython. Only files whose sha256
// differs are written; each is sent base64 (binary-safe), checked on the board, and main.py goes last
// so a cut-short install never boots half a firmware. A stale .mpy of a module we ship as .py is
// removed (MicroPython would import the old bytecode first). Lessons from picowallet's ship.mjs:
// soft-reset before writing (no app timers touching the flash), os.sync after.
import type { Repl } from "./repl";

export type Manifest = { version: string; files: { name: string; size: number; sha256: string }[]; apps: App[] };
export type App = { mod: string; name: string; entry?: string; about?: string };

let manifest: Promise<Manifest> | null = null;
export function firmwareManifest(): Promise<Manifest> {
  if (!manifest) manifest = fetch("/fw/manifest.json", { cache: "no-cache" }).then((r) => r.json());
  return manifest;
}

const b64 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

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
_have = os.listdir()
print("@hashes", json.dumps({"hashes": {n: _h(n) for n in ${JSON.stringify(names)}}, "files": _have}))`;

/** Install or update. onProgress(0..1, what). Leaves the board in raw REPL; the caller leave()s it. */
export async function install(r: Repl, onProgress: (p: number, what: string) => void) {
  const m = await firmwareManifest();
  onProgress(0, "stopping what it runs");
  await r.enter({ reset: false });           // no soft reset: on 0.1.1+ that would drop the USB port
  let have: { hashes: Record<string, string | null>; files: string[] } | null = null;
  r.onLine = (t, v) => { if (t === "hashes") have = v; };
  onProgress(0.02, "checking what's on it");
  await r.exec(HASHES(m.files.map((f) => f.name)), 30000);
  if (!have) throw new Error("the board didn't list its files");
  const got = have as { hashes: Record<string, string | null>; files: string[] };

  const stale = m.files.filter((f) => f.name.endsWith(".py")).map((f) => f.name.replace(/\.py$/, ".mpy"))
    .filter((n) => got.files.includes(n) && !m.files.some((f) => f.name === n));
  if (stale.length) await r.exec(`import os\nfor n in ${JSON.stringify(stale)}:\n    os.remove(n)`);

  const todo = m.files.filter((f) => got.hashes[f.name] !== f.sha256)
    .sort((a, b) => (a.name === "main.py" ? 1 : b.name === "main.py" ? -1 : 0));
  const total = todo.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const f of todo) {
    onProgress(0.05 + 0.9 * (done / total), f.name);
    const buf = new Uint8Array(await (await fetch("/fw/" + f.name, { cache: "no-cache" })).arrayBuffer());
    const tmp = "_wedgie.tmp";
    await r.exec(`import binascii\n_f = open(${JSON.stringify(tmp)}, "wb")`);
    for (let i = 0; i < buf.length; i += 2048) {
      await r.exec(`_f.write(binascii.a2b_base64(${JSON.stringify(b64(buf.subarray(i, i + 2048)))}))`);
      onProgress(0.05 + 0.9 * ((done + Math.min(buf.length, i + 2048)) / total), f.name);
    }
    await r.exec("_f.close()");
    let check: string | null = null;
    r.onLine = (t, v) => { if (t === "sha") check = v; };
    await r.exec(`print("@sha", json.dumps(_h(${JSON.stringify(tmp)})))`, 20000); // _h from HASHES, still defined
    if (check !== f.sha256) throw new Error(`${f.name} didn't copy cleanly; try again`);
    await r.exec(`import os\ntry:\n    os.remove(${JSON.stringify(f.name)})\nexcept OSError:\n    pass\nos.rename(${JSON.stringify(tmp)}, ${JSON.stringify(f.name)})`);
    done += f.size;
  }
  await r.exec("import os\ntry:\n    os.sync()\nexcept AttributeError:\n    pass");
  onProgress(1, todo.length ? `${todo.length} files updated` : "already up to date");
  return { version: m.version, written: todo.length };
}
