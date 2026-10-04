// Apps from a GitHub repo someone adds themselves (their wedgie's page, or /code's try-it): its
// wedgie.json and files, fetched straight from GitHub at one commit, checked with the same rules the
// build uses for the reviewed shelf (appjson.mjs). They are carts with `unreviewed`, and their files
// carry the raw.githubusercontent URL install.ts fetches them from. This browser remembers the repos it
// added (localStorage); nobody else sees them. The shelf everyone sees is community.json.
import { checkAppJson, parseRepo, MAX_APP_BYTES } from "./appjson.mjs";
import { cartV, type Cart, type FileInfo, type Manifest } from "../serial/install";

export type Repo = { repo: string; sha: string; carts: Cart[]; files: FileInfo[]; data: Record<string, Uint8Array> };

const KEY = "wedgie.repos";
export function savedRepos(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function store(list: string[]) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private window: this visit only */ } }
export function saveRepo(repo: string) { store([...savedRepos().filter((r) => r.toLowerCase() !== repo.toLowerCase()), repo]); }
export function forgetRepo(repo: string) { store(savedRepos().filter((r) => r.toLowerCase() !== repo.toLowerCase())); }

async function sha256(u8: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", u8 as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, Promise<Repo>>();
/** Fetch and check a repo's apps. Same spec, same visit: the same answer (drop it with reload=true). */
export function loadRepo(spec: string, m: Manifest, reload = false): Promise<Repo> {
  const k = spec.trim().toLowerCase();
  if (reload) cache.delete(k);
  let p = cache.get(k);
  if (!p) { p = fetchRepo(spec, m); cache.set(k, p); p.catch(() => cache.delete(k)); }
  return p;
}

async function fetchRepo(spec: string, m: Manifest): Promise<Repo> {
  const p = parseRepo(spec);
  if (!p) throw new Error(`"${spec}" isn't a GitHub repo: write it as owner/name`);
  const repo = `${p.owner}/${p.repo}`;
  // The commit it's at now, so every file comes from the same one. GitHub's API allows 60 lookups an
  // hour per visitor; past that, the branch name itself (raw.githubusercontent takes either).
  let sha = p.ref || "HEAD", at: string | undefined;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}`);
    if (r.status === 404) throw new Error(`GitHub has no public repo ${repo}${p.ref ? ` with ${p.ref}` : ""}`);
    if (r.ok) { const j = await r.json(); sha = j.sha; at = j.commit?.committer?.date; }
  } catch (e: any) { if (/no public repo/.test(e?.message)) throw e; }
  const base = `https://raw.githubusercontent.com/${repo}/${sha}/`;
  const jr = await fetch(base + "wedgie.json", { cache: "no-cache" });
  if (!jr.ok) throw new Error(jr.status === 404 ? `${repo} has no wedgie.json at its top (see wedgie.dev/code)` : `couldn't read ${repo}'s wedgie.json (${jr.status})`);
  let j: unknown;
  try { j = await jr.json(); } catch { throw new Error(`${repo}'s wedgie.json isn't valid JSON`); }
  // Its mods may not take a name from the shelf, except the shelf's own copy of this same repo.
  const taken = m.carts.filter((c) => (c.repo || "").toLowerCase() !== repo.toLowerCase()).map((c) => c.mod);
  const { apps, errors } = checkAppJson(j, m.core, taken);
  if (errors.length) throw new Error(`${repo}'s wedgie.json: ${errors.join("; ")}`);
  const files: FileInfo[] = [], data: Record<string, Uint8Array> = {}, carts: Cart[] = [];
  for (const { paths, ...a } of apps) {
    const hashes: string[] = [];
    let size = 0;
    for (let i = 0; i < a.files.length; i++) {
      const url = base + paths[i];
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${repo}: ${paths[i]} isn't there (${r.status})`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const f = { name: a.files[i], size: buf.length, sha256: await sha256(buf), url };
      files.push(f); data[f.name] = buf; hashes.push(f.sha256); size += buf.length;
    }
    if (size > MAX_APP_BYTES) throw new Error(`${repo}: ${a.mod} is ${Math.round(size / 1024)} KB; an app can be ${MAX_APP_BYTES / 1024} KB`);
    carts.push({ ...a, v: await cartV(hashes), size, repo, sha, at, unreviewed: true });
  }
  return { repo, sha, carts, files, data };
}

/** The manifest with these repos' apps on the shelf too (a repo's own app replaces the shelf's copy of it). */
export function withRepos(m: Manifest, repos: Repo[]): Manifest {
  const carts = repos.flatMap((r) => r.carts), files = repos.flatMap((r) => r.files);
  const mods = new Set(carts.map((c) => c.mod)), names = new Set(files.map((f) => f.name));
  return { ...m, carts: [...m.carts.filter((c) => !mods.has(c.mod)), ...carts], files: [...m.files.filter((f) => !names.has(f.name)), ...files] };
}
