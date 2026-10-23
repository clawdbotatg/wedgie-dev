// A Safe's past from its own chain (eth_getLogs through Alchemy), no Safe API: what it ran, money that came in,
// and the transaction that made it. Shaped like Safe's all-transactions answer, so the page shows either.
// One getLogs on the Safe from block 0 (only the events used here) + one on the main tokens (transfers to it). Too
// many logs (Alchemy's cap: 10K), or a chain that allows only a short range (Gnosis, Celo, Sonic, Avalanche: 10,000
// blocks): read back from the newest block, a window at a time, as far as MAX_WINDOWS goes. Imported by
// src/pages/safe.ts and tools/safecompare.mjs (which checks it against Safe's API on real Safes).
import * as E from "./eth.ts";

type Rpc = (method: string, params: unknown[]) => Promise<any>;
type Log = { address: string; topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string };
type Tok = { symbol: string; decimals: number };

const T = (sig: string) => E.hex(E.keccakText(sig));
const SMT = T("SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)");
const OK = T("ExecutionSuccess(bytes32,uint256)"), FAIL = T("ExecutionFailure(bytes32,uint256)");
const RECEIVED = T("SafeReceived(address,uint256)"), TRANSFER = T("Transfer(address,address,uint256)");
const SETUP = T("SafeSetup(address,address[],uint256,address,address)"), PROXY = T("ProxyCreation(address,address)");
const EXEC = E.selector("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)").slice(2);
const MAX_WINDOWS = 8;

// Money in that Activity shows, besides the chain's coin: these tokens only (a 0-value or unknown-token "transfer" is
// address poisoning; Safe's API shows only tokens it trusts, these among them). USDC comes from the page.
const t = (symbol: string, decimals: number): Tok => ({ symbol, decimals });
const USDT = t("USDT", 6), WETH = t("WETH", 18), DAI = t("DAI", 18), USDCE = t("USDC.e", 6);
const TOKENS: Record<number, Record<string, Tok>> = {
  1: { "0xdac17f958d2ee523a2206206994597c13d831ec7": USDT, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": WETH,
    "0x6b175474e89094c44da98b954eedeac495271d0f": DAI, "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": t("WBTC", 8) },
  8453: { "0x4200000000000000000000000000000000000006": WETH, "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": DAI,
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": t("USDbC", 6) },
  10: { "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": USDT, "0x4200000000000000000000000000000000000006": WETH,
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": DAI, "0x7f5c764cbc14f9669b88837ca1490cca17c31607": USDCE },
  42161: { "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": USDT, "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": WETH,
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": DAI, "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": USDCE },
  137: { "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": USDT, "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": WETH,
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": DAI, "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": USDCE },
  56: { "0x55d398326f99059ff775485246999027b3197955": t("USDT", 18), "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": t("USDC", 18),
    "0x2170ed0880ac9a755fd29b2688956bd959f933f8": t("ETH", 18), "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": t("WBNB", 18) },
};

const w = (d: string, i: number) => d.slice(64 * i, 64 * (i + 1));
const n = (d: string, i: number) => BigInt("0x" + (w(d, i) || "0"));
const ad = (d: string, i: number) => E.checksum("0x" + w(d, i).slice(24));
const dyn = (d: string, i: number) => { const o = Number(n(d, i)) * 2, len = Number(BigInt("0x" + d.slice(o, o + 64))); return "0x" + d.slice(o + 64, o + 64 + len * 2); };
/** The ten execTransaction fields, from a SafeMultiSigTransaction log's data or an execTransaction call (no 0x). */
const fields = (d: string) => ({ to: ad(d, 0), value: String(n(d, 1)), data: dyn(d, 2), operation: Number(n(d, 3)),
  safeTxGas: String(n(d, 4)), baseGas: String(n(d, 5)), gasPrice: String(n(d, 6)), gasToken: ad(d, 7), refundReceiver: ad(d, 8) });
/** An ExecutionSuccess/Failure's safeTxHash: a topic in Safe 1.4.1, the data in 1.3.0. */
const hashOf = (l: Log) => (l.topics[1] || "0x" + w(l.data.slice(2), 0)).toLowerCase();
const isRun = (l: Log) => l.topics[0] === OK || l.topics[0] === FAIL;
const order = (a: Log, b: Log) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex));
const hx = (b: bigint) => "0x" + b.toString(16);

/** Logs for filter f, oldest first: all of them (from: 0n), or the newest MAX_WINDOWS windows' worth (from: where they start). */
async function logsBack(rpc: Rpc, f: object, enough: (l: Log[]) => boolean): Promise<{ logs: Log[]; from: bigint }> {
  try { return { logs: (await rpc("eth_getLogs", [{ ...f, fromBlock: "earliest", toBlock: "latest" }])).sort(order), from: 0n }; }
  catch (e: any) {
    if (!/range|limit|exceed|10K|10,000/i.test(e?.message || "")) throw e;
    let span = BigInt((e.message.match(/up to a ([\d,]+) block range/) || [])[1]?.replace(/,/g, "") || 100_000);
    let to = BigInt(await rpc("eth_blockNumber", [])), out: Log[] = [];
    for (let i = 0; i < MAX_WINDOWS && to > 0n; i++) {
      const from = to - span + 1n > 0n ? to - span + 1n : 0n;
      try { out = [...await rpc("eth_getLogs", [{ ...f, fromBlock: hx(from), toBlock: hx(to) }]), ...out]; }
      catch (e2: any) { if (span > 100n && /range|limit|exceed|10K/i.test(e2?.message || "")) { span /= 4n; i--; continue; } throw e2; }
      to = from - 1n;
      if (enough(out)) break;
    }
    return { logs: out.sort(order), from: to + 1n };
  }
}

/** The Safe's own logs used here, oldest first (kept a minute: history and "did it run" share them). */
const kept = new Map<string, { at: number; p: Promise<{ logs: Log[]; from: bigint }> }>();
export function safeLogs(rpc: Rpc, chain: number, safe: string, enough = 30, fresh = false) {
  const k = `${chain}:${safe.toLowerCase()}`, hit = kept.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = logsBack(rpc, { address: safe, topics: [[SMT, OK, FAIL, RECEIVED]] }, (l) => l.length >= enough);
  p.catch(() => kept.delete(k));
  kept.set(k, { at: Date.now(), p });
  return p;
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000Z", "Z");
/** Each block's time: Alchemy puts it on the log; else one eth_getBlockByNumber per block. */
async function times(rpc: Rpc, logs: Log[]) {
  const out = new Map<string, string>();
  await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (b) => {
    const l = logs.find((x) => x.blockNumber === b)!;
    const s = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : Number(BigInt((await rpc("eth_getBlockByNumber", [b, false])).timestamp));
    out.set(b, iso(s));
  }));
  return out;
}

/** The last `limit` things that happened, newest first, as Safe's all-transactions results. */
export async function chainHistory(rpc: Rpc, chain: number, safe: string, usdc?: string, limit = 25): Promise<any[]> {
  const toks: Record<string, Tok> = { ...TOKENS[chain], ...(usdc ? { [usdc.toLowerCase()]: t("USDC", 6) } : {}) };
  const pad = "0x" + safe.slice(2).toLowerCase().padStart(64, "0");
  const { logs, from } = await safeLogs(rpc, chain, safe, limit + 5);
  const ins: Log[] = Object.keys(toks).length ? (await logsBack(rpc, { address: Object.keys(toks), topics: [TRANSFER, null, pad] }, (l) => l.length >= limit)
    .catch(() => ({ logs: [] as Log[] }))).logs : [];
  // ran: every nonce is one ExecutionSuccess/Failure, in order (nothing else moves it), so with all the logs the nth
  // is nonce n; with only the newest, count down from the Safe's nonce now. A Safe on the L2 singleton says what it
  // ran (SafeMultiSigTransaction, just before, same transaction), nonce and all
  const runs = logs.filter(isRun).length;
  let nonce = from === 0n ? 0 : Number(BigInt(await rpc("eth_call", [{ to: safe, data: E.selector("nonce()") }, "latest"]))) - runs;
  type Item = { at: Log; t: any };
  const items: Item[] = [];
  let last: Log | null = null;
  for (const l of logs) {
    if (l.topics[0] === SMT) { last = l; continue; }
    if (!isRun(l)) continue;
    const smt = last && last.transactionHash === l.transactionHash ? last : null, d = smt?.data.slice(2);
    last = null;
    items.push({ at: l, t: { txType: "MULTISIG_TRANSACTION", safe, safeTxHash: hashOf(l),
      ...(d ? { ...fields(d), nonce: Number(n(dyn(d, 10).slice(2), 0)) } : { nonce }),
      transactionHash: l.transactionHash, isSuccessful: l.topics[0] === OK, isExecuted: true } });
    nonce++;
  }
  // in: the chain's coin (the Safe's receive() logs it) and the tokens above; grouped by transaction, as Safe's API does.
  // What came back in the Safe's own run (a swap's proceeds) belongs to that run: not a row of its own
  const own = new Set(items.map((i) => i.at.transactionHash));
  const byTx = new Map<string, Item>();
  const inItem = (l: Log) => { let i = byTx.get(l.transactionHash); if (!i) byTx.set(l.transactionHash, i = { at: l, t: { txType: "ETHEREUM_TRANSACTION", txHash: l.transactionHash, transfers: [] } }); return i; };
  for (const l of logs) if (l.topics[0] === RECEIVED && n(l.data.slice(2), 0) > 0n && !own.has(l.transactionHash))
    inItem(l).t.transfers.push({ type: "ETHER_TRANSFER", from: E.checksum("0x" + l.topics[1].slice(26)), to: safe, value: String(n(l.data.slice(2), 0)) });
  for (const l of ins) {
    const tok = toks[l.address.toLowerCase()];
    if (!tok || n(l.data.slice(2), 0) === 0n || BigInt(l.blockNumber) < from || own.has(l.transactionHash)) continue;
    inItem(l).t.transfers.push({ type: "ERC20_TRANSFER", from: E.checksum("0x" + l.topics[1].slice(26)), to: safe, value: String(n(l.data.slice(2), 0)),
      tokenAddress: E.checksum(l.address), tokenInfo: { type: "ERC20", ...tok, trusted: true } });
  }
  items.push(...byTx.values());
  const top = items.sort((a, b) => order(b.at, a.at)).slice(0, limit);
  // a non-L2 Safe's log doesn't say what it ran: read the execTransaction call (direct calls only; through a
  // relayer or a batch it stays unread)
  await Promise.all(top.filter((i) => i.t.txType === "MULTISIG_TRANSACTION" && !i.t.to).map(async (i) => {
    const tx = await rpc("eth_getTransactionByHash", [i.t.transactionHash]).catch(() => null);
    if (tx?.to && tx.to.toLowerCase() === safe.toLowerCase() && tx.input?.slice(2, 10) === EXEC) Object.assign(i.t, fields(tx.input.slice(10)));
  }));
  const when = await times(rpc, top.map((i) => i.at));
  for (const i of top) i.t.executionDate = when.get(i.at.blockNumber);
  return top.map((i) => i.t);
}

/** safeTxHash h: ran (its transaction hash), or not on chain yet (null). */
export async function ranOnChain(rpc: Rpc, chain: number, safe: string, h: string, fresh = false) {
  const l = (await safeLogs(rpc, chain, safe, 30, fresh)).logs.find((l) => isRun(l) && hashOf(l) === h.toLowerCase());
  return l ? { transactionHash: l.transactionHash, isSuccessful: l.topics[0] === OK } : null;
}

/** How the Safe was made, from the chain: its one SafeSetup log is in its creation transaction, and the factory is
 *  whoever logged ProxyCreation for it there. Same answer as Safe's /creation/ (transactionHash, factoryAddress). */
export async function chainCreation(rpc: Rpc, safe: string) {
  const [first] = await rpc("eth_getLogs", [{ address: safe, topics: [SETUP], fromBlock: "earliest", toBlock: "latest" }]);
  if (!first) throw new Error("No SafeSetup log from this Safe on chain.");
  const r = await rpc("eth_getTransactionReceipt", [first.transactionHash]);
  const me = safe.slice(2).toLowerCase();
  const pc = (r?.logs || []).find((l: Log) => l.topics[0] === PROXY && (l.topics[1]?.slice(26) === me || l.data.slice(26, 66).toLowerCase() === me));
  if (!pc) throw new Error("Couldn't find the factory that made this Safe.");
  return { transactionHash: first.transactionHash, factoryAddress: E.checksum(pc.address) };
}

// ---- the same answer from Safe's API and the chain: where they differ (the page reports it, the tool prints it) ----
const lc = (s: unknown) => String(s ?? "").toLowerCase();
/** What Activity shows from one answer: runs by safeTxHash, money in by transaction + token. */
function shown(list: any[], safe: string) {
  const ran = new Map<string, any>(), got = new Map<string, { v: bigint; tok: string; date: string }>();
  for (const t of list) {
    if (t.txType === "MULTISIG_TRANSACTION") { ran.set(lc(t.safeTxHash), t); continue; }
    for (const x of t.transfers || []) {
      if (lc(x.to) !== lc(safe) || !x.value || x.value === "0") continue;
      const tok = x.type === "ETHER_TRANSFER" ? "coin" : x.tokenInfo?.trusted && x.tokenInfo.type === "ERC20" ? lc(x.tokenAddress) : null;
      if (!tok) continue;
      const k = `${lc(t.txHash || t.transactionHash)}:${tok}`;
      got.set(k, { v: BigInt(x.value) + (got.get(k)?.v || 0n), tok, date: t.executionDate });
    }
  }
  return { ran, got };
}
/** Differences between Safe's all-transactions results and chainHistory's, over the stretch of time both cover.
 *  Lines in () are known and fine: Safe's API shows a token the chain doesn't read, or lists a run as a plain transaction. */
export function diffHistory(chain: number, svc: any[], mine: any[], safe: string, usdc?: string) {
  const out: string[] = [], s = shown(svc, safe), h = shown(mine, safe);
  const dates = (l: any[]) => l.map((t) => t.executionDate).filter(Boolean).sort();
  const sd = dates(svc), hd = dates(mine);
  if (!sd.length || !hd.length) return sd.length === hd.length ? out : [`${sd.length ? "chain" : "Safe's API"}: nothing`];
  const from = sd[0] > hd[0] ? sd[0] : hd[0], to = sd.at(-1)! < hd.at(-1)! ? sd.at(-1)! : hd.at(-1)!;
  const inside = (d: string) => d >= from && d <= to;
  const toks = new Set([...Object.keys(TOKENS[chain] || {}), lc(usdc)]);
  for (const [k, t] of s.ran) {
    if (!inside(t.executionDate)) continue;
    const m = h.ran.get(k);
    if (!m) { out.push(`ran #${t.nonce} ${k.slice(0, 10)}: only in Safe's`); continue; }
    for (const f of ["nonce", "to", "value", "data", "operation", "transactionHash", "isSuccessful", "executionDate"])
      if (lc(t[f] ?? (f === "data" ? "0x" : "")) !== lc(m[f])) out.push(`ran #${t.nonce} ${f}: safe ${String(t[f]).slice(0, 42)} chain ${String(m[f]).slice(0, 42)}`);
  }
  const plain = new Set(svc.filter((t) => t.txType !== "MULTISIG_TRANSACTION").map((t) => lc(t.txHash || t.transactionHash)));
  for (const [k, t] of h.ran) if (!s.ran.has(k) && inside(t.executionDate))
    out.push(plain.has(lc(t.transactionHash)) ? `(ran #${t.nonce}: Safe's API lists it as a plain transaction)` : `ran #${t.nonce} ${k.slice(0, 10)}: only on chain`);
  for (const [k, x] of s.got) {
    if (!inside(x.date)) continue;
    const m = h.got.get(k);
    if (!m) out.push(x.tok === "coin" || toks.has(x.tok) ? `in ${x.tok.slice(0, 10)} ${k.slice(0, 10)}: only in Safe's` : `(in ${x.tok.slice(0, 10)}: a token the chain doesn't read)`);
    else if (m.v !== x.v) out.push(`in ${k.slice(0, 10)}: safe ${x.v} chain ${m.v}`);
  }
  for (const [k, x] of h.got) if (!s.got.has(k) && inside(x.date)) out.push(`in ${x.tok.slice(0, 10)} ${k.slice(0, 10)} ${x.v}: only on chain`);
  return out;
}
