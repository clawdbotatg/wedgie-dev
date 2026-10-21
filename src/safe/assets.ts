// What a Safe holds: ETH, every ERC-20 Alchemy finds (alchemy_getTokenBalances through /api/rpc), and dollar
// prices (wedgie_prices). A token with no price is folded away as "other": that's where airdropped spam lands.
// Alchemy down or a fork with no alchemy_ methods: ETH and USDC from the chain, no dollars.
export type Asset = { token: string | null; symbol: string; name: string; decimals: number; balance: bigint; usd: number | null; price: number | null };
type Rpc = (method: string, params: unknown[]) => Promise<any>;

const META = "wedgie.safe.tokens";       // token metadata, per chain:address: it never changes
let meta: Record<string, { symbol: string; name: string; decimals: number }> = {};
try { meta = JSON.parse(localStorage.getItem(META) || "{}"); } catch {}
const saveMeta = () => { try { localStorage.setItem(META, JSON.stringify(meta)); } catch {} };

/** A token's symbol, name and decimals (cached), or null if Alchemy can't say. */
export async function tokenMeta(chain: number, token: string, rpc: Rpc) {
  const k = `${chain}:${token.toLowerCase()}`;
  if (meta[k]) return meta[k];
  try {
    const m = await rpc("alchemy_getTokenMetadata", [token]);
    if (!m || typeof m.decimals !== "number") return null;
    meta[k] = { symbol: String(m.symbol || "?").slice(0, 12), name: String(m.name || "").slice(0, 40), decimals: m.decimals };
    saveMeta();
    return meta[k];
  } catch { return null; }
}
export const knownMeta = (chain: number, token: string) => meta[`${chain}:${token.toLowerCase()}`] || null;

/** usdc: the chain's USDC (always listed, and known even without Alchemy). */
export async function readAssets(chain: number, safe: string, eth: bigint, usdc: { address: string; balance: bigint | null } | null, rpc: Rpc): Promise<Asset[]> {
  if (usdc) meta[`${chain}:${usdc.address.toLowerCase()}`] ||= { symbol: "USDC", name: "USD Coin", decimals: 6 };
  let held: { token: string; balance: bigint }[] = usdc && usdc.balance !== null ? [{ token: usdc.address, balance: usdc.balance }] : [];
  try {
    const r = await rpc("alchemy_getTokenBalances", [safe, "erc20"]);
    const found = (r?.tokenBalances || []).map((b: any) => ({ token: String(b.contractAddress), balance: BigInt(b.tokenBalance || "0x0") }))
      .filter((b: any) => b.balance > 0n).slice(0, 40);
    held = [...held.filter((h) => !found.some((f: any) => f.token.toLowerCase() === h.token.toLowerCase())), ...found];
  } catch {}
  const metas = await Promise.all(held.map((h) => tokenMeta(chain, h.token, rpc)));
  let px: { eth: number | null; tokens: Record<string, number> } = { eth: null, tokens: {} };
  try { px = await rpc("wedgie_prices", held.slice(0, 25).map((h) => h.token)); } catch {}
  const out: Asset[] = [{ token: null, symbol: "ETH", name: "Ether", decimals: 18, balance: eth, price: px.eth, usd: px.eth === null ? null : Number(eth) / 1e18 * px.eth }];
  held.forEach((h, i) => {
    const m = metas[i];
    if (!m) return;
    const p = px.tokens[h.token.toLowerCase()] ?? null;
    out.push({ token: h.token, symbol: m.symbol, name: m.name, decimals: m.decimals, balance: h.balance, price: p, usd: p === null ? null : Number(h.balance) / 10 ** m.decimals * p });
  });
  return out.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || (a.token === null ? -1 : b.token === null ? 1 : 0));
}

export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });
