// The littlefs image of a wedgie: the core firmware, one app's files and its apps.json (what an
// install from wedgie.dev leaves on the flash). Built with tools/rp2040/mkfs.py (littlefs-python, via uv).
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
/** A firmware folder (default: firmware/ in this tree): its files, core and carts. */
export function firmware(fw = join(here, "..", "..", "firmware")) {
  const carts = JSON.parse(readFileSync(join(fw, "carts.json"), "utf8"));
  const published = (n) => statSync(join(fw, n)).isFile() && /\.(py|bin|json|mpy)$/.test(n) && !n.startsWith(".") && n !== "carts.json" && n !== "apps.json";
  const all = readdirSync(fw).filter(published).sort();
  const claimed = new Set(carts.flatMap((c) => c.files));
  return { dir: fw, carts, all, core: all.filter((n) => !claimed.has(n)), file: (n) => readFileSync(join(fw, n)) };
}
/** the v in apps.json (fw.mjs cartV: the hash of the cart's files) */
export function cartV(F, c) {
  const h = createHash("sha256");
  for (const n of c.files) h.update(n + "\0" + createHash("sha256").update(F.file(n)).digest("hex") + "\n");
  return h.digest("hex").slice(0, 12);
}
export const appEntry = (F, c) => ({ mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), v: cartV(F, c) });

/** bytes of a littlefs image with F's core + app (a cart's mod, or null for none). over: {name: bytes}
 *  replaces files (a test key in wedgie.py). */
export function image(F, app, over = {}) {
  const c = F.carts.find((x) => x.mod === app);
  const dir = mkdtempSync(join(tmpdir(), "wedgie-fs-"));
  const args = [...F.core, ...(c ? c.files : [])].map((n) => {
    if (!over[n]) return `${n}=${join(F.dir, n)}`;
    writeFileSync(join(dir, n), over[n]);
    return `${n}=${join(dir, n)}`;
  });
  if (c) {
    writeFileSync(join(dir, "apps.json"), JSON.stringify([appEntry(F, c)]));
    args.push(`apps.json=${join(dir, "apps.json")}`);
  }
  const out = join(dir, "fs.img");
  execFileSync("uv", ["run", "-q", "--with", "littlefs-python", "python3", join(here, "mkfs.py"), out, ...args], { stdio: "inherit" });
  return readFileSync(out);
}
