// node tools/safelive.mjs: /safe's whole flow on a LIVE chain (Base Sepolia by default) against Safe's real
// Transaction Service, through src/safe/eth.ts. A P-256 key here plays the wedgie (it signs exactly what
// clawdbotatg/wedgie-safe's safe.py signs); a funded key plays the browser wallet, through cast.
//   1. a new Safe: the wedgie + the wallet, 2 of 2 (one transaction: signer contract + Safe)
//   2. the wallet proposes "add owner" to Safe's API (EIP-712, as the page's Add box does)
//   3. the wedgie confirms it there (a contract signature: Safe's API checks it on chain)
//   4. a transaction proposed by the wedgie itself (sender = its signer contract), confirmed by the wallet
//   5. both executed from Safe's API's confirmations (packSignatures), in nonce order
// Gas from SAFE_LIVE_KEY (a hex private key; never printed). CHAIN=84532 (default) or 8453. Needs cast.
//   SAFE_LIVE_KEY=$(...) node tools/safelive.mjs
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import * as E from "../src/safe/eth.ts";

const CH = { 84532: { rpc: "https://sepolia.base.org", key: "basesep" }, 8453: { rpc: "https://mainnet.base.org", key: "base" } };
const chain = +(process.env.CHAIN || 84532), { rpc: RPC, key: KEY } = CH[chain];
const PK = process.env.SAFE_LIVE_KEY;
if (!PK) throw new Error("SAFE_LIVE_KEY: a funded private key");
const api = `https://api.safe.global/tx-service/${KEY}/api/v1`;
// cast's errors quote its command line, key and all: rethrow only its stderr, without the key. A public RPC can lag
// a block on the nonce right after a send ("underpriced", "nonce too low"): try again.
function cast(...a) {
  for (let i = 0; ; i++) {
    try { return execFileSync("cast", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ETH_RPC_URL: RPC } }).trim(); }
    catch (e) {
      const why = String(e.stderr || "cast failed").split(PK).join("<key>").trim();
      if (i < 5 && /underpriced|nonce too low|already known/i.test(why)) { execFileSync("sleep", ["3"]); continue; }
      throw new Error(why);
    }
  }
}
const me = E.checksum(cast("wallet", "address", "--private-key", PK));
let fails = 0;
const ok = (c, what) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) fails++; };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Z = "0x" + "0".repeat(40);

async function get(path) { const r = await fetch(api + path); if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`); return r.json(); }
async function post(path, body) {
  const r = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
}
function send(to, data) {
  const r = JSON.parse(cast("send", "--private-key", PK, "--json", to, data));
  if (r.status !== "0x1" && r.status !== 1) throw new Error("reverted: " + r.transactionHash);
  return r;
}
const walletSig = (safe, t) => {
  const td = E.typedData(chain, safe, t);
  return E.ecdsa(cast("wallet", "sign", "--private-key", PK, "--data", JSON.stringify(td)));
};

// the wedgie
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64 = (s) => "0x" + Buffer.from(s, "base64url").toString("hex");
const key = { x: b64(jwk.x), y: b64(jwk.y) }, signer = E.signerAddress(key.x, key.y);
function wedgieSign(h) {
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const auth = Buffer.concat([sha("wedgie.dev"), Buffer.from("0500000000", "hex")]);
  const cdj = `{"type":"webauthn.get","challenge":"${Buffer.from(h.slice(2), "hex").toString("base64url")}","origin":"https://wedgie.dev"}`;
  const sig = crypto.sign(null, Buffer.concat([auth, sha(cdj)]), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return E.safeSignature(signer, { r: "0x" + sig.subarray(0, 32).toString("hex"), s: "0x" + sig.subarray(32).toString("hex"),
    authenticatorData: "0x" + auth.toString("hex"), clientDataFields: '"origin":"https://wedgie.dev"' });
}
console.log(`chain ${chain}, wallet ${me}, wedgie signer ${signer}`);

// 1. a new Safe
const r = send(E.MULTICALL3, E.newSafeData(key.x, key.y, [signer, me], 2, BigInt(Date.now())));
const log = r.logs.find((l) => eq(l.address, E.SAFE_FACTORY) && l.topics[0] === E.PROXY_CREATION);
const safe = E.checksum("0x" + log.topics[1].slice(26));
console.log(`     Safe ${safe} (tx ${r.transactionHash})`);
let info = null;
for (let i = 0; i < 40 && !info; i++) { try { info = await get(`/safes/${safe}/`); } catch { await sleep(3000); } }
ok(info && info.threshold === 2 && info.owners.length === 2 && info.owners.some((o) => eq(o, signer)), "1. Safe's API sees the new Safe: wedgie + wallet, 2 of 2");

const tx = (to, data, nonce, value = "0") => ({ to, value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce });

// 2. the wallet proposes adding an owner
const newbie = E.checksum(E.hex(crypto.randomBytes(20)));
const t0 = tx(safe, E.addOwnerData(newbie, 2), 0), h0 = E.safeTxHash(chain, safe, t0);
await post(`/safes/${safe}/multisig-transactions/`, { ...t0, contractTransactionHash: h0, sender: me, signature: walletSig(safe, t0), origin: "wedgie.dev/safe" });
ok(true, "2. the wallet proposed add owner (Safe's API took its signature)");

// 3. the wedgie confirms it
await post(`/multisig-transactions/${h0}/confirmations/`, { signature: wedgieSign(h0) });
let q0 = await get(`/multisig-transactions/${h0}/`);
ok(q0.confirmations.length === 2 && q0.confirmations.some((c) => eq(c.owner, signer)), `3. the wedgie's confirmation accepted (${q0.confirmations.map((c) => c.signatureType).join(", ")})`);

// 4. the wedgie proposes one (sender = its signer contract), the wallet confirms
const t1 = tx(newbie, "0x", 1, "1"), h1 = E.safeTxHash(chain, safe, t1);
await post(`/safes/${safe}/multisig-transactions/`, { ...t1, contractTransactionHash: h1, sender: signer, signature: wedgieSign(h1), origin: "wedgie.dev/safe" });
await post(`/multisig-transactions/${h1}/confirmations/`, { signature: walletSig(safe, t1) });
const pending = await get(`/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=0&ordering=nonce&limit=20`);
ok(pending.results.length === 2 && pending.results.every((t) => t.confirmations.length === 2), "4. the wedgie proposed one, the wallet confirmed it: 2 in the queue, both fully signed");

// 5. execute both from the API's confirmations, as the page's Execute does
cast("send", "--private-key", PK, "--value", "1", safe);
for (const t of pending.results) {
  const sigs = t.confirmations.map((c) => ({ owner: c.owner, signature: c.signature }));
  send(safe, E.execData(t, E.packSignatures(sigs)));
}
const os = cast("call", safe, "getOwners()(address[])");
ok(os.toLowerCase().includes(newbie.toLowerCase()), "5. add owner executed from the API's packed confirmations");
let bal = "0";
for (let i = 0; i < 10 && bal !== "1"; i++) { bal = cast("balance", newbie); if (bal !== "1") await sleep(2000); }   // a public RPC can be a block behind
ok(bal === "1", "5. the wedgie-proposed send executed");

console.log(fails ? `${fails} failed` : `all passed — https://app.safe.global/home?safe=${KEY}:${safe}`);
process.exit(fails ? 1 : 0);
