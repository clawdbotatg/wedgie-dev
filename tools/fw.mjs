// Publishes firmware/ to public/fw/ with a manifest the site (installer, virtual wedgie) and agents
// read. Run by vite at dev start and build.
//   { version, files: [{ name, size, sha256 }], core: [names], carts: [cart] }
// core = the firmware proper (boot logo, WEDGIE drive, the slot that runs the app, saves, screen/button and chip drivers);
// every other file belongs to one or more cartridges (firmware/carts.json: what each app needs).
// A cart's v is a hash of its files' hashes: the site compares it with the v a wedgie recorded in its
// apps.json when that cart went on, so there is no version number to forget to bump. A file two carts
// share (p256.py) goes on once. apps.json is the wedgie's own list of what it has; it isn't published.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    if (!statSync(p).isFile() || name.startsWith(".") || !/\.(py|bin|json|mpy)$/.test(name) || name === "carts.json" || name === "apps.json") continue;
    const buf = readFileSync(p);
    copyFileSync(p, join(out, name));
    files.push({ name, size: buf.length, sha256: sha(buf) });
  }
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  const byName = new Map(files.map((f) => [f.name, f]));
  const carts = JSON.parse(readFileSync(join(src, "carts.json"), "utf8")).map((c) => {
    for (const n of c.files) if (!byName.has(n)) throw new Error(`carts.json: ${c.mod} needs ${n}, which isn't in firmware/`);
    return { ...c, v: cartV(c.files.map((n) => byName.get(n).sha256)), size: c.files.reduce((s, n) => s + byName.get(n).size, 0) };
  });
  const inCarts = new Set(carts.flatMap((c) => c.files));
  const core = files.map((f) => f.name).filter((n) => !inCarts.has(n));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ version, files, core, carts }, null, 1));
  copyFileSync(join(root, "LORE.md"), join(root, "public/lore.md")); // served at wedgie.dev/lore.md
  return { version, core: core.length, carts: carts.length };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(buildFirmware());
