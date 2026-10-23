// /api/safes: our own list of who owns which Safe, so /safe finds a person's Safes when Safe's API is down
// (or hasn't indexed one yet). Only what the chain says goes in: the page sends Safes it has seen, and each one's
// owners are read here, on chain, through Alchemy. All of it is public on chain anyway; no IP is kept.
//   POST {safes: [{chain, safe}]}: read each one's owners now and keep them (one read per Safe per FRESH_MS)
//   GET ?owners=0x..,0x..: {safes: [{chain, safe, owner}]}
import { json, oops, crossSite, db } from "./_shop.js";
import { HOSTS, key } from "./rpc.js";

const MAX = 20, FRESH_MS = 6 * 3600_000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** A Safe's owners from its chain (getOwners()), lowercase; null if it isn't a Safe (or the read failed). */
async function owners(chain: number, safe: string): Promise<string[] | null> {
  const r = await fetch(`https://${HOSTS[chain]}.g.alchemy.com/v2/${key()}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: safe, data: "0xa0e67e2b" }, "latest"] }),
    signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
  const d: string = r?.result || "";
  if (d.length < 130) return null;
  const n = Number(BigInt("0x" + d.slice(66, 130)));
  if (!n || n > 50) return null;
  return Array.from({ length: n }, (_, i) => "0x" + d.slice(130 + 64 * i + 24, 130 + 64 * (i + 1)));
}

export async function GET(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const list = (new URL(req.url).searchParams.get("owners") || "").split(",").filter((a) => ADDR.test(a)).slice(0, 10).map((a) => a.toLowerCase());
  if (!list.length) return oops("Bad request.");
  const sql = await db();
  const rows = await sql`select chain, safe, owner from safe_owners where owner = any(${list})`;
  return json({ safes: rows });
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const text = await req.text();
  if (text.length > 4000) return oops("Too big.", 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return oops("Bad request."); }
  const want = (Array.isArray(b?.safes) ? b.safes : []).filter((s: any) => HOSTS[Number(s?.chain)] && ADDR.test(s?.safe)).slice(0, MAX)
    .map((s: any) => ({ chain: Number(s.chain), safe: String(s.safe).toLowerCase() }));
  if (!want.length) return oops("Bad request.");
  const sql = await db();
  const seen = await sql`select chain, safe from safe_owners where at > now() - make_interval(secs => ${FRESH_MS / 1000})
    and safe = any(${want.map((s: any) => s.safe)})`;
  const todo = want.filter((s: any) => !seen.some((r: any) => r.chain === s.chain && r.safe === s.safe));
  let kept = 0;
  await Promise.all(todo.map(async (s: any) => {
    const o = await owners(s.chain, s.safe);
    if (!o) return;
    // owners change: the chain's list now replaces the old one
    await sql`delete from safe_owners where chain = ${s.chain} and safe = ${s.safe}`;
    for (const owner of o) await sql`insert into safe_owners (chain, safe, owner) values (${s.chain}, ${s.safe}, ${owner}) on conflict do nothing`;
    kept++;
  }));
  return json({ ok: true, kept });
}
