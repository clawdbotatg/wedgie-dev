// Publishes firmware/ to public/fw/ with a manifest the site (installer, virtual wedgie) and agents
// read: { version, files: [{ name, size, sha256 }], apps }. Run by vite at dev start and build.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export function buildFirmware() {
  const src = join(root, "firmware"), out = join(root, "public/fw");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const files = [];
  for (const name of readdirSync(src).sort()) {
    const p = join(src, name);
    if (!statSync(p).isFile() || name.startsWith(".") || !/\.(py|bin|json|mpy)$/.test(name)) continue;
    const buf = readFileSync(p);
    copyFileSync(p, join(out, name));
    files.push({ name, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  const apps = JSON.parse(readFileSync(join(src, "apps.json"), "utf8"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ version, files, apps }, null, 1));
  copyFileSync(join(root, "LORE.md"), join(root, "public/lore.md")); // served at wedgie.dev/lore.md
  return { version, count: files.length };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(buildFirmware());
