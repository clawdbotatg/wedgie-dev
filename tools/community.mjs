// The community shelf: apps from other people's GitHub repos that are on wedgie.dev for everyone.
// community.json lists each approved repo at the exact commit that was reviewed; this tool copies that
// commit's app files into community/<owner>/<repo>/ (committed here, so the review is a normal diff and
// the site never depends on GitHub at build time). tools/fw.mjs publishes them as carts next to the
// firmware's own. A new commit in their repo changes nothing here until someone approves it.
//
//   node tools/community.mjs                      make community/ match community.json
//   node tools/community.mjs add owner/repo[@ref] fetch its current commit, check wedgie.json, list it
//   node tools/community.mjs status               each repo: the commit on wedgie.dev vs the newest on GitHub
//   node tools/community.mjs update [owner/repo]  add again every repo (or that one) GitHub has a newer commit of
//   node tools/community.mjs remove owner/repo
//
// An app's version is its repo's commit. Each entry keeps the commit (sha), its date (at) and each app's
// v (the file hash a wedgie records in apps.json), and every earlier one in `past`, newest first: the site
// turns the v a wedgie has back into "de6f066, Oct 3" and knows an update from a version it never had.
//
// Review before you commit: `git diff community/` is exactly the code that will run on people's wedgies.
// Then node tools/sign.mjs: the shelf's apps are in the signed list (tools/release.mjs shelf()). docs/APPS.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppJson, parseRepo, MAX_APP_BYTES } from "../src/apps/appjson.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIST = join(root, "community.json"), DIR = join(root, "community");

export function readList() {
  return existsSync(LIST) ? JSON.parse(readFileSync(LIST, "utf8")) : { repos: [] };
}

const gh = (url) => fetch(url, { headers: { "User-Agent": "wedgie.dev", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
/** A commit: { sha, at } (at: its committer date, ISO). */
async function resolve(owner, repo, ref = "HEAD") {
  const r = await gh(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!r.ok) throw new Error(`${owner}/${repo}@${ref}: GitHub says ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, at: j.commit.committer.date };
}
/** A cart's v: the same function as cartV in tools/fw.mjs and src/serial/install.ts. */
const cartV = (hashes) => createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 12);
async function raw(owner, repo, sha, path) {
  const r = await gh(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`);
  if (!r.ok) throw new Error(`${owner}/${repo}: ${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function firmwareCore() {
  const carts = JSON.parse(readFileSync(join(root, "firmware/carts.json"), "utf8"));
  const claimed = new Set(carts.flatMap((c) => c.files));
  return { core: readdirSync(join(root, "firmware")).filter((n) => /\.(py|bin|mpy)$/.test(n) && !claimed.has(n)), mods: carts.map((c) => c.mod) };
}

/** Copy one repo at one commit into community/<owner>/<repo>/. Returns its checked apps, each with its v. */
async function vendor(e) {
  const p = parseRepo(e.repo);
  if (!p || !/^[0-9a-f]{40}$/.test(e.sha || "")) throw new Error(`community.json: ${JSON.stringify(e)}: needs "repo": "owner/name" and a 40-hex "sha"`);
  const out = join(DIR, p.owner, p.repo);
  const j = JSON.parse(new TextDecoder().decode(await raw(p.owner, p.repo, e.sha, "wedgie.json")));
  const { core, mods } = firmwareCore();
  const { apps, errors } = checkAppJson(j, core, mods);
  if (errors.length) throw new Error(`${e.repo}@${e.sha.slice(0, 7)} wedgie.json:\n  ${errors.join("\n  ")}`);
  const use = apps.filter((a) => !e.apps || e.apps.includes(a.mod));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "wedgie.json"), JSON.stringify(j, null, 2) + "\n");
  for (const a of use) {
    let bytes = 0;
    const hashes = [];
    for (const path of a.paths) {
      const buf = await raw(p.owner, p.repo, e.sha, path);
      bytes += buf.length;
      hashes.push(createHash("sha256").update(buf).digest("hex"));
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), buf);
    }
    if (bytes > MAX_APP_BYTES) throw new Error(`${e.repo}: ${a.mod} is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_APP_BYTES / 1024} KB`);
    a.v = cartV(hashes);
    console.log(`  ${a.mod}: ${a.name}, ${a.files.length} files, ${Math.round(bytes / 1024)} KB, v ${a.v}`);
  }
  writeFileSync(join(out, ".sha"), e.sha + "\n");
  return use;
}

export async function sync() {
  const list = readList();
  const want = new Set();
  for (const e of list.repos) {
    const p = parseRepo(e.repo);
    want.add(`${p.owner}/${p.repo}`);
    const shaFile = join(DIR, p.owner, p.repo, ".sha");
    if (existsSync(shaFile) && readFileSync(shaFile, "utf8").trim() === e.sha) continue;
    console.log(`${e.repo} @ ${e.sha.slice(0, 7)}`);
    await vendor(e);
  }
  if (existsSync(DIR)) for (const o of readdirSync(DIR)) {
    for (const r of readdirSync(join(DIR, o))) if (!want.has(`${o}/${r}`)) { rmSync(join(DIR, o, r), { recursive: true }); console.log(`removed ${o}/${r}`); }
    if (!readdirSync(join(DIR, o)).length) rmSync(join(DIR, o), { recursive: true });
  }
}

/** Put repo at commit c on the shelf; the commit it replaces goes into `past`. */
async function add(list, repo, c) {
  const old = list.repos.find((e) => e.repo.toLowerCase() === repo.toLowerCase());
  const e = { repo, sha: c.sha, at: c.at, approved: new Date().toISOString().slice(0, 10) };
  if (old?.apps) e.apps = old.apps;
  console.log(`${repo} @ ${c.sha.slice(0, 7)} (${c.at.slice(0, 10)})`);
  e.v = Object.fromEntries((await vendor(e)).map((a) => [a.mod, a.v]));
  const past = old ? [...(old.sha !== c.sha && old.v ? [{ sha: old.sha, at: old.at, v: old.v }] : []), ...(old.past || [])] : [];
  if (past.length) e.past = past.filter((x) => x.sha !== c.sha);
  if (old) list.repos[list.repos.indexOf(old)] = e; else list.repos.push(e);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const list = readList();
  if (cmd === "add") {
    const p = parseRepo(arg);
    if (!p) throw new Error("usage: node tools/community.mjs add owner/repo[@ref]");
    await add(list, `${p.owner}/${p.repo}`, await resolve(p.owner, p.repo, p.ref));
  } else if (cmd === "status" || cmd === "update") {
    let n = 0;
    for (const e of [...list.repos]) {
      if (arg && e.repo.toLowerCase() !== arg.toLowerCase()) continue;
      const p = parseRepo(e.repo), head = await resolve(p.owner, p.repo);
      const behind = head.sha !== e.sha;
      console.log(`${e.repo.padEnd(30)} wedgie.dev ${e.sha.slice(0, 7)} (${(e.at || "?").slice(0, 10)})  ${behind ? `GitHub ${head.sha.slice(0, 7)} (${head.at.slice(0, 10)}): newer` : "= GitHub"}`);
      if (behind && cmd === "update") { await add(list, e.repo, head); n++; }
    }
    if (cmd === "status") return;
    if (!n) { console.log("\nall on GitHub's newest commit; nothing to do"); return; }
  } else if (cmd === "remove") {
    list.repos = list.repos.filter((e) => e.repo.toLowerCase() !== String(arg).toLowerCase());
  } else if (cmd) throw new Error("usage: node tools/community.mjs [status | update [owner/repo] | add owner/repo[@ref] | remove owner/repo]");
  writeFileSync(LIST, JSON.stringify(list, null, 2) + "\n");
  await sync();
  if (cmd === "add" || cmd === "update") console.log(`\nReview it: git diff community/ (that's the code that will run on people's wedgies), then node tools/sign.mjs, then commit and push.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
