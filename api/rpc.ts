// /api/rpc?chain=<id>: /safe's chain reads, through the shop's Alchemy key (never a public RPC; the key never
// reaches the browser). One JSON-RPC call per POST, read methods only (READ). Never log a body here.
import { env, json, oops, crossSite, db, ipOf } from "./_shop.js";

const HOSTS: Record<number, string> = { 1: "eth-mainnet", 8453: "base-mainnet", 10: "opt-mainnet", 42161: "arb-mainnet",
  84532: "base-sepolia", 11155111: "eth-sepolia" };
const READ = new Set(["eth_call", "eth_getCode", "eth_getBalance", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_blockNumber", "eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt"]);

/** The Alchemy key: SHOP_RPC_1 is an Alchemy URL ending in /v2/<key>. */
const key = () => env("ALCHEMY_API_KEY") || (env("SHOP_RPC_1").match(/alchemy\.com\/v2\/([\w-]+)/) || [])[1] || "";

// A /safe page reads every 1.5 s while it waits: about 40 a minute. Past these, the IP waits (the key costs money).
const PER_MIN = 300, PER_DAY = 20_000;
async function overLimit(req: Request) {
  if (!env("SHOP_DATABASE_URL")) return false;
  try {
    const sql = await db(), ip = await ipOf(req), t = new Date().toISOString();
    const rows = await sql`insert into rpc_hits (k, n) values (${ip + ":" + t.slice(0, 16)}, 1), (${ip + ":" + t.slice(0, 10)}, 1)
      on conflict (k) do update set n = rpc_hits.n + 1 returning n`;
    if (Math.random() < 0.01) await sql`delete from rpc_hits where at < now() - interval '2 days'`;
    return rows[0].n > PER_MIN || rows[1].n > PER_DAY;
  } catch { return false; }   // the database down: reads still work
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const host = HOSTS[Number(new URL(req.url).searchParams.get("chain"))];
  if (!host || !key()) return oops("No such chain.", 404);
  if (await overLimit(req)) return oops("Too many reads. Wait a minute.", 429);
  const text = await req.text();
  if (text.length > 20_000) return oops("Too big.", 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return oops("Bad request."); }
  if (!b || Array.isArray(b) || !READ.has(b.method) || !Array.isArray(b.params)) return oops("Not allowed.", 403);
  const r = await fetch(`https://${host}.g.alchemy.com/v2/${key()}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: b.id ?? 1, method: b.method, params: b.params }) });
  if (!r.ok) return oops("Busy.", r.status === 429 ? 429 : 502);
  return json(await r.json());
}
