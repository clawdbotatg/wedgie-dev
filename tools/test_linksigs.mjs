// A link's signatures count only for the owner each one is really from (audit 11-13, PAGE-6). A #tx= link lists
// [owner, signature] pairs; the label was trusted. One valid signature listed three times under three owners passed
// the Safe's check three times (each alone), so the queue said "3 of 3 · Ready" for a tx that reverts on chain.
// signerOf() reads the real owner from the signature, by Safe's own rules; a pair whose label differs is dropped.
//   node tools/test_linksigs.mjs
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const E = await vs.ssrLoadModule("/src/safe/eth.ts");
const S = await vs.ssrLoadModule("/src/safe/signer.ts").catch((e) => ({ err: e.message }));
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };

const key = secp256k1.utils.randomPrivateKey();          // made here, used once
const pub = secp256k1.getPublicKey(key, false);
const me = E.checksum(E.hex(E.keccak256(pub.slice(1)).slice(-20)));
const other = "0x" + "22".repeat(20), wedgie = "0x" + "33".repeat(20);
const h = "0x" + "ab".repeat(32);
const sign = (hashHex, add) => { const s = secp256k1.sign(E.bytes(hashHex), key); return E.hex(E.cat(s.toCompactRawBytes(), new Uint8Array([s.recovery + add]))); };
const plain = sign(h, 27);
const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const of = (sig) => { try { return S.signerOf(h, sig); } catch (e) { return "threw: " + e.message; } };

check(eq(of(plain), me), `an owner's wallet signature is read as that owner's (${of(plain)})`);
check(!eq(of(plain), other) && !eq(of(plain), wedgie), "and as nobody else's");
const prefixed = E.hex(E.keccak256(E.cat(new TextEncoder().encode("\x19Ethereum Signed Message:\n32"), E.bytes(h))));
check(eq(of(sign(prefixed, 31)), me), `an eth_sign signature (v 31/32) too (${of(sign(prefixed, 31))})`);
check(eq(of(E.approvedSig(other)), other), "an approved hash names its owner in r");
const contract = E.hex(E.cat(E.bytes("0x" + "00".repeat(12) + wedgie.slice(2)), E.word(65), new Uint8Array([0]), E.word(2), new Uint8Array([1, 2])));
check(eq(of(contract), wedgie), `a contract signature (the wedgie's signer) names its owner in r (${of(contract)})`);
check(of("0x1234") === null && of(plain.slice(0, -2) + "05") === null, "a signature that doesn't read is nobody's");
// the attack: one signature under three labels -> one owner
const link = [[me, plain], [other, plain], [wedgie, plain]].map(([owner, signature]) => ({ owner, signature }));
const kept = S.ownSigs ? S.ownSigs(h, link) : link;
check(kept.length === 1 && eq(kept[0].owner, me), `one signature listed under three owners counts once, for its own (${kept.length} kept)`);
check((S.ownSigs ? S.ownSigs(h, [...link, { owner: me, signature: plain }]) : []).length === 1, "and an owner listed twice counts once");
const page = readFileSync("src/pages/safe.ts", "utf8");
const take = page.slice(page.indexOf("async function takeLink("), page.indexOf("async function takeLink(") + 2500);
check(/ownSigs\(/.test(take) && take.indexOf("ownSigs(") < take.indexOf("checkNSignatures"), "takeLink drops the others before it asks the Safe");

await vs.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
