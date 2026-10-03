// The text a release signature covers (tools/sign.mjs) and a wedgie checks (wedgie.release_ok):
//   wedgie-release 1
//   version 0.2.9
//   <sha256>  <name>        one line per file tools/fw.mjs publishes, sorted by name
//   @app  <json>            one per app in firmware/carts.json (0.3.12+): mod, name, entry, usb, files. A checked job's apps.json is built from these (firmware/job.py check),
//                           and it may write only the core and its app's files. Older firmware reads the
//                           line as a file named by the JSON, which nothing ever writes.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The files wedgie.dev publishes from firmware/ (tools/fw.mjs uses this too). A .py with a compiled
 *  .mpy beside it (tools/mpy.py) is that file's source: the .mpy goes out, not it. */
export const published = (name, p) => statSync(p).isFile() && !name.startsWith(".") && /\.(py|bin|json|mpy)$/.test(name) && name !== "carts.json" && name !== "apps.json"
  && !(name.endsWith(".py") && existsSync(p.replace(/\.py$/, ".mpy")));

export function releaseText() {
  const src = join(root, "firmware");
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  let t = `wedgie-release 1\nversion ${version}\n`;
  for (const name of readdirSync(src).sort()) {
    const p = join(src, name);
    if (!published(name, p)) continue;
    t += `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${name}\n`;
  }
  return t + appLines(JSON.parse(readFileSync(join(src, "carts.json"), "utf8")));
}

/** The "@app" lines for carts (firmware/carts.json entries). No double space can occur in them. Short:
 *  the whole list rides one USB line to the wedgie (6 KB, wedgie.lines). */
export function appLines(carts) {
  return [...carts].sort((a, b) => (a.mod < b.mod ? -1 : 1)).map((c) => "@app  " + JSON.stringify({
    mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), files: c.files,
  }) + "\n").join("");
}
