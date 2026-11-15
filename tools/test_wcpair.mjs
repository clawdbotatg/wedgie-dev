// /safe's WalletConnect connects only the app whose link was pasted (audit 11-13, PAGE-5). An app paired earlier
// keeps its pairing and can send a new proposal any time: the one that arrived first in the 30 s after a paste was
// approved for this Safe, unseen, and the page said "Connected." with no name. Now a proposal must come from the
// pasted link's own pairing, one WalletConnect flags is refused, and the page says who it connected.
//   node tools/test_wcpair.mjs
import { createServer } from "vite";
globalThis.location = { origin: "https://wedgie.dev" };
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const wc = await vs.ssrLoadModule("/src/safe/walletconnect.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };

const SAFE = "0x" + "11".repeat(20), GOOD = "aa".repeat(32), OLD = "bb".repeat(32);
const uri = `wc:${GOOD}@2?relay-protocol=irn&symKey=${"cc".repeat(32)}`;
const proposal = (id, topic, name, verified) => ({ id, verifyContext: verified && { verified },
  params: { id, pairingTopic: topic, expiryTimestamp: Math.floor(Date.now() / 1000) + 300, proposer: { publicKey: "x", metadata: { name, url: `https://${name.toLowerCase()}.example`, icons: [] } },
    requiredNamespaces: {}, optionalNamespaces: { eip155: { chains: ["eip155:8453"], methods: ["eth_sendTransaction"], events: ["chainChanged"] } }, relays: [] } });
function fake(send) {
  const k = { approved: [], rejected: [], sessions: {}, on() {},
    async pair() { setTimeout(() => send(k), 10); },
    async rejectSession({ id }) { k.rejected.push(id); },
    async approveSession({ id }) { k.approved.push(id); const topic = "s" + id; k.sessions[topic] = { acknowledged: true, peer: { metadata: { name: "x" } }, namespaces: {} }; return { topic }; },
    getActiveSessions: () => k.sessions, async disconnectSession() {} };
  return k;
}
const run = async (send) => {
  const k = fake(send);
  wc._useKit(k);
  let said = null, err = null;
  try { said = await wc.pair(uri, SAFE, 8453); } catch (e) { err = e.message; }
  return { k, said, err };
};
const P = wc._onProposal;

// 1. an app paired earlier gets its proposal in first
let r = await run(async (k) => { await P(k, proposal(1, OLD, "Evil")); await P(k, proposal(2, GOOD, "Uniswap")); });
check(!r.k.approved.includes(1) && r.k.rejected.includes(1), `a proposal from another pairing, arriving first, is refused (approved: ${r.k.approved})`);
check(r.k.approved.includes(2) && !r.err, `the pasted link's own proposal still connects (${r.err || "connected"})`);
check(r.said?.name === "Uniswap" && /uniswap\.example/.test(r.said?.url || ""), `pair() says who it connected (${JSON.stringify(r.said)})`);
// 2. WalletConnect flags the site
r = await run(async (k) => { await P(k, proposal(3, GOOD, "Scam", { isScam: true, validation: "VALID", origin: "https://scam.example" })); });
check(!r.k.approved.length && !!r.err, `a site WalletConnect calls a scam isn't connected (${r.err})`);
r = await run(async (k) => { await P(k, proposal(4, GOOD, "Fake", { validation: "INVALID", origin: "https://fake.example" })); });
check(!r.k.approved.length && !!r.err, `a site that isn't the domain it claims isn't connected (${r.err})`);
// 3. nothing pasted: every proposal is refused, as before
const k = fake(() => {});
wc._useKit(k);
await P(k, proposal(5, OLD, "Evil"));
check(!k.approved.length && k.rejected.includes(5), "with no link pasted, a proposal is refused");
check(await wc.pair("https://x", SAFE, 8453).then(() => false, () => true), "something that isn't a wc: link is refused");

await vs.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
