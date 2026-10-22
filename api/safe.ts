// /api/safe?u=<path>: /safe's calls to Safe's Transaction Service (api.safe.global/tx-service/<path>), with our key
// (SAFE_API_KEY, developer.safe.global, Austin's ethereum.org Google). The free plan: 50K a month, 5 a second; the
// next is €199 a month. Without a key Safe allows 5,000 a month per IP, and one person's page used that up (10-21).
// So it's spent carefully:
//   - a daily cap (DAY_CAP, under 50K/30) and a per-IP one (IP_CAP): past either, 429 and the page carries on
//     from the chain and Instant Wallet's queue
//   - answers kept: in memory while warm, and the slow-changing ones (a person's Safes, a Safe's creation) in the
//     database for everyone. &fresh=1 (the page's Refresh) asks Safe again
//   - GET ?usage=1: today's count and the last 7 days
// GET = a read; POST = a proposal or a signature, passed on as is (counted, never capped). Never log a body here.
import { env, json, oops, crossSite, db, ipOf } from "./_shop.js";

const BASE = "https://api.safe.global/tx-service/";
const DAY_CAP = 1500, IP_CAP = 300;
// <chain>/api/v1/<safes|owners|multisig-transactions>/..., nothing else
const PATH = /^[a-z0-9-]+\/api\/v1\/(safes|owners|multisig-transactions)\/[\w\-./?=&,]*$/;
// how long an answer is kept: a person's Safes a day (Refresh asks again), a Safe's creation for good, the rest briefly
const KEEP = (p: string) => /\/creation\/$/.test(p) ? 365 * 86_400_000 : /^[^/]+\/api\/v1\/owners\//.test(p) ? 86_400_000
  : /all-transactions/.test(p) ? 60_000 : 15_000;
const SHARED = (p: string) => KEEP(p) >= 86_400_000;   // kept in the database too
const HIT = new Map<string, { at: number; status: number; body: string }>();

const pass = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const headers = () => ({ "Content-Type": "application/json", ...(env("SAFE_API_KEY") ? { Authorization: `Bearer ${env("SAFE_API_KEY")}` } : {}) });
const path = (req: Request) => { const u = new URL(req.url).searchParams.get("u") || ""; return PATH.test(u) && !u.includes("..") ? u : ""; };
const today = () => new Date().toISOString().slice(0, 10);

/** One more call to Safe: false when today's share (ours, or this IP's) is used. The database down: allowed. */
async function spend(req: Request, capped: boolean) {
  if (!env("SHOP_DATABASE_URL")) return true;
  try {
    const sql = await db(), ip = await ipOf(req), d = today();
    const rows = await sql`insert into counts (day, k, n) values (${d}, 'safe_api', 1), (${d}, ${"safe_ip:" + ip}, 1)
      on conflict (day, k) do update set n = counts.n + 1 returning k, n`;
    if (Math.random() < 0.01) await sql`delete from counts where k like 'safe_ip:%' and day < current_date - 2`;
    const n = (k: string) => rows.find((r: any) => r.k === k)?.n || 0;
    return !capped || (n("safe_api") <= DAY_CAP && n("safe_ip:" + ip) <= IP_CAP);
  } catch { return true; }
}

export async function GET(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const q = new URL(req.url).searchParams;
  if (q.get("usage")) {
    const sql = await db();
    const rows = await sql`select day::text, n from counts where k = 'safe_api' order by day desc limit 7`;
    return json({ cap: DAY_CAP, ipCap: IP_CAP, days: rows });
  }
  const p = path(req);
  if (!p) return oops("Not allowed.", 403);
  const fresh = !!q.get("fresh"), now = Date.now();
  const hit = HIT.get(p);
  if (!fresh && hit && now - hit.at < KEEP(p)) return pass(hit.status, hit.body);
  if (!fresh && SHARED(p) && env("SHOP_DATABASE_URL")) {
    try {
      const sql = await db();
      const [row] = await sql`select status, body, extract(epoch from at) * 1000 as at from safe_cache where k = ${p}`;
      if (row && now - Number(row.at) < KEEP(p)) { HIT.set(p, { at: Number(row.at), status: row.status, body: row.body }); return pass(row.status, row.body); }
    } catch {}
  }
  if (!await spend(req, true)) return oops("Safe's service is resting till tomorrow.", 429);
  const r = await fetch(BASE + p, { headers: headers(), signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  const body = await r.text();
  if (r.ok || r.status === 404) {
    if (HIT.size > 2000) HIT.clear();
    HIT.set(p, { at: now, status: r.status, body });
    if (SHARED(p) && body.length < 50_000 && env("SHOP_DATABASE_URL")) {
      try { const sql = await db(); await sql`insert into safe_cache (k, status, body) values (${p}, ${r.status}, ${body})
        on conflict (k) do update set status = excluded.status, body = excluded.body, at = now()`; } catch {}
    }
  }
  return pass(r.status === 429 ? 503 : r.status, body);    // Safe's own 5-a-second limit: busy, not "resting"
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const p = path(req);
  if (!p || !/\/(multisig-transactions|confirmations)\/$/.test(p)) return oops("Not allowed.", 403);
  const text = await req.text();
  if (text.length > 200_000) return oops("Too big.", 413);
  await spend(req, false);
  const r = await fetch(BASE + p, { method: "POST", headers: headers(), body: text, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  // a new proposal or signature: the queue's next read must see it
  const safe = p.match(/safes\/(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase();
  for (const k of HIT.keys()) if (k.includes("multisig-transactions") && (!safe || k.toLowerCase().includes(safe))) HIT.delete(k);
  return pass(r.status, await r.text());
}
