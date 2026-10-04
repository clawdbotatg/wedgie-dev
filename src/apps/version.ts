// An app's version is its repo's commit: "4f7748d · Oct 4". A wedgie records only v (a hash of the app's
// files) in apps.json; the manifest's `known` (tools/fw.mjs) turns every v the shelf ever published back
// into its commit, so the page can say which version a wedgie has, and an update apart from a version
// wedgie.dev never had (one put on from GitHub, /code or wedgie.py). docs/APPS.md "Versions".
import type { Cart, Manifest } from "../serial/install";

export type Ver = { sha: string; at?: string };
const day = (at?: string) => (at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
/** "4f7748d · Oct 4" */
export const verText = (x: Ver) => [x.sha.slice(0, 7), day(x.at)].filter(Boolean).join(" · ");
export const verLink = (repo: string, x: Ver, esc: (s: string) => string) =>
  `<a href="https://github.com/${esc(repo)}/commit/${esc(x.sha)}" target="_blank" rel="noopener">${esc(verText(x))}</a>`;

/** What the wedgie has of app c, given the v in its apps.json: same (c itself), older/newer (another
 *  version wedgie.dev published), other (one wedgie.dev never had), or none (no v recorded). */
export function compare(m: Manifest, c: Cart, v: string | undefined): { is: "same" | "older" | "newer" | "other" | "none"; has?: Ver } {
  if (!v) return { is: "none" };
  if (v === c.v) return { is: "same", has: c.sha ? { sha: c.sha, at: c.at } : undefined };
  const k = m.known?.[v];
  if (!k || k.mod !== c.mod || !c.at) return { is: "other" };
  return { is: k.at > c.at ? "newer" : "older", has: k };
}

/** The newest commit on GitHub for a shelf repo, so the page can say wedgie.dev is behind it. GitHub
 *  allows 60 lookups an hour per visitor: one per repo per 10 minutes (sessionStorage), errors ignored. */
const heads = new Map<string, Promise<Ver | null>>();
export function githubHead(repo: string): Promise<Ver | null> {
  const k = "wedgie.head." + repo.toLowerCase();
  try {
    const c = JSON.parse(sessionStorage.getItem(k) || "null");
    if (c && Date.now() - c.t < 600000) return Promise.resolve(c.x);
  } catch {}
  let p = heads.get(k);
  if (!p) {
    p = fetch(`https://api.github.com/repos/${repo}/commits/HEAD`).then(async (r) => {
      if (!r.ok) return null;
      const j = await r.json();
      const x = { sha: j.sha as string, at: j.commit?.committer?.date as string };
      try { sessionStorage.setItem(k, JSON.stringify({ t: Date.now(), x })); } catch {}
      return x;
    }).catch(() => null);
    heads.set(k, p);
  }
  return p;
}
