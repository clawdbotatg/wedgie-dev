// node tools/safecompare.mjs [chain:safe ...]: /safe's chain readers (src/safe/history.ts) against Safe's API, on
// real Safes. With no Safes given: the ones that ran something lately on each chain (their ExecutionSuccess logs).
// Compares history (what Activity shows: transactions run, coin and USDC in), and the creation (copy to another chain).
// Alchemy (ALCHEMY_API_KEY or SHOP_RPC_1 in .env) and Safe's API (SAFE_API_KEY) direct. PER=<n> Safes a chain (3).
import fs from "node:fs";
import * as H from "../src/safe/history.ts";
import * as E from "../src/safe/eth.ts";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")
  .map((l) => l.match(/^([A-Z0-9_]+)=["']?(.*?)["']?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const KEY = env.ALCHEMY_API_KEY || (env.SHOP_RPC_1 || "").match(/v2\/([\w-]+)/)?.[1];
const CH = { 8453: ["base-mainnet", "base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], 1: ["eth-mainnet", "eth", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  10: ["opt-mainnet", "oeth", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"], 42161: ["arb-mainnet", "arb1", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
  137: ["polygon-mainnet", "pol", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"], 56: ["bnb-mainnet", "bnb", ""] };
const rpc = (c) => async (method, params) => {
  for (let i = 0; ; i++) {
    const r = await fetch(`https://${CH[c][0]}.g.alchemy.com/v2/${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429 && i < 5) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
};
const safeApi = async (c, path) => {
  const r = await fetch(`https://api.safe.global/tx-service/${CH[c][1]}/api/v1/${path}`, { headers: env.SAFE_API_KEY ? { Authorization: `Bearer ${env.SAFE_API_KEY}` } : {} });
  if (!r.ok) throw new Error(`Safe's API ${r.status}`);
  return r.json();
};
const lc = (s) => String(s || "").toLowerCase();

async function compare(c, safe) {
  const usdc = CH[c][2];
  const [svc, chain] = await Promise.all([safeApi(c, `safes/${safe}/all-transactions/?executed=true&queued=false&limit=25`),
    H.chainHistory(rpc(c), c, safe, usdc || undefined).then((r) => r, (e) => ({ err: e.message }))]);
  if (chain.err) return [`chain: ${chain.err}`];
  const out = H.diffHistory(c, svc.results, chain, safe, usdc || undefined);
  try {
    const [a, b] = await Promise.all([safeApi(c, `safes/${safe}/creation/`), H.chainCreation(rpc(c), safe)]);
    if (lc(a.transactionHash) !== lc(b.transactionHash) || lc(a.factoryAddress) !== lc(b.factoryAddress))
      out.push(`creation: safe ${a.transactionHash} ${a.factoryAddress} chain ${b.transactionHash} ${b.factoryAddress}`);
  } catch (e) { out.push(`creation: ${e.message}`); }
  return out;
}

const OK = E.hex(E.keccakText("ExecutionSuccess(bytes32,uint256)"));
async function recent(c, per) {
  const b = Number(await rpc(c)("eth_blockNumber", []));
  const logs = await rpc(c)("eth_getLogs", [{ topics: [OK], fromBlock: "0x" + (b - 2000).toString(16), toBlock: "latest" }]);
  return [...new Set(logs.map((l) => l.address))].slice(0, per).map((a) => `${c}:${a}`);
}

const PER = +(process.env.PER || 3);
const list = process.argv.slice(2).length ? process.argv.slice(2) : (await Promise.all(Object.keys(CH).map((c) => recent(+c, PER).catch(() => [])))).flat();
let bad = 0;
for (const k of list) {
  const [c, a] = k.split(":"), safe = E.checksum(a);
  const t0 = Date.now();
  let r;
  try { r = await compare(+c, safe); } catch (e) { r = [`error: ${e.message}`]; }
  const real = r.filter((x) => !x.startsWith("("));
  if (real.length) bad++;
  console.log(`${real.length ? "DIFF" : "same"} ${k} (${Date.now() - t0} ms)${r.map((x) => "\n    " + x).join("")}`);
}
console.log(`${list.length - bad}/${list.length} the same`);
