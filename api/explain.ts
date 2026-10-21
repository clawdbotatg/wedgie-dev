// /api/explain: what a Safe transaction does, for the calls /safe can't put in words itself (src/safe/describe.ts).
//   POST {chain, safe, calls: [{to, value, data}], need: [i]}   need: the calls describe.ts couldn't read
//   -> {calls: [{what, fields: [{label, value, address?}]} | null], bot: string | null}
// Two tiers, in order:
//   1. Clear signing (ERC-7730): the contract team's own words, from the public registry, through Sourcify's
//      formatter (@ethereum-sourcify/clear-signing). No guessing.
//   2. 🤖: if any call in need has no descriptor, a model writes one line for the whole transaction. It sees the
//      calls, their function names (Sourcify's signature list), the contracts' names (Sourcify), and what the Safe
//      would send and get (eth_simulateV1 through Alchemy, from the Safe). A guess: the page marks it 🤖.
// Each answer is kept in the database (explained, by a hash of the request): the same transaction costs once.
// New 🤖 answers: BOT_DAY a day per IP (the model costs money). Never log a body here.
import { fetchPrebuiltRegistryIndex, format, isFieldGroup } from "@ethereum-sourcify/clear-signing";
import type { ExternalDataProvider, RegistryIndex, TokenResult } from "@ethereum-sourcify/clear-signing";
import { keccak256, toHex } from "viem";
import { env, json, oops, crossSite, db, ipOf, sha256 } from "./_shop.js";
import { HOSTS, key } from "./rpc.js";

const BOT_DAY = 200, MAX_CALLS = 20, MAX_DATA = 40_000;
const MODEL = () => env("BANKR_LLM_MODEL") || "claude-sonnet-5.5";
const NATIVE: Record<number, string> = { 137: "POL", 43114: "AVAX", 56: "BNB", 100: "xDAI", 42220: "CELO", 146: "S", 5042: "USDC" };
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX = /^0x[0-9a-fA-F]*$/;
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const ETH_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";   // eth_simulateV1 traceTransfers: the coin's moves

type Call = { to: string; value: string; data: string };
type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[] } | null;

async function alchemy(chain: number, method: string, params: unknown[]) {
  const r = await fetch(`https://${HOSTS[chain]}.g.alchemy.com/v2/${key()}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ---- kept while this function instance is warm ----
let index: Promise<RegistryIndex | undefined> | null = null;
const registry = () => index ||= fetchPrebuiltRegistryIndex().catch(() => { index = null; return undefined; });
const TOKENS = new Map<string, TokenResult | null>(), NAMES = new Map<string, string>(), SIGS = new Map<string, string>();

async function token(chain: number, a: string): Promise<TokenResult | null> {
  const k = chain + ":" + a.toLowerCase();
  if (!TOKENS.has(k)) {
    const m = await alchemy(chain, "alchemy_getTokenMetadata", [a]).catch(() => null);
    TOKENS.set(k, m && typeof m.decimals === "number" ? { name: m.name || m.symbol || "", symbol: m.symbol || "?", decimals: m.decimals } : null);
  }
  return TOKENS.get(k)!;
}
const provider = (chain: number): ExternalDataProvider => ({
  resolveToken: (c, a) => token(c || chain, a),
  resolveChainInfo: async (c) => ({ name: `chain ${c}`, nativeCurrency: { name: NATIVE[c] || "Ether", symbol: NATIVE[c] || "ETH", decimals: 18 } }),
});

/** Tier 1: a call in the descriptor's words, or null if the registry has nothing for it. */
async function clear(chain: number, c: Call): Promise<Told> {
  try {
    const m = await format({ chainId: chain, to: c.to, data: c.data, value: BigInt(c.value || 0) },
      { externalDataProvider: provider(chain), descriptorResolverOptions: { type: "github", index: await registry() } as any });
    if (!m.intent && !m.interpolatedIntent) return null;
    if (m.warnings?.some((w) => w.code === "NO_DESCRIPTOR" || w.code === "CALLDATA_DECODE_ERROR" || w.code === "NO_FORMAT_MATCH")) return null;
    const fields: Field[] = [];
    for (const f of m.fields || []) for (const x of isFieldGroup(f) ? f.fields : [f])
      fields.push({ label: x.label, value: x.value, ...(x.rawAddress ? { address: x.rawAddress } : {}) });
    const intent = typeof m.intent === "string" ? m.intent : m.intent ? Object.values(m.intent)[0] : "";
    return { what: m.interpolatedIntent || intent, fields };
  } catch { return null; }
}

// ---- tier 2 ----
async function contractName(chain: number, a: string) {
  const k = chain + ":" + a.toLowerCase();
  if (!NAMES.has(k)) {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${chain}/${a}?fields=compilation`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    NAMES.set(k, r?.compilation?.name || "");
  }
  return NAMES.get(k)!;
}
async function signature(sel: string) {
  if (!SIGS.has(sel)) {
    const r = await fetch(`https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${sel}&filter=true`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    SIGS.set(sel, (r?.result?.function?.[sel] || []).map((x: any) => x.name).slice(0, 3).join(" or "));
  }
  return SIGS.get(sel)!;
}
const units = (v: bigint, d: number) => {
  const s = v.toString().padStart(d + 1, "0"), w = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, "").slice(0, 6);
  return f ? `${w}.${f}` : w;
};
/** What the Safe sends and gets if these calls run now (eth_simulateV1, from the Safe, no checks), as lines. */
async function simulate(chain: number, safe: string, calls: Call[]): Promise<string[]> {
  const r = await alchemy(chain, "eth_simulateV1", [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: safe, to: c.to,
    value: "0x" + BigInt(c.value || 0).toString(16), data: c.data || "0x" })) }], traceTransfers: true, validation: false }, "latest"]);
  const res = r?.[0]?.calls || [];
  if (res.some((x: any) => x.status !== "0x1")) return ["It fails if run now (the simulation reverted)."];
  const me = safe.toLowerCase(), net = new Map<string, bigint>();
  for (const x of res) for (const l of x.logs || []) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3) continue;
    const from = "0x" + l.topics[1].slice(26), to = "0x" + l.topics[2].slice(26), v = BigInt(l.data || "0x0"), t = l.address.toLowerCase();
    if (from === me) net.set(t, (net.get(t) || 0n) - v);
    if (to === me) net.set(t, (net.get(t) || 0n) + v);
  }
  const out: string[] = [];
  for (const [t, v] of net) {
    if (!v) continue;
    const m = t === ETH_LOG ? { symbol: NATIVE[chain] || "ETH", decimals: 18 } : await token(chain, t);
    out.push(`${v < 0n ? "Safe sends" : "Safe gets"} ${m ? `${units(v < 0n ? -v : v, m.decimals)} ${m.symbol}` : `${v < 0n ? -v : v} units of token ${t}`}`);
  }
  return out.length ? out.sort().reverse() : ["No tokens or coins move."];   // sends before gets
}

async function bot(chain: number, safe: string, calls: Call[]) {
  if (!env("BANKR_LLM_API_KEY")) return null;
  const [moves, about] = await Promise.all([
    simulate(chain, safe, calls).catch(() => ["(simulation unavailable)"]),
    Promise.all(calls.map(async (c, i) => {
      const [name, sig, tok] = await Promise.all([contractName(chain, c.to), c.data.length >= 10 ? signature(c.data.slice(0, 10)) : "",
        token(chain, c.to).catch(() => null)]);
      return `${i + 1}. to ${c.to}${name ? ` (contract ${name})` : ""}${tok ? ` (token ${tok.symbol}, ${tok.decimals} decimals)` : ""}` +
        `, value ${c.value || 0} wei, function ${sig || "unknown"}, data ${c.data.slice(0, 2000)}${c.data.length > 2000 ? "…" : ""}`;
    })),
  ]);
  const prompt = `A Safe multisig (${safe}) on chain ${chain} is asked to sign this transaction:
${about.join("\n")}

Simulated, from the Safe (the truth about what moves):
${moves.join("\n")}

Say what it does in one short plain-English sentence, at most 12 words, like "Swap 1,000 USDC for 0.38 ETH" or
"Deposit 2 ETH into Aave". Use the simulated amounts. Name a protocol only if the contract name above shows it.
If you can't tell, say what you can see ("Calls deposit on 0x12…34, sends 0.5 ETH"). No hex longer than 0x1234…abcd.
Reply with the sentence only.`;
  const r = await fetch(`${(env("BANKR_LLM_BASE_URL") || "https://llm.bankr.bot/v1").replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${env("BANKR_LLM_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1500, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return null;
  const s = String((await r.json())?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").split("\n")[0];
  return s.slice(0, 200) || null;
}

async function botAllowed(req: Request) {
  if (!env("SHOP_DATABASE_URL")) return true;
  try {
    const sql = await db(), k = "bot:" + await ipOf(req) + ":" + new Date().toISOString().slice(0, 10);
    const [r] = await sql`insert into rpc_hits (k, n) values (${k}, 1) on conflict (k) do update set n = rpc_hits.n + 1 returning n`;
    return r.n <= BOT_DAY;
  } catch { return true; }
}

let ready: Promise<unknown> | null = null;
async function store() {
  const sql = await db();
  ready ||= sql`create table if not exists explained (k text primary key, v jsonb not null, at timestamptz not null default now())`
    .catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  const chain = Number(b?.chain), safe = String(b?.safe || "");
  if (!HOSTS[chain] || !key()) return oops("No such chain.", 404);
  if (!ADDR.test(safe) || !Array.isArray(b.calls) || !b.calls.length || b.calls.length > MAX_CALLS) return oops("Bad request.");
  const calls: Call[] = [];
  for (const c of b.calls) {
    const to = String(c?.to || ""), data = String(c?.data || "0x"), value = String(c?.value ?? "0");
    if (!ADDR.test(to) || !HEX.test(data) || data.length > MAX_DATA || !/^\d+$/.test(value)) return oops("Bad call.");
    calls.push({ to, data, value });
  }
  const need: number[] = (Array.isArray(b.need) ? b.need : calls.map((_, i) => i)).filter((i: any) => Number.isInteger(i) && i >= 0 && i < calls.length);
  const k = await sha256(JSON.stringify([chain, safe.toLowerCase(), calls, need]));
  const sql = env("SHOP_DATABASE_URL") ? await store().catch(() => null) : null;
  if (sql) {
    const [hit] = await sql`select v from explained where k = ${k}`.catch(() => []);
    if (hit) return json(hit.v);
  }
  const told: Told[] = calls.map(() => null);
  await Promise.all(need.map(async (i) => { told[i] = await clear(chain, calls[i]); }));
  const said = need.some((i) => !told[i]) && await botAllowed(req) ? await bot(chain, safe, calls).catch(() => null) : null;
  const v = { calls: told, bot: said };
  // a 🤖 that didn't answer isn't kept: the next look tries again
  if (sql && (said || !need.some((i) => !told[i]))) await sql`insert into explained (k, v) values (${k}, ${JSON.stringify(v)}::jsonb) on conflict do nothing`.catch(() => {});
  return json(v);
}
