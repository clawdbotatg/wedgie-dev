// The text a release signature covers (tools/sign.mjs) and a wedgie checks (wedgie.release_ok):
//   wedgie-release 1
//   version 0.2.9
//   <sha256>  <name>        one line per core file (firmwareNames), sorted by name
//   @apps  <sha256>         (0.3.66+) the hash of the app list, appsText() (release/apps.txt, /fw/apps.txt):
//                           the apps are out of this list. All of it rides one USB line to a wedgie's job (6 KB,
//                           wedgie.lines), and on 0.3.65 it was 176 bytes short of that. Firmware before 0.3.66
//                           sees no apps in it: it gets the firmware update, then installs apps.
//   @serial  <n>            (0.3.54+) one more at every signing (tools/sign.mjs): a wedgie keeps the highest it
//                           installed and refuses a list with a lower one, so a same-version re-signing can't be
//                           rolled back (audit 10-18: 0.3.52 was signed 7 times). releaseText() alone keeps the signed one.
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

/** The "@serial" of the signed list on disk (0: none yet). */
export function signedSerial() {
  try { return Number((readFileSync(join(root, "release/firmware.txt"), "utf8").match(/^@serial  (\d+)$/m) || [])[1] || 0); }
  catch { return 0; }
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function releaseText(serial = signedSerial()) {
  const src = join(root, "firmware");
  const version = (readFileSync(join(src, "wedgie.py"), "utf8").match(/VERSION = "([^"]+)"/) || [])[1] || "0";
  const lines = firmwareNames().sort().map((name) => `${sha(readFileSync(join(src, name)))}  ${name}\n`);
  return `wedgie-release 1\nversion ${version}\n` + lines.join("") + `@apps  ${sha(appsText())}\n` +
    (serial ? `@serial  ${serial}\n` : "");
}

/** The app list (0.3.66+): per app, sorted by mod, its "@app  <json>" line (mod, name, entry, usb, files: a checked
 *  job's apps.json is built from it, firmware/job.py check; it may write only the core and its app's files), then
 *  a "<sha256>  <name>" line per file. Every app in firmware/carts.json and on the shelf (community.json). A wedgie
 *  takes it in pieces (job.Apps) and keeps only the apps its job is about: it has no size limit. */
export function appsText() {
  const src = join(root, "firmware");
  const carts = JSON.parse(readFileSync(join(src, "carts.json"), "utf8"));
  const apps = carts.map((c) => ({ app: c, files: c.files.map((name) => ({ name, buf: readFileSync(join(src, name)) })) }));
  apps.push(...shelf(firmwareNames(), carts.map((c) => c.mod)));
  return apps.sort((a, b) => (a.app.mod < b.app.mod ? -1 : 1))
    .map(({ app, files }) => appLines([app]) + files.map((f) => `${sha(f.buf)}  ${f.name}\n`).join("")).join("");
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
      out.push({ app: { ...a, repo: e.repo, sha: e.sha, ...(e.at ? { at: e.at } : {}) }, files: a.files.map((name, i) => ({ name, buf: readFileSync(join(dir, paths[i])) })) });
  }
  return out;
}

/** The "@app" lines for carts (firmware/carts.json entries). No double space can occur in them. */
export function appLines(carts) {
  return [...carts].sort((a, b) => (a.mod < b.mod ? -1 : 1)).map((c) => "@app  " + JSON.stringify({
    mod: c.mod, name: c.name, ...(c.entry ? { entry: c.entry } : {}), ...(c.usb ? { usb: true } : {}), files: c.files,
  }) + "\n").join("");
}
