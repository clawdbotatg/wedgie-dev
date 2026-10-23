// /api/safe?u=<path>: /safe's calls to Safe's Transaction Service (api.safe.global/tx-service/<path>), with our key
// (SAFE_API_KEY, developer.safe.global, Austin's ethereum.org Google). The free plan: 50K a month, 5 a second; the
// next is €199 a month. Without a key Safe allows 5,000 a month per IP, and one person's page used that up (10-21).
// So it's spent carefully:
//   - a daily cap (DAY_CAP, under 50K/30): past it, 429 and the page carries on. No per-IP cap (Austin, 10-22:
//     the busiest user is him; one open tab used 300 in a few hours)
//     from the chain and Instant Wallet's queue
//   - answers kept for everyone (in memory while warm, and in the database): one call per Safe, however many look.
//     A Safe's history comes with &v=<its nonce, coins> from the chain: kept till that changes (or 30 min).
//     The queue: 100 s. &fresh=1 (Refresh, after a sign) asks Safe again
//   - GET ?usage=1: today's count and the last 7 days, and how the page's chain reads compared (PUT)
// PUT {what, chain, safe, diffs}: the page asked Safe's API and the chain the same thing (history, creation, ran);
// counted per day as matched or not, the last CMP_KEEP mismatches kept (Safe addresses only, which are public).
// GET = a read; POST = a proposal or a signature, DELETE = removing a queued one (its proposer's signed request),
// passed on as is (counted, never capped). Never log a body here.
import { env, json, oops, crossSite, db } from "./_shop.js";

const BASE = "https://api.safe.global/tx-service/";
const DAY_CAP = 1500;
// <chain>/api/v1/<safes|owners|multisig-transactions>/..., nothing else
const PATH = /^[a-z0-9-]+\/api\/v1\/(safes|owners|multisig-transactions)\/[\w\-./?=&,]*$/;
// how long an answer is kept: a person's Safes a day (Refresh asks again), a Safe's creation for good, history with its
// version 30 min, the queue 100 s, the rest briefly
const KEEP = (p: string, v: string) => /\/creation\/$/.test(p) ? 365 * 86_400_000 : /^[^/]+\/api\/v1\/owners\//.test(p) ? 86_400_000
  : /all-transactions/.test(p) ? v ? 30 * 60_000 : 60_000 : /executed=false/.test(p) ? 100_000 : 15_000;
const HIT = new Map<string, { at: number; status: number; body: string }>();

const pass = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const headers = () => ({ "Content-Type": "application/json", ...(env("SAFE_API_KEY") ? { Authorization: `Bearer ${env("SAFE_API_KEY")}` } : {}) });
const path = (req: Request) => { const u = new URL(req.url).searchParams.get("u") || ""; return PATH.test(u) && !u.includes("..") ? u : ""; };
const today = () => new Date().toISOString().slice(0, 10);

/** One more call to Safe: false when today's share is used. The database down: allowed. */
async function spend(req: Request, capped: boolean) {
  if (!env("SHOP_DATABASE_URL")) return true;
  try {
    const sql = await db();
    const [row] = await sql`insert into counts (day, k, n) values (${today()}, 'safe_api', 1)
      on conflict (day, k) do update set n = counts.n + 1 returning n`;
    if (Math.random() < 0.01) await sql`delete from counts where k like 'safe_ip:%'`;   // the old per-IP counts
    return !capped || row.n <= DAY_CAP;
  } catch { return true; }
}

export async function GET(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const q = new URL(req.url).searchParams;
  if (q.get("usage")) {
    const sql = await db();
    const rows = await sql`select day::text, n from counts where k = 'safe_api' order by day desc limit 7`;
    const cmp = await sql`select day::text, k, n from counts where k like 'safe_cmp:%' order by day desc, k limit 60`;
    const diffs = await sql`select what, chain, safe, diffs, at from safe_cmp order by n desc limit 20`.catch(() => []);
    return json({ cap: DAY_CAP, days: rows, cmp, diffs });
  }
  const p = path(req);
  if (!p) return oops("Not allowed.", 403);
  const v = (q.get("v") || "").replace(/[^\w.:-]/g, "").slice(0, 120), k = v ? `${p}#${v}` : p, keep = KEEP(p, v);
  const fresh = !!q.get("fresh"), now = Date.now();
  const hit = HIT.get(k);
  if (!fresh && hit && now - hit.at < keep) return pass(hit.status, hit.body);
  if (!fresh && env("SHOP_DATABASE_URL")) {
    try {
      const sql = await db();
      const [row] = await sql`select status, body, extract(epoch from at) * 1000 as at from safe_cache where k = ${k}`;
      if (row && now - Number(row.at) < keep) { HIT.set(k, { at: Number(row.at), status: row.status, body: row.body }); return pass(row.status, row.body); }
    } catch {}
  }
  if (!await spend(req, true)) return oops("Safe's service is resting till tomorrow.", 429);
  const r = await fetch(BASE + p, { headers: headers(), signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  const body = await r.text();
  if (r.ok || r.status === 404) {
    if (HIT.size > 2000) HIT.clear();
    HIT.set(k, { at: now, status: r.status, body });
    if (body.length < 300_000 && env("SHOP_DATABASE_URL")) {
      try { const sql = await db(); await sql`insert into safe_cache (k, status, body) values (${k}, ${r.status}, ${body})
        on conflict (k) do update set status = excluded.status, body = excluded.body, at = now()`;
        if (Math.random() < 0.02) await sql`delete from safe_cache where at < now() - interval '2 days' and k not like '%/creation/' and k not like '%/owners/%'`; } catch {}
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

/** Remove a queued transaction: <chain>/api/v2/multisig-transactions/<safeTxHash>/, body { safeTxHash, signature }. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const u = new URL(req.url).searchParams.get("u") || "";
  if (!/^[a-z0-9-]+\/api\/v2\/multisig-transactions\/0x[0-9a-fA-F]{64}\/$/.test(u)) return oops("Not allowed.", 403);
  const text = await req.text();
  if (text.length > 2000) return oops("Too big.", 413);
  await spend(req, false);
  const r = await fetch(BASE + u, { method: "DELETE", headers: headers(), body: text, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r) return oops("Safe's service didn't answer.", 502);
  for (const k of HIT.keys()) if (k.includes("multisig-transactions")) HIT.delete(k);
  return pass(r.status, r.status === 204 ? "{}" : await r.text());
}

const CMP_KEEP = 500;
export async function PUT(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const text = await req.text();
  if (text.length > 8000) return oops("Too big.", 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return oops("Bad request."); }
  const what = ["history", "creation", "ran"].includes(b?.what) ? b.what : "";
  const safe = /^0x[0-9a-fA-F]{40}$/.test(b?.safe) ? b.safe.toLowerCase() : "", chain = Number(b?.chain) | 0;
  if (!what || !safe || !chain || !Array.isArray(b.diffs)) return oops("Bad request.");
  const diffs = b.diffs.slice(0, 20).map((d: unknown) => String(d).slice(0, 200));
  try {
    const sql = await db();
    await sql`insert into counts (day, k, n) values (${today()}, ${`safe_cmp:${what}:${diffs.length ? "diff" : "same"}`}, 1)
      on conflict (day, k) do update set n = counts.n + 1`;
    if (diffs.length) {
      await sql`insert into safe_cmp (what, chain, safe, diffs) values (${what}, ${chain}, ${safe}, ${diffs.join("\n")})`;
      if (Math.random() < 0.05) await sql`delete from safe_cmp where n < (select max(n) from safe_cmp) - ${CMP_KEEP}`;
    }
  } catch {}
  return json({ ok: true });
}
