// wedgie.dev/safe says what a Safe tx does (src/safe/describe.ts). What it says must be what the chain runs
// (audit 11-13): a batch is only a DELEGATECALL to one of Safe's own MultiSend contracts, read the one way it's
// always written; a tx whose fields aren't whole bytes and plain numbers is refused (src/safe/eth.ts strictTx).
//   node tools/test_describe.mjs
import { createServer } from "vite";
import fs from "node:fs";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const D = await vs.ssrLoadModule("/src/safe/describe.ts");
const E = await vs.ssrLoadModule("/src/safe/eth.ts");
let bad = 0;
const ok = (c, what, got) => { bad += c ? 0 : 1; console.log(c ? "ok  " : "FAIL", what, c || got === undefined ? "" : JSON.stringify(got, (_, v) => typeof v === "bigint" ? String(v) : v)); };
const throws = (f) => { try { f(); return false; } catch { return true; } };

const SAFE = "0x1111111111111111111111111111111111111111", USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BOB = "0x2222222222222222222222222222222222222222", EVIL = "0x000000000000000000000000000000000000dEaD";
const ctx = { safe: SAFE, addr: (a) => a, token: (a) => a.toLowerCase() === USDC.toLowerCase() ? { symbol: "USDC", decimals: 6 } : null, owners: 2 };
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const transfer = (to, n) => E.call("transfer(address,uint256)", [E.aword(to), E.word(n)]);
const send = { to: USDC, value: 0n, data: transfer(BOB, 1_000_000n) };
const drain = { to: USDC, value: 0n, data: transfer(EVIL, 999_000_000n) };
const tx = (to, data, operation = 1) => ({ to, value: "0", data, operation });
const say = (t) => D.describe(t, ctx);
const all = (s) => [s.title, ...(s.subs || []).map((x) => x.title)].join(" | ");
const good = E.multiSendData([send]);
const blob = (calls) => E.multiSendData(calls).slice(10 + 64);   // length word, packed calls, padding

// 1. a DELEGATECALL to anything but Safe's MultiSend is never a batch, whatever its data looks like
let s = say(tx(EVIL, good));
ok(s.kind === "danger" && !s.subs && /Delegate call to 0x0{36}dEaD/.test(s.title), "1 a delegatecall to a stranger with batch-shaped data: danger, not a batch", s);
// 2. the real ones still open
s = say(tx(E.MULTISEND_CALL_ONLY, good));
ok(s.kind === "batch" && /Send 1 USDC to 0x2222/.test(all(s)), "2 MultiSendCallOnly 1.4.1: a batch", s);
for (const a of D.MULTISENDS ?? []) ok(say(tx(a, good)).kind === "batch", `2 ${a}: a batch`);
// the page's list is the wedgie's (wedgie-safe safe_read.py MULTISEND), when that checkout is here
const dev = "../wedgie-safe/safe_read.py";
if (fs.existsSync(dev)) {
  const m = /MULTISEND = \(([^)]*)\)/.exec(fs.readFileSync(dev, "utf8"));
  const theirs = (m?.[1].match(/0x[0-9a-f]{40}/g) || []).sort().join();
  ok(theirs === [...(D.MULTISENDS ?? [])].sort().join(), "2 the page's MultiSend list is the wedgie's", theirs);
}
// 3. the offset word points past a decoy: MultiSend runs what's there, so the page must not read the decoy
const tricked = "0x8d80ff0a" + w(32 + blob([send]).length / 2) + blob([send]) + blob([drain]);
s = say(tx(E.MULTISEND_CALL_ONLY, tricked));
ok(s.kind === "danger" && /can't read/.test(s.title) && !/Send 1 USDC/.test(all(s)), "3 a decoy at 0x20, the real calls where the offset points: can't read", all(s));
// 4-6
s = say(tx(E.MULTISEND_CALL_ONLY, good + "00".repeat(32)));
ok(s.kind === "danger" && /can't read/.test(s.title), "4 extra bytes after the batch: can't read", all(s));
s = say(tx(E.MULTISEND_CALL_ONLY, good.slice(0, -64)));
ok(s.kind === "danger" && /can't read/.test(s.title), "5 a last call that runs past the end: can't read", all(s));
const op = (n) => good.slice(0, 10 + 128) + "0" + n + good.slice(10 + 130);
s = say(tx(E.MULTISEND_CALL_ONLY, op(2)));
ok(s.kind === "danger" && /can't read/.test(s.title), "6 an inner operation 2: can't read", all(s));
s = say(tx(E.MULTISEND_CALL_ONLY, "0x8d80ff0a" + w(32) + w(0)));
ok(s.kind === "danger", "6 an empty batch: danger", all(s));
// 7. unchanged
s = say(tx(E.MULTISEND_CALL_ONLY, op(1)));
ok(s.kind === "danger" && /Delegate call/.test(all(s)), "7 an inner delegatecall: danger, named", all(s));
ok(say(tx(USDC, send.data, 0)).kind === "send" && say(tx(SAFE, "0x", 0)).kind === "cancel", "7 a plain send and a cancel read as before");

// 8. strict fields at every way in
const Z = "0x0000000000000000000000000000000000000000";
const base = { to: USDC, value: "0", data: send.data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce: 7 };
const strict = E.strictTx ?? ((t) => t);
ok(!throws(() => strict(base)) && E.safeTxHash(1, SAFE, strict(base)) === E.safeTxHash(1, SAFE, base), "8 a good tx passes, same hash");
ok(!throws(() => strict({ ...base, data: null, nonce: "7", value: 5 })) && strict({ ...base, data: null }).data === "0x", "8 no data is 0x; a number or a digit string is fine");
for (const [what, t] of [
  ["data with no 0x", { ...base, data: send.data.slice(2) }],
  ["odd-length data", { ...base, data: send.data.slice(0, -1) }],
  ["data that isn't hex", { ...base, data: "0xzz" }],
  ["operation 2", { ...base, operation: "2" }],
  ["a 22-byte gasToken", { ...base, gasToken: Z + "0000" }],
  ["a refundReceiver that isn't an address", { ...base, refundReceiver: "0x12" }],
  ["a to that isn't an address", { ...base, to: "bob" }],
  ["nonce <img src=x>", { ...base, nonce: "<img src=x>" }],
  ["nonce 1e3", { ...base, nonce: "1e3" }],
  ["value -1", { ...base, value: "-1" }],
  ["value 0x10", { ...base, value: "0x10" }],
  ["safeTxGas 1.5", { ...base, safeTxGas: 1.5 }],
  ["a value past 2^256", { ...base, value: (2n ** 256n).toString() }],
]) ok(throws(() => strict(t)), `8 ${what}: refused`);

ok(strict({ ...base, refundReceiver: undefined, gasToken: null }).refundReceiver === Z, "8 a gasToken or refundReceiver left out is the zero address");

// 9. every batch the page builds opens back up as itself
const five = [send, drain, { to: BOB, value: 5n, data: "0x" }, { to: SAFE, value: 0n, data: "0x1234" }, send];
for (const calls of [[send], [send, drain], five]) {
  const back = D.unbatch(E.multiSendData(calls));
  ok(back.length === calls.length && back.every((c, i) => c.operation === 0 && c.to.toLowerCase() === calls[i].to.toLowerCase() && c.value === calls[i].value && c.data === calls[i].data), `9 the page's own batch of ${calls.length} opens back up`, back);
}

await vs.close();
console.log(bad ? bad + " FAILED" : "all ok");
process.exit(bad ? 1 : 0);
