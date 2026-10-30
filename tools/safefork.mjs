// node tools/safefork.mjs: /safe's Ethereum on a Base fork (anvil), end to end, through the page's own
// src/safe/eth.ts. anvil's unlocked accounts play the browser wallet (eth_sendTransaction,
// eth_signTypedData_v4); a P-256 key here plays the wedgie, signing exactly what clawdbotatg/wedgie-safe's
// safe.py signs (webauthn_digest). Checks:
//   - the signer address eth.ts works out = the factory's getSigner
//   - a new Safe (one transaction: signer contract + Safe) with the wedgie + a wallet, 2 of 2
//   - the Safe tx hash eth.ts works out = the Safe's getTransactionHash
//   - adding an owner, signed by the wallet and the wedgie, packed by packSignatures, executed
//   - a wedgie-only Safe (1 of 1) runs a transaction on the wedgie's signature alone
//   - a Safe that owns a Safe: A (the wedgie's) approveHash-es B's tx, then B runs it (docs/PLAN-NESTED-SAFE.md)
// Needs anvil (foundry) and a Base RPC (BASE_RPC, default https://mainnet.base.org). Node 23+ (it imports .ts).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import * as E from "../src/safe/eth.ts";

const RPC = process.env.BASE_RPC || "https://mainnet.base.org", PORT = 8599, URL = `http://127.0.0.1:${PORT}`;
// fresh keys: anvil's default accounts are 7702 accounts on real Base
const anvil = spawn("anvil", ["--fork-url", RPC, "--port", String(PORT), "--mnemonic-random", "--hardfork", "osaka", "--silent"], { stdio: "inherit" });
process.on("exit", () => anvil.kill());
let id = 0;
async function rpc(method, params = []) {
  const r = await (await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
}
for (let i = 0; ; i++) { try { await rpc("eth_chainId"); break; } catch { if (i > 100) throw new Error("anvil didn't start"); await new Promise((r) => setTimeout(r, 200)); } }

let fails = 0;
const ok = (c, what) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) fails++; };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const Z = "0x" + "0".repeat(40);
const chain = Number(await rpc("eth_chainId"));
const [me] = await rpc("eth_accounts");
const view = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
async function send(to, data) {
  const h = await rpc("eth_sendTransaction", [{ from: me, to, data, gas: "0x1e8480" }]);
  let r = null;
  for (let i = 0; !r && i < 100; i++) { r = await rpc("eth_getTransactionReceipt", [h]); if (!r) await new Promise((res) => setTimeout(res, 100)); }
  if (r.status !== "0x1") throw new Error("reverted: " + h);
  return r;
}
const owners = async (safe) => {
  const b = E.bytes(await view(safe, E.selector("getOwners()")));
  const n = Number(BigInt(E.hex(b.slice(32, 64))));
  return Array.from({ length: n }, (_, i) => E.hex(b.slice(64 + 32 * i + 12, 96 + 32 * i)));
};
const word = async (to, sig, args = []) => BigInt(await view(to, E.call(sig, args)));

// ---- the wedgie: a P-256 key and safe.py's webauthn_digest ----
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64 = (s) => "0x" + Buffer.from(s, "base64url").toString("hex");
const key = { x: b64(jwk.x), y: b64(jwk.y) };
function wedgieSign(h) {
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const auth = Buffer.concat([sha("wedgie.dev"), Buffer.from("0500000000", "hex")]);
  const ch = Buffer.from(h.slice(2), "hex").toString("base64url");
  const cdj = `{"type":"webauthn.get","challenge":"${ch}","origin":"https://wedgie.dev"}`;
  const sig = crypto.sign(null, Buffer.concat([auth, sha(cdj)]), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { r: "0x" + sig.subarray(0, 32).toString("hex"), s: "0x" + sig.subarray(32).toString("hex"),
    authenticatorData: "0x" + auth.toString("hex"), clientDataFields: '"origin":"https://wedgie.dev"' };
}

const signer = E.signerAddress(key.x, key.y);
const got = await view(E.FACTORY, E.call("getSigner(uint256,uint256,uint176)", [E.word(key.x), E.word(key.y), E.word(E.VERIFIERS)]));
ok(eq("0x" + got.slice(26), signer), `signer address ${signer} = factory getSigner`);

async function makeSafe(list, th) {
  const r = await send(E.MULTICALL3, E.newSafeData(key.x, key.y, list, th, BigInt(Date.now())));
  const log = r.logs.find((l) => eq(l.address, E.SAFE_FACTORY) && l.topics[0] === E.PROXY_CREATION);
  return E.checksum("0x" + log.topics[1].slice(26));
}
const tx = (to, data, nonce) => ({ to, value: "0", data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce });

// 2 of 2: the wedgie and the wallet
const safe = await makeSafe([signer, E.checksum(me)], 2);
ok((await rpc("eth_getCode", [signer, "latest"])).length > 2, "the signer contract is deployed with the Safe");
const os = await owners(safe);
ok(os.length === 2 && os.some((o) => eq(o, signer)) && os.some((o) => eq(o, me)), `new Safe ${safe}: owners = wedgie + wallet`);
ok((await word(safe, "getThreshold()")) === 2n, "threshold 2");

const newbie = E.checksum(E.hex(crypto.randomBytes(20)));
const t = tx(safe, E.addOwnerData(newbie, 2), 0);
const h = E.safeTxHash(chain, safe, t);
const onChain = await view(safe, E.call("getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
  [E.aword(t.to), E.word(0), E.dynBytes(t.data), E.word(0), E.word(0), E.word(0), E.word(0), E.aword(Z), E.aword(Z), E.word(0)]));
ok(eq(h, onChain), "Safe tx hash = getTransactionHash");
const walletSig = E.ecdsa(await rpc("eth_signTypedData_v4", [me, JSON.stringify(E.typedData(chain, safe, t))]));
const sigs = [{ owner: me, signature: walletSig }, { owner: signer, signature: E.safeSignature(signer, wedgieSign(h)) }];
await send(safe, E.execData(t, E.packSignatures(sigs)));
ok((await owners(safe)).some((o) => eq(o, newbie)), "add owner: wallet + wedgie signatures, packed, executed");
ok((await word(safe, "nonce()")) === 1n, "nonce moved on");

// 1 of 1: the wedgie alone
const solo = await makeSafe([signer], 1);
await rpc("anvil_setBalance", [solo, "0xde0b6b3a7640000"]);
const t2 = { ...tx(newbie, "0x", 0), value: "1000" };
await send(solo, E.execData(t2, E.packSignatures([{ owner: signer, signature: E.safeSignature(signer, wedgieSign(E.safeTxHash(chain, solo, t2))) }])));
ok(BigInt(await rpc("eth_getBalance", [newbie, "latest"])) === 1000n, "wedgie-only Safe: sends ETH on the wedgie's signature");

// Instant Wallet's shape: the wedgie as two owners (other verifiers, other addresses) + a wallet, 3 of 3.
// One press signs for both slots (eth.ts signerAddresses).
const [, iw1, iw2] = E.signerAddresses(key.x, key.y);
for (const [a, v] of [[iw1, E.IW_VERIFIERS[0]], [iw2, E.IW_VERIFIERS[1]]]) {
  const g = await view(E.FACTORY, E.call("getSigner(uint256,uint256,uint176)", [E.word(key.x), E.word(key.y), E.word(v)]));
  ok(eq("0x" + g.slice(26), a), `Instant Wallet slot ${a} = factory getSigner`);
  await send(E.FACTORY, E.call("createSigner(uint256,uint256,uint176)", [E.word(key.x), E.word(key.y), E.word(v)]));
}
const iw = await makeSafe([iw1, iw2, E.checksum(me)], 3);
await rpc("anvil_setBalance", [iw, "0xde0b6b3a7640000"]);
const t4 = { ...tx(newbie, "0x", 0), value: "2000" };
const h4 = E.safeTxHash(chain, iw, t4), g4 = wedgieSign(h4);
const w4 = E.ecdsa(await rpc("eth_signTypedData_v4", [me, JSON.stringify(E.typedData(chain, iw, t4))]));
await send(iw, E.execData(t4, E.packSignatures([{ owner: me, signature: w4 }, ...[iw1, iw2].map((a) => ({ owner: a, signature: E.safeSignature(a, g4) }))])));
ok(BigInt(await rpc("eth_getBalance", [newbie, "latest"])) === 3000n, "Instant Wallet shape: one wedgie press for both slots + the wallet sends ETH");

// a wrong wedgie signature must not pass
const t3 = { ...t2, nonce: 1 };
const bad = wedgieSign(E.safeTxHash(chain, solo, t2));          // signed the old nonce
let refused = false;
try { await send(solo, E.execData(t3, E.packSignatures([{ owner: signer, signature: E.safeSignature(signer, bad) }]))); } catch { refused = true; }
ok(refused, "a signature for another transaction is refused on chain");

// a Safe owns a Safe: B = A (the wedgie's 1 of 1) + the wallet, 2 of 2. A approves B's tx hash on chain (a normal A tx
// the wedgie signs); the wallet signs; anyone sends B's tx with A's v=1 signature
const nest = await makeSafe([solo, E.checksum(me)], 2);
await rpc("anvil_setBalance", [nest, "0xde0b6b3a7640000"]);
const t5 = { ...tx(newbie, "0x", 0), value: "4000" }, h5 = E.safeTxHash(chain, nest, t5);
const a5 = tx(nest, E.approveHashData(h5), Number(await word(solo, "nonce()")));
await send(solo, E.execData(a5, E.packSignatures([{ owner: signer, signature: E.safeSignature(signer, wedgieSign(E.safeTxHash(chain, solo, a5))) }])));
ok((await word(nest, "approvedHashes(address,bytes32)", [E.aword(solo), E.bytes(h5)])) === 1n, "Safe A approveHash-es Safe B's tx (wedgie signs A's tx)");
const w5 = E.ecdsa(await rpc("eth_signTypedData_v4", [me, JSON.stringify(E.typedData(chain, nest, t5))]));
await send(nest, E.execData(t5, E.packSignatures([{ owner: me, signature: w5 }, { owner: solo, signature: E.approvedSig(solo) }])));
ok(BigInt(await rpc("eth_getBalance", [newbie, "latest"])) === 7000n, "Safe B runs on the wallet + Safe A's on-chain approval");

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
