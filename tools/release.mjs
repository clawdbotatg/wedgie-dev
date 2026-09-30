// The text a release signature covers (tools/sign.mjs) and a wedgie checks (wedgie.release_ok):
//   wedgie-release 1
//   version 0.2.9
//   <sha256>  <name>        one line per file tools/fw.mjs publishes, sorted by name
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The files wedgie.dev publishes from firmware/ (tools/fw.mjs uses this too). */
export const published = (name, p) => statSync(p).isFile() && !name.startsWith(".") && /\.(py|bin|json|mpy)$/.test(name) && name !== "carts.json" && name !== "apps.json";

export function releaseText() {
  const src = join(root, "firmware");
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  let t = `wedgie-release 1\nversion ${version}\n`;
  for (const name of readdirSync(src).sort()) {
    const p = join(src, name);
    if (!published(name, p)) continue;
    t += `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${name}\n`;
  }
  return t;
}
