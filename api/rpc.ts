// /api/rpc?chain=<id>: /safe's chain reads (eth_getLogs: a Safe's history, src/safe/history.ts), through the shop's Alchemy key (never a public RPC; the key never
// reaches the browser). One JSON-RPC call per POST, read methods only (READ). Never log a body here.
// wedgie_prices [token addresses]: {eth, tokens: {address: usd}, logos: {address: url}} from Alchemy's prices API
// (mainnets only); eth is the chain's own coin (ETH, POL, …). DexScreener fills the long tail, as in Instant Wallet:
// a price Alchemy doesn't have, and a logo (Alchemy has none for most small tokens).
// Morpho vault shares: Morpho's API (no DEX has them).
import { env, json, oops, crossSite, db, ipOf } from "./_shop.js";

export const HOSTS: Record<number, string> = { 1: "eth-mainnet", 8453: "base-mainnet", 10: "opt-mainnet", 42161: "arb-mainnet",
  137: "polygon-mainnet", 43114: "avax-mainnet", 56: "bnb-mainnet", 100: "gnosis-mainnet", 42220: "celo-mainnet",
  146: "sonic-mainnet", 5042: "arc-mainnet", 4663: "robinhood-mainnet", 84532: "base-sepolia", 11155111: "eth-sepolia" };
// each chain's own coin, as Alchemy's prices API names it (ETH if not here; Arc's coin is USDC: a dollar)
const COIN: Record<number, string> = { 137: "POL", 43114: "AVAX", 56: "BNB", 100: "XDAI", 42220: "CELO", 146: "S", 5042: "USDC" };
// DexScreener's name for each chain
const DEX: Record<number, string> = { 1: "ethereum", 8453: "base", 10: "optimism", 42161: "arbitrum", 137: "polygon",
  43114: "avalanche", 56: "bsc", 100: "gnosischain", 42220: "celo", 146: "sonic" };
const READ = new Set(["eth_call", "eth_getCode", "eth_getBalance", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_blockNumber", "eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "eth_getLogs", "alchemy_getTokenBalances", "alchemy_getTokenMetadata"]);
const TEST = new Set([84532, 11155111]);

// Kept while this function instance is warm: a price for a minute, a token's name and decimals for good (they never
// change). Fewer Alchemy calls, and a page that asks again gets its answer at once.
const PRICED = new Map<string, { at: number; v: any }>(), META = new Map<string, any>();
const LOGOS = new Map<string, { at: number; v: string }>();   // chain:token -> logo url, kept 2 days (logos rarely change)
const LOGO_MS = 2 * 86_400_000;
const logo = (k: string) => { const l = LOGOS.get(k); return l && Date.now() - l.at < LOGO_MS ? l.v : null; };
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
  const out: { eth: number | null; tokens: Record<string, number>; logos: Record<string, string> } = { eth: null, tokens: {}, logos: {} };
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
  // DexScreener: each token's most liquid pair, all in one request (30 max)
  // only the tokens still missing a price or a logo
  const all = list.map((x) => x.toLowerCase()), ask = all.filter((a) => !out.tokens[a] || !logo(chain + ":" + a));
  if (DEX[chain] && ask.length) {
    const pairs: any[] = await fetch(`https://api.dexscreener.com/tokens/v1/${DEX[chain]}/${ask.join(",")}`)
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    for (const a of ask) {
      const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => String(p?.baseToken?.address).toLowerCase() === a)
        .sort((x, y) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0));
      const img = mine.find((p) => p?.info?.imageUrl)?.info.imageUrl, v = Number(mine[0]?.priceUsd);
      if (typeof img === "string" && img.startsWith("https://")) { if (LOGOS.size > 5000) LOGOS.clear(); LOGOS.set(chain + ":" + a, { at: Date.now(), v: img }); }
      if (!out.tokens[a] && v > 0) out.tokens[a] = v;
    }
  }
  await morpho(chain, all.filter((a) => !out.tokens[a]), out.tokens);
  for (const a of all) { const l = logo(chain + ":" + a); if (l) out.logos[a] = l; }
  return out;
}

/** Morpho vault shares (sirloinUSDC, …): no DEX trades them, so Morpho's API gives their price (a share's worth of
 *  the asset) and the curator's logo. It lists only vaults Morpho's factories made: a spam token can't be one. */
async function morpho(chain: number, ask: string[], tokens: Record<string, number>) {
  if (!ask.length || !DEX[chain]) return;
  const w = `(where: {address_in: ${JSON.stringify(ask)}, chainId_in: [${chain}]})`;
  const r: any = await fetch("https://api.morpho.org/graphql", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ vaults${w} { items { address state { sharePriceUsd } metadata { image } } }
      vaultV2s${w} { items { address sharePrice asset { price { usd } } metadata { image } } } }` }) })
    .then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const got = [...(r?.data?.vaults?.items || []).map((v: any) => [v.address, Number(v.state?.sharePriceUsd), v.metadata?.image]),
    ...(r?.data?.vaultV2s?.items || []).map((v: any) => [v.address, Number(v.sharePrice) * Number(v.asset?.price?.usd), v.metadata?.image])];
  for (const [addr, v, img] of got) {
    const a = String(addr).toLowerCase();
    if (!ask.includes(a)) continue;
    if (v > 0) tokens[a] = v;
    if (typeof img === "string" && img.startsWith("https://")) LOGOS.set(chain + ":" + a, { at: Date.now(), v: img });
  }
}

/** The Alchemy key: SHOP_RPC_1 is an Alchemy URL ending in /v2/<key>. */
export const key = () => env("ALCHEMY_API_KEY") || (env("SHOP_RPC_1").match(/alchemy\.com\/v2\/([\w-]+)/) || [])[1] || "";

// A /safe page reads every 1.5 s while it waits: about 40 a minute. Past these, the IP waits (the key costs money).
// tag: another endpoint's own count in the same table (api/net.ts).
const PER_MIN = 600, PER_DAY = 20_000;
export async function overLimit(req: Request, perMin = PER_MIN, perDay = PER_DAY, tag = "") {
  if (!env("SHOP_DATABASE_URL")) return false;
  try {
    const sql = await db(), ip = tag + (await ipOf(req)), t = new Date().toISOString();
    const rows = await sql`insert into rpc_hits (k, n) values (${ip + ":" + t.slice(0, 16)}, 1), (${ip + ":" + t.slice(0, 10)}, 1)
      on conflict (k) do update set n = rpc_hits.n + 1 returning n`;
    if (Math.random() < 0.01) await sql`delete from rpc_hits where at < now() - interval '2 days'`;
    return rows[0].n > perMin || rows[1].n > perDay;
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
  // 401/403: this chain isn't turned on for the key (Alchemy dashboard). Not "busy": the page shouldn't retry it
  if (r.status === 401 || r.status === 403) return oops("This chain isn't on for wedgie.dev yet.", 404);
  if (!r.ok) return oops("Busy.", r.status === 429 ? 429 : 502);
  const out = await r.json();
  if (mk && out?.result && typeof out.result.decimals === "number") { if (META.size > 5000) META.clear(); META.set(mk, out.result); }
  return json(out);
}
