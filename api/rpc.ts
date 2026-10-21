// /api/rpc?chain=<id>: /safe's chain reads, through the shop's Alchemy key (never a public RPC; the key never
// reaches the browser). One JSON-RPC call per POST, read methods only (READ). Never log a body here.
// wedgie_prices [token addresses]: {eth, tokens: {address: usd}} from Alchemy's prices API (mainnets only); eth is
// the chain's own coin (ETH, POL, …).
import { env, json, oops, crossSite, db, ipOf } from "./_shop.js";

export const HOSTS: Record<number, string> = { 1: "eth-mainnet", 8453: "base-mainnet", 10: "opt-mainnet", 42161: "arb-mainnet",
  137: "polygon-mainnet", 43114: "avax-mainnet", 56: "bnb-mainnet", 100: "gnosis-mainnet", 42220: "celo-mainnet",
  146: "sonic-mainnet", 5042: "arc-mainnet", 4663: "robinhood-mainnet", 84532: "base-sepolia", 11155111: "eth-sepolia" };
// each chain's own coin, as Alchemy's prices API names it (ETH if not here; Arc's coin is USDC: a dollar)
const COIN: Record<number, string> = { 137: "POL", 43114: "AVAX", 56: "BNB", 100: "XDAI", 42220: "CELO", 146: "S", 5042: "USDC" };
const READ = new Set(["eth_call", "eth_getCode", "eth_getBalance", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_blockNumber", "eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "alchemy_getTokenBalances", "alchemy_getTokenMetadata"]);
const TEST = new Set([84532, 11155111]);

// Kept while this function instance is warm: a price for a minute, a token's name and decimals for good (they never
// change). Fewer Alchemy calls, and a page that asks again gets its answer at once.
const PRICED = new Map<string, { at: number; v: any }>(), META = new Map<string, any>();
const PRICE_MS = 60_000;

/** Dollar prices: the chain's coin and up to 25 tokens on one chain. A test chain's coins are worth nothing. */
async function prices(chain: number, host: string, tokens: unknown[]) {
  const k = chain + ":" + tokens.map(String).map((t) => t.toLowerCase()).sort().join(","), hit = PRICED.get(k);
  if (hit && Date.now() - hit.at < PRICE_MS) return hit.v;
  const v = await pricesNow(chain, host, tokens);
  if (PRICED.size > 500) PRICED.clear();
  PRICED.set(k, { at: Date.now(), v });
  return v;
}
async function pricesNow(chain: number, host: string, tokens: unknown[]) {
  const out: { eth: number | null; tokens: Record<string, number> } = { eth: null, tokens: {} };
  if (TEST.has(chain)) return out;
  const list = tokens.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)).slice(0, 25);
  const base = `https://api.g.alchemy.com/prices/v1/${key()}/tokens`;
  const num = (p: any) => { const v = Number(p?.prices?.find((x: any) => x.currency === "usd")?.value); return v > 0 ? v : null; };
  const [e, t] = await Promise.all([
    fetch(`${base}/by-symbol?symbols=${COIN[chain] || "ETH"}`).then((r) => r.json()).catch(() => null),
    list.length ? fetch(`${base}/by-address`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: list.map((address) => ({ network: host, address })) }) }).then((r) => r.json()).catch(() => null) : null,
  ]);
  out.eth = num(e?.data?.[0]);
  for (const p of t?.data || []) { const v = num(p); if (v && p.address) out.tokens[String(p.address).toLowerCase()] = v; }
  return out;
}

/** The Alchemy key: SHOP_RPC_1 is an Alchemy URL ending in /v2/<key>. */
export const key = () => env("ALCHEMY_API_KEY") || (env("SHOP_RPC_1").match(/alchemy\.com\/v2\/([\w-]+)/) || [])[1] || "";

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
  if (!b || Array.isArray(b) || !Array.isArray(b.params)) return oops("Not allowed.", 403);
  if (b.method === "wedgie_prices") return json({ jsonrpc: "2.0", id: b.id ?? 1, result: await prices(Number(new URL(req.url).searchParams.get("chain")), host, b.params) });
  if (!READ.has(b.method)) return oops("Not allowed.", 403);
  const mk = b.method === "alchemy_getTokenMetadata" ? `${host}:${String(b.params[0]).toLowerCase()}` : "";
  if (mk && META.has(mk)) return json({ jsonrpc: "2.0", id: b.id ?? 1, result: META.get(mk) });
  const r = await fetch(`https://${host}.g.alchemy.com/v2/${key()}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: b.id ?? 1, method: b.method, params: b.params }) });
  if (!r.ok) return oops("Busy.", r.status === 429 ? 429 : 502);
  const out = await r.json();
  if (mk && out?.result && typeof out.result.decimals === "number") { if (META.size > 5000) META.clear(); META.set(mk, out.result); }
  return json(out);
}
