// The Safe signer app (clawdbotatg/wedgie-safe) on a virtual RP2040 (rp2040js, the real MicroPython build
// and its real heap: tools/rp2040/chip.mjs), the way /safe drives it: hello (its key), then safe_sign for
// a plain send, an add owner (of itself), a removal, and a MultiSend batch as big as /safe lets through
// (one USB line just under 6 KB, a page per action), A pressed through every page; and one answered Y.
// The virtual chip has no Trust M, so a yes ends in the app's error answer at the chip step; everything
// before it (parsing, the Safe tx hash in pure-Python keccak, the decode, the screens) runs for real.
// A MemoryError, a traceback, "wedgie broke" or no answer fails it. Prints the least free heap seen.
//   node tools/safechip.mjs [--app <wedgie-safe checkout>] [--shot <file.png>]   (default: the shelf's copy
//   in community/; --shot: its home screen)
// Needs uv (the flash image: littlefs-python).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";
import * as E from "../src/safe/eth.ts";

const args = process.argv.slice(2);
const appDir = args.includes("--app") ? args[args.indexOf("--app") + 1] : null;
const F = firmware();
if (appDir) {               // a local checkout instead of the shelf's copy: its wedgie.json, its files
  const a = JSON.parse(readFileSync(join(appDir, "wedgie.json"), "utf8")).apps[0];
  const i = F.carts.findIndex((c) => c.mod === "safe");
  if (i >= 0) F.carts.splice(i, 1);
  F.app(a, Object.fromEntries(a.files.filter((n) => existsSync(join(appDir, n))).map((n) => [n, readFileSync(join(appDir, n))])));
}
const cart = F.carts.find((c) => c.mod === "safe");
console.log(`Safe signer (${appDir || "the shelf's copy"}): ${cart.files.join(" ")}`);

// a key, as the app saves it after making one in the chip (the public half only matters here)
const key = { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32) };
const signer = E.signerAddress(key.x, key.y);
const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|wedgie broke/;
// a traceback that isn't the expected one: the chip step on a board with no Trust M (trustm.py)
const crash = (out) => BAD.test(out) || out.split("Traceback").slice(1).some((t) => !/OSError: trustm/.test(t.split("\n{")[0]));
let all = "", failed = 0, least = Infinity, leastWhere = "";
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const h = host({ fs: image(F, "safe", { "saves/safe/key.json": Buffer.from(JSON.stringify(key)) }), onData: (b) => { all += Buffer.from(b).toString("latin1"); } });
for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);
const press = (k) => { const p = h.chip.mcu.gpio[KEYS[k]]; p.setInputValue(false); h.chip.run(150); p.setInputValue(true); h.chip.run(100); };
let id = 100;
const ram = (where) => {
  const r = h.req({ type: "hello", id: ++id }, 8000);
  if (typeof r?.ram === "number" && r.ram < least) { least = r.ram; leastWhere = where; }
  return r;
};
if (!h.until((b) => b.includes('"ready"'), 30000, 20)) { console.log("no ready line:", JSON.stringify(h.out.slice(-400))); process.exit(1); }
h.chip.run(1500);
const hi = ram("started, its key loaded");
check(hi?.running === "safe" && hi?.safe?.x === key.x, `hello: running safe, its key (${hi?.ram} B free)`);
if (hi?.signer !== undefined) check(E.checksum(hi.signer || "0x0") === signer, `hello: its signer address ${hi.signer} = /safe's (${signer})`);

if (args.includes("--shot")) {           // the home screen, from the slot's shot answer (rgb565, big-endian)
  const rid = ++id, parts = [];
  h.chip.write(JSON.stringify({ id: rid, type: "shot" }) + "\n");
  h.until((b) => { const L = b.split("\n").filter((l) => l.includes(`"id": ${rid}`)); return L.length && JSON.parse(L[0]).n === L.length; }, 30000, 20);
  for (const l of h.out.split("\n").filter((l) => l.includes(`"id": ${rid}`))) parts.push(JSON.parse(l));
  const px = Buffer.concat(parts.sort((a, b) => a.i - b.i).map((p) => Buffer.from(p.data, "base64"))), W = parts[0].w, H = parts[0].h;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(args[args.indexOf("--shot") + 1], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  h.take();
}

{ // its list of Safes (wedgie-safe safe-4+): safe_note adds, newest first, no duplicates; safe_list reads it
  const l0 = h.req({ id: ++id, type: "safe_list" }, 8000);
  if (l0?.type === "safe_list") {
    const a1 = "0x" + "a1".repeat(20), a2 = "0x" + "b2".repeat(20);
    const n1 = h.req({ id: ++id, type: "safe_note", chainId: 8453, safe: a1 }, 8000);
    h.req({ id: ++id, type: "safe_note", chainId: 84532, safe: a2 }, 8000);
    h.req({ id: ++id, type: "safe_note", chainId: 8453, safe: a1.toUpperCase().replace("0X", "0x") }, 8000);
    const bad = h.req({ id: ++id, type: "safe_note", chainId: 8453, safe: "0x12" }, 8000);
    const l = h.req({ id: ++id, type: "safe_list" }, 8000);
    check(n1?.type === "ok" && bad?.type === "error" && JSON.stringify(l?.safes) === JSON.stringify([`8453:${a1}`, `84532:${a2}`]),
      `safe_note / safe_list: ${JSON.stringify(l?.safes)} (newest first, no duplicates, a bad address refused)`);
  } else console.log("     (no safe_list: an older app)");
}

const Z = "0x" + "0".repeat(40), safe = "0x" + "5a".repeat(20), usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const tx = (to, data, value = "0") => ({ chainId: 8453, safe, to, value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce: 3 });
// a MultiSend batch of USDC sends, as big as fits one line
const pack = (calls) => E.call("multiSend(bytes)", [E.dynBytes(E.cat(...calls.map((c) => E.cat(new Uint8Array([0]), E.bytes(c.to), E.word(0), E.word(E.bytes(c.data).length), E.bytes(c.data)))))]);
let n = 1, batch;
for (;;) {
  const calls = Array.from({ length: n + 1 }, (_, i) => ({ to: usdc, data: E.transferData("0x" + (i + 1).toString(16).padStart(40, "0"), 1000000n * BigInt(i + 1)) }));
  const t = { ...tx("0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", pack(calls)), operation: 1 };
  if (JSON.stringify({ id: 1000, type: "safe_sign", tx: t }).length > 6000) break;
  batch = t; n++;
}
const cases = [
  ["send 0.5 ETH", tx("0x" + "77".repeat(20), "0x", "500000000000000000"), 1],
  ["add owner: itself", tx(safe, E.addOwnerData(signer, 2)), 1],
  ["remove owner: itself", tx(safe, E.removeOwnerData(E.SENTINEL, signer, 1)), 1],
  [`MultiSend batch, ${n} USDC sends (${JSON.stringify(batch).length} B line)`, batch, n + 1],
];
/** Send one safe_sign, press k once a second (the app drops presses made before its question is up) until
 *  it answers; the answer and how long it took in chip time. */
function ask(t, k) {
  const rid = ++id, t0 = h.chip.ms;
  h.chip.write(JSON.stringify({ id: rid, type: "safe_sign", tx: t }) + "\n");
  let got = null;
  const re = new RegExp(`\\{[^\\n]*"id": ${rid}[,}][^\\n]*\\n`);
  for (let s = 0; s < 240 && !got; s++) {
    h.until((b) => { const m = b.match(re); if (m) got = JSON.parse(m[0]); return !!m; }, 1000, 20);
    if (!got) press(k);
  }
  return { got, secs: ((h.chip.ms - t0) / 1000).toFixed(1) };
}
for (const [what, t, pages] of cases) {
  const before = all.length;
  const { got, secs } = ask(t, "A");
  const out = all.slice(before);
  if (!got) console.log("     no answer; it said:", JSON.stringify(out.slice(-800)));
  const r = ram(what);
  // a yes reaches the chip step: no Trust M here, so the app answers its error (anything but a crash)
  const chipStep = got?.type === "safe_sig" || /trustm/.test(got?.error || "");
  check(chipStep && !crash(out), `${what}: ${pages} page(s), A through them, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 40) + ")" : "") : "nothing"} · ${r?.ram} B free`);
}
if (hi?.safe_chunk) {     // a transaction over the 6 KB line: its data in safe_data pieces first, then "@"
  for (const size of (process.env.SIZES || "8000,12000").split(",").map(Number)) {
    const data = "0x12345678" + "ab".repeat(size - 4), before = all.length;
    let okp = true, at = 0;
    for (let o = 2; o < data.length; o += hi.safe_chunk) {
      const hex = data.slice(o, o + hi.safe_chunk);
      const r = h.req({ id: ++id, type: "safe_data", at, hex }, 20000);
      at += hex.length / 2;
      if (r?.type !== "safe_data" || r.have !== at) { okp = false; if (size <= 8000) console.log("     piece:", JSON.stringify(r)); break; }
    }
    const { got, secs } = okp ? ask({ ...tx("0x" + "66".repeat(20), "@"), data: "@" }, "A") : { got: null, secs: 0 };
    const r = ram(`a ${size} B tx in pieces`);
    const chipStep = got?.type === "safe_sig" || /trustm/.test(got?.error || "");
    if (size > (hi.safe_max || 8000)) { check(!okp && !crash(all.slice(before)), `a ${size} B transaction: refused as too big, no crash`); continue; }
    check(okp && chipStep && !crash(all.slice(before)), `a ${size} B transaction in ${Math.ceil(size * 2 / hi.safe_chunk)} safe_data pieces, then signed, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 40) + ")" : "") : "nothing"} · ${r?.ram} B free`);
  }
}
{ // and a no
  const before = all.length;
  const { got, secs } = ask(cases[0][1], "Y");
  check(got?.type === "refused" && !crash(all.slice(before)), `Y says no: answered ${got?.type} (${secs} s)`);
}
if (crash(all)) console.log("     output:", all.slice(-1500));
console.log(`     least free heap seen: ${least} bytes (${leastWhere})`);
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
