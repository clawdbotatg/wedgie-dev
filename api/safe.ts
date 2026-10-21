// /api/safe?u=<path>: /safe's calls to Safe's Transaction Service (api.safe.global/tx-service/<path>), with our key
// (SAFE_API_KEY, developer.safe.global: 50K a month, 5 a second). Without a key Safe allows 5,000 a month per IP,
// and one person's page used that up (10-21). GET = a read, kept a little while warm; POST = a proposal or a
// signature, passed on as is. Never log a body here.
import { env, oops, crossSite } from "./_shop.js";

const BASE = "https://api.safe.global/tx-service/";
// <chain>/api/v1/<safes|owners|multisig-transactions>/..., nothing else
const PATH = /^[a-z0-9-]+\/api\/v1\/(safes|owners|multisig-transactions)\/[\w\-./?=&,]*$/;
// how long a read is kept: a Safe's list of Safes and its creation change rarely; the queue and history often
const KEEP = (p: string) => /\/creation\/$/.test(p) ? 86_400_000 : /^[^/]+\/api\/v1\/owners\//.test(p) ? 120_000 : 10_000;
const HIT = new Map<string, { at: number; status: number; body: string }>();

const pass = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const headers = () => ({ "Content-Type": "application/json", ...(env("SAFE_API_KEY") ? { Authorization: `Bearer ${env("SAFE_API_KEY")}` } : {}) });
const path = (req: Request) => { const u = new URL(req.url).searchParams.get("u") || ""; return PATH.test(u) && !u.includes("..") ? u : ""; };

export async function GET(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const p = path(req);
  if (!p) return oops("Not allowed.", 403);
  const hit = HIT.get(p);
  if (hit && Date.now() - hit.at < KEEP(p)) return pass(hit.status, hit.body);
  const r = await fetch(BASE + p, { headers: headers(), signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  const body = await r.text();
  if (r.ok || r.status === 404) {
    if (HIT.size > 2000) HIT.clear();
    HIT.set(p, { at: Date.now(), status: r.status, body });
  }
  return pass(r.status, body);
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const p = path(req);
  if (!p || !/\/(multisig-transactions|confirmations)\/$/.test(p)) return oops("Not allowed.", 403);
  const text = await req.text();
  if (text.length > 200_000) return oops("Too big.", 413);
  const r = await fetch(BASE + p, { method: "POST", headers: headers(), body: text, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  // a new proposal or signature: the queue's next read must see it
  const safe = p.match(/safes\/(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase();
  for (const k of HIT.keys()) if (k.includes("multisig-transactions") && (!safe || k.toLowerCase().includes(safe))) HIT.delete(k);
  return pass(r.status, await r.text());
}
