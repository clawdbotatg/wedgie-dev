// wedgie.json: how a GitHub repo says which wedgie apps it holds. One copy of the rules, used by the
// build (tools/fw.mjs, for the reviewed repos in community.json) and by the site (src/apps/repos.ts, for
// a repo someone adds on their wedgie's page). wedgie.dev/code.md is the spec agents read: keep it true.
//
//   { "apps": [ { "mod": "snake", "name": "Snake", "about": "...", "files": ["snake/snake.py", ...],
//                 "entry"?: "run", "chip"?: "ATECC608", "usb"?: true, "fw"?: "0.2.3", "label"?: "#22c452", "icon"?: [12 x 12] } ] }
//
// A wedgie's flash has no folders for apps: every file goes to its root under its own name. So every file
// name starts with the app's mod (snake.py, snake_tiles.bin): two apps can't collide, and no app can
// replace a firmware file.

export const MAX_APPS = 20;
export const MAX_FILES = 30;
export const MAX_APP_BYTES = 256 * 1024;
export const CHIPS = ["ATECC608", "OPTIGA Trust M"];
const MOD = /^[a-z][a-z0-9_]{1,19}$/;
const FILE = /^[a-z][a-z0-9_]*\.(py|mpy|bin|json|txt)$/;
const ICON_CH = /^[kwgrybs.]{12}$/;
export const DEFAULT_ICON = ["............", ".kkkkkkkkkk.", ".k........k.", ".k.k....k.k.", ".k........k.", ".k........k.",
  ".k.k....k.k.", ".k..kkkk..k.", ".k........k.", ".kkkkkkkkkk.", "............", "............"];

/**
 * Check a parsed wedgie.json. core: the firmware's file names (manifest.core); taken: app mods that
 * already exist (the catalog). Returns { apps, errors }: apps are carts without v/size (the caller adds
 * those once it has the files), plus `paths` (repo path per file, same order as files).
 */
export function checkAppJson(j, core = [], taken = []) {
  const errors = [];
  const apps = [];
  const coreMods = new Set(core.map((n) => n.replace(/\.(py|mpy)$/, "")));
  const coreFiles = new Set(core);
  if (!j || typeof j !== "object" || !Array.isArray(j.apps)) return { apps, errors: ["wedgie.json needs an \"apps\" list"] };
  if (!j.apps.length) errors.push("\"apps\" is empty");
  if (j.apps.length > MAX_APPS) errors.push(`at most ${MAX_APPS} apps in one repo`);
  const seen = new Set();
  j.apps.slice(0, MAX_APPS).forEach((a, i) => {
    const at = `apps[${i}]${a && typeof a.mod === "string" ? ` (${a.mod})` : ""}`;
    const bad = (s) => errors.push(`${at}: ${s}`);
    if (!a || typeof a !== "object") return bad("not an object");
    if (typeof a.mod !== "string" || !MOD.test(a.mod)) return bad("mod: 2-20 of a-z 0-9 _, starting with a letter (it's the Python module name)");
    if (coreMods.has(a.mod)) return bad(`mod "${a.mod}" is a firmware module; pick another name`);
    if (taken.includes(a.mod)) return bad(`mod "${a.mod}" is taken by an app on wedgie.dev; pick another name`);
    if (seen.has(a.mod)) return bad("mod used twice in this repo");
    seen.add(a.mod);
    if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 14) bad("name: 1-14 characters (it's printed on the cartridge)");
    if (a.about !== undefined && (typeof a.about !== "string" || a.about.length > 140)) bad("about: one line, up to 140 characters");
    if (!Array.isArray(a.files) || !a.files.length || a.files.length > MAX_FILES) return bad(`files: a list of 1-${MAX_FILES} paths in the repo`);
    const names = [];
    for (const p of a.files) {
      if (typeof p !== "string" || p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "." || !s)) { bad(`files: "${p}" isn't a plain path in the repo`); continue; }
      const n = p.split("/").pop();
      if (!FILE.test(n)) { bad(`files: "${n}": lowercase a-z 0-9 _, ending .py .mpy .bin .json or .txt`); continue; }
      const stem = n.replace(/\.[a-z]+$/, "");
      if (stem !== a.mod && !stem.startsWith(a.mod + "_")) { bad(`files: "${n}" must be named ${a.mod}.py or start with ${a.mod}_ (every file lands in the flash's root)`); continue; }
      if (coreFiles.has(n)) { bad(`files: "${n}" is a firmware file`); continue; }
      if (names.includes(n)) { bad(`files: "${n}" twice`); continue; }
      names.push(n);
    }
    if (!names.includes(a.mod + ".py") && !names.includes(a.mod + ".mpy")) bad(`files: needs ${a.mod}.py (the module the wedgie imports)`);
    if (a.entry !== undefined && (typeof a.entry !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(a.entry))) bad("entry: the name of a function in the module");
    if (a.usb !== undefined && typeof a.usb !== "boolean") bad("usb: true or leave it out");
    if (a.chip !== undefined && !CHIPS.includes(a.chip)) bad(`chip: ${CHIPS.map((c) => `"${c}"`).join(" or ")}, or leave it out`);
    if (a.fw !== undefined && (typeof a.fw !== "string" || !/^\d+\.\d+\.\d+$/.test(a.fw))) bad("fw: the oldest wedgie firmware it runs on, like \"0.2.3\"");
    if (a.label !== undefined && (typeof a.label !== "string" || !/^#[0-9a-f]{6}$/i.test(a.label))) bad("label: a color like \"#22c452\"");
    if (a.icon !== undefined && (!Array.isArray(a.icon) || a.icon.length !== 12 || !a.icon.every((r) => typeof r === "string" && ICON_CH.test(r))))
      bad("icon: 12 strings of 12 characters from . k w g r y b s");
    if (errors.some((e) => e.startsWith(at + ":"))) return;
    apps.push({
      mod: a.mod, name: a.name.trim(), about: a.about || "", files: names, paths: a.files.slice(),
      ...(a.entry ? { entry: a.entry } : {}), ...(a.usb ? { usb: true } : {}), ...(a.chip ? { chip: a.chip } : {}), ...(a.fw ? { fw: a.fw } : {}),
      label: a.label || "#8a8c8e", icon: a.icon || DEFAULT_ICON,
    });
  });
  return { apps, errors };
}

/** -1, 0 or 1: firmware version a against b ("0.2.10" > "0.2.9"). */
export function cmpVersion(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

/** "owner/repo", "owner/repo@ref", or a github.com URL (…/tree/<ref>) -> { owner, repo, ref? }, or null. */
export function parseRepo(s) {
  s = String(s || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?$/i);
  if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/);
  if (!m || m[1].startsWith(".") || m[2].startsWith(".")) return null;
  return { owner: m[1], repo: m[2], ...(m[3] ? { ref: m[3] } : {}) };
}
