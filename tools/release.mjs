// The text a release signature covers (tools/sign.mjs) and a wedgie checks (wedgie.release_ok):
//   wedgie-release 1
//   version 0.2.9
//   <sha256>  <name>        one line per file tools/fw.mjs publishes, sorted by name
//   @app  <json>            one per app in firmware/carts.json and per app on the shelf (community.json) (0.3.12+): mod, name, entry, usb, files. A checked job's apps.json is built from these (firmware/job.py check),
//                           and it may write only the core and its app's files. Older firmware reads the
//                           line as a file named by the JSON, which nothing ever writes.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppJson, parseRepo } from "../src/apps/appjson.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The files wedgie.dev publishes from firmware/ (tools/fw.mjs uses this too). A .py with a compiled
 *  .mpy beside it (tools/mpy.py) is that file's source: the .mpy goes out, not it. */
export const published = (name, p) => statSync(p).isFile() && !name.startsWith(".") && /\.(py|bin|json|mpy)$/.test(name) && name !== "carts.json" && name !== "apps.json"
  && !(name.endsWith(".py") && existsSync(p.replace(/\.py$/, ".mpy")));

export function releaseText() {
  const src = join(root, "firmware");
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  const lines = [];
  for (const name of readdirSync(src).sort()) {
    const p = join(src, name);
    if (!published(name, p)) continue;
    lines.push(`${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${name}\n`);
  }
  const carts = JSON.parse(readFileSync(join(src, "carts.json"), "utf8"));
  for (const { app, files } of shelf(firmwareNames(), carts.map((c) => c.mod))) {
    for (const f of files) lines.push(`${createHash("sha256").update(f.buf).digest("hex")}  ${f.name}\n`);
    carts.push(app);
  }
  return `wedgie-release 1\nversion ${version}\n` + lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join("") + appLines(carts);
}

/** The core: published firmware files no firmware cart claims. */
export function firmwareNames() {
  const src = join(root, "firmware");
  const claimed = new Set(JSON.parse(readFileSync(join(src, "carts.json"), "utf8")).flatMap((c) => c.files));
  return readdirSync(src).filter((n) => published(n, join(src, n)) && !claimed.has(n));
}

/** The shelf: each repo in community.json as copied into community/ at its reviewed commit
 *  (tools/community.mjs). [{ app (its wedgie.json entry + repo, sha), files: [{ name, buf }] }]. */
export function shelf(core, mods) {
  const out = [];
  for (const e of JSON.parse(readFileSync(join(root, "community.json"), "utf8")).repos) {
    const p = parseRepo(e.repo), dir = join(root, "community", p.owner, p.repo);
    let have = "";
    try { have = readFileSync(join(dir, ".sha"), "utf8").trim(); } catch {}
    if (have !== e.sha) throw new Error(`community/${e.repo} isn't at ${e.sha.slice(0, 7)}: run node tools/community.mjs`);
    const { apps, errors } = checkAppJson(JSON.parse(readFileSync(join(dir, "wedgie.json"), "utf8")), core, mods);
    if (errors.length) throw new Error(`community/${e.repo}/wedgie.json:\n  ${errors.join("\n  ")}`);
    for (const { paths, ...a } of apps.filter((a) => !e.apps || e.apps.includes(a.mod)))
      out.push({ app: { ...a, repo: e.repo, sha: e.sha }, files: a.files.map((name, i) => ({ name, buf: readFileSync(join(dir, paths[i])) })) });
  }
  return out;
}

/** The "@app" lines for carts (firmware/carts.json entries). No double space can occur in them. Short:
 *  the whole list rides one USB line to the wedgie (6 KB, wedgie.lines). */
export function appLines(carts) {
  return [...carts].sort((a, b) => (a.mod < b.mod ? -1 : 1)).map((c) => "@app  " + JSON.stringify({
    mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), files: c.files,
  }) + "\n").join("");
}
