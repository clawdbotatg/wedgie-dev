// Publishes firmware/ to public/fw/ with a manifest the site (installer, virtual wedgie) and agents
// read. Run by vite at dev start and build.
//   { version, files: [{ name, size, sha256 }], core: [names], carts: [cart] }
// core = the firmware proper (boot logo, WEDGIE drive, the slot that runs the app, saves, screen/button and chip drivers);
// every other file belongs to one or more cartridges (firmware/carts.json: what each app needs; chip:
// the secure chip it needs, if any, which the site checks against the wedgie's).
// A cart's v is a hash of its files' hashes: the site compares it with the v a wedgie recorded in its
// apps.json when that cart went on, so there is no version number to forget to bump. A file two carts
// share (p256.py) goes on once. apps.json is the wedgie's own list of what it has; it isn't published.
// Then the community shelf: each repo in community.json, as copied into community/ by tools/community.mjs
// at its reviewed commit; its carts carry repo + sha + at (the commit's date): an app's version is its
// commit. `known` maps every v the shelf ever published (community.json's `past` too) to { mod, repo, sha,
// at }, so the site can name the version a wedgie has and tell an update from a version it never had.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { published, releaseText, shelf } from "./release.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
/** A cart's version: the same function as cartV in src/serial/install.ts. */
export const cartV = (hashes) => sha(hashes.join("\n")).slice(0, 12);

export function buildFirmware() {
  const src = join(root, "firmware"), out = join(root, "public/fw");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const name of readdirSync(src).sort()) {
    const p = join(src, name);
    if (!published(name, p)) continue;
    const buf = readFileSync(p);
    copyFileSync(p, join(out, name));
    files.push({ name, size: buf.length, sha256: sha(buf) });
    // a compiled app file's source, for the browser emulator only (src/emu/flash.ts): not in the
    // manifest or the signed list, and no wedgie gets it
    if (name.endsWith(".mpy") && existsSync(p.replace(/\.mpy$/, ".py"))) {
      mkdirSync(join(out, "src"), { recursive: true });
      copyFileSync(p.replace(/\.mpy$/, ".py"), join(out, "src", name.replace(/\.mpy$/, ".py")));
    }
  }
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  const byName = new Map(files.map((f) => [f.name, f]));
  const carts = JSON.parse(readFileSync(join(src, "carts.json"), "utf8")).map((c) => {
    for (const n of c.files) if (!byName.has(n)) throw new Error(`carts.json: ${c.mod} needs ${n}, which isn't in firmware/`);
    return { ...c, v: cartV(c.files.map((n) => byName.get(n).sha256)), size: c.files.reduce((s, n) => s + byName.get(n).size, 0) };
  });
  const inCarts = new Set(carts.flatMap((c) => c.files));
  const core = files.map((f) => f.name).filter((n) => !inCarts.has(n));
  const shelfCarts = [];
  for (const { app: a, files: fs } of shelf(core, carts.map((c) => c.mod))) {
    const hashes = [];
    for (const { name, buf } of fs) {
      if (byName.has(name)) throw new Error(`community/${a.repo}: ${name} is already published by another app`);
      writeFileSync(join(out, name), buf);
      const f = { name, size: buf.length, sha256: sha(buf) };
      files.push(f); byName.set(name, f); hashes.push(f.sha256);
    }
    shelfCarts.push({ ...a, v: cartV(hashes), size: a.files.reduce((s, n) => s + byName.get(n).size, 0) });
  }
  carts.unshift(...shelfCarts);        // the shelf's apps first on the site
  const known = {};
  for (const e of JSON.parse(readFileSync(join(root, "community.json"), "utf8")).repos)
    for (const x of [e, ...(e.past || [])]) for (const [mod, v] of Object.entries(x.v || {})) known[v] = { mod, repo: e.repo, sha: x.sha, at: x.at };
  // The signed file list (tools/sign.mjs). signed: it covers exactly these files; a wedgie refuses a
  // checked install from an unsigned manifest.
  let signed = false;
  try {
    const txt = readFileSync(join(root, "release/firmware.txt"), "utf8");
    copyFileSync(join(root, "release/firmware.txt"), join(out, "release.txt"));
    copyFileSync(join(root, "release/firmware.sig"), join(out, "release.sig"));
    signed = txt === releaseText();
    if (!signed) console.warn("fw: release/firmware.txt is out of date: run node tools/sign.mjs");
  } catch {}
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ version, files, core, carts, known, signed }, null, 1));
  copyFileSync(join(root, "LORE.md"), join(root, "public/lore.md")); // served at wedgie.dev/lore.md
  return { version, core: core.length, carts: carts.length };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(buildFirmware());
