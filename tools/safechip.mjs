// The Safe Signer app (clawdbotatg/wedgie-safe) on a virtual RP2040 (rp2040js, the real MicroPython build
// and its real heap: tools/rp2040/chip.mjs), the way /safe drives it: hello (its key), then safe_sign for
// a plain send, an add owner (of itself), a removal, and a MultiSend batch as big as /safe lets through
// (one USB line just under 6 KB, a page per action, no intro page), A pressed through every page; and one answered Y.
// The virtual chip has no secure chip, so a yes ends in the app's error answer at the chip step; everything
// before it (parsing, the Safe tx hash in pure-Python keccak, the decode, the screens) runs for real.
// A MemoryError, a traceback, "wedgie broke" or no answer fails it. Prints the least free heap seen.
//   node tools/safechip.mjs [--app <wedgie-safe checkout>] [--shot <file.png>] [--shots <dir>] [--txs <file.json>]
//   (default: the shelf's copy in community/; --shot: its home screen; --shots: every page of every case, as the
//   panel got it; --txs: only these, with their clear-signing bundles: tools/clear_txs.py makes them from the registry;
//   --clear <dir>: a wire/release.py output to take bundles from, for an --app whose safe_roots.py it made)
// 0.3.54+: a locked wedgie refuses shot (slot.py), so the Bunker/--shot screens need firmware older than 0.3.54. Open item.
// Needs uv (the flash image: littlefs-python).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";
import * as E from "../src/safe/eth.ts";
import * as Clear from "../src/safe/clear.ts";

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
// --frag [bytes]: once the app has started, fill the heap and free it again in holes of that size (default 6144),
// with a small block kept between each two. A heap after hours of use, at its worst: no allocation after the start
// can be bigger than a hole. A pass means it works on any heap, not on this build's luck (10-28: one more sector in
// the WEDGIE drive, or 3 lines in slot.py, made an 8 KB transaction fail; the build before passed).
const fragAt = args.indexOf("--frag");
if (fragAt >= 0) {
  const size = Number(args[fragAt + 1]) || 6144;
  const src = F.file("safe.py").toString();
  const start = '    _keep()\n    W.send(W.hello(None, type="ready"';
  if (!src.includes(start) || !src.includes("\ndef run():")) throw new Error("--frag: safe.py's run() changed; update safechip");
  F.extra["safe.py"] = Buffer.from(src.replace("\ndef run():", `
_held = []


def _frag():
    gc.collect()
    big = []
    try:
        while True:
            big.append(bytearray(${size}))
            _held.append(bytearray(16))
    except MemoryError:
        pass
    big = None
    gc.collect()
    print("frag: holes of ${size} B, %d B free" % gc.mem_free())


def run():`).replace(start, '    _keep()\n    _frag()\n    W.send(W.hello(None, type="ready"'));
  console.log(`--frag: the heap in ${size} B holes once the app has started`);
}
console.log(`Safe Signer (${appDir || "the shelf's copy"}): ${cart.files.join(" ")}`);

// The virtual board has no secure chip, so atecc.mpy is swapped for a stand-in ATECC608 whose slot 0 holds a
// locked key (the public half only matters here) and can't sign. The key's real paths, on a fake Trust M and
// a fake ATECC608 with real chips' rules: tools/test_safekey.py.
const key = { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32), chip: "ATECC608" };
const ATECC = `OP_LOCK = 0x17
CONFIG = bytes(20) + b"\\xaf\\x2f" + bytes(74) + b"\\x33\\x00" + bytes(30)
class ATECC608:
    def __init__(self, sda=None, scl=None):
        pass
    def wake(self):
        pass
    def sleep(self):
        pass
    def read_config(self, b):
        c = bytearray(CONFIG)
        c[86] = c[87] = 0
        c[88], c[89] = 0xFE, 0xFF
        return bytes(c[b * 32:b * 32 + 32])
    def lock_state(self):
        return {"configLocked": True, "dataLocked": True}
    def pubkey(self, slot=0):
        return 0x${"11".repeat(32)}, 0x${"22".repeat(32)}
    def sign(self, digest, slot=0):
        raise OSError("the key is in an ATECC608 and none answered")
`;
const signer = E.signerAddress(key.x, key.y);
const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|wedgie broke/;
// a traceback that isn't the expected one: the chip step on a board with no chip (trustm.py, or no ATECC608)
const crash = (out) => BAD.test(out) || out.split("Traceback").slice(1).some((t) => !/OSError: (trustm|the key is in an ATECC608)/.test(t.split("\n{")[0]));
let all = "", failed = 0, least = Infinity, leastWhere = "";
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const h = host({ fs: image(F, "safe", { "atecc.py": Buffer.from(ATECC) }, ["atecc.mpy"]), onData: (b) => { all += Buffer.from(b).toString("latin1"); } });
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

const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
/** px (RGB565, big-endian) as a PNG at file. */
function png(file, px, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
// --shots: the ST7789 on SPI1 (DC on GP8), read off the wire as src/chip/sim.ts does (a locked wedgie refuses shot)
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const frame = Buffer.alloc(240 * 240 * 2);
if (shots) {
  const spi = h.chip.mcu.spi[1], dc = h.chip.mcu.gpio[8], lcd = { cmd: 0, args: [], xs: 0, xe: 239, ys: 0, ye: 239, cur: 0 };
  spi.onTransmit = (b) => {
    if (!dc.outputValue) { lcd.cmd = b; lcd.args = []; if (b === 0x2c) lcd.cur = 0; }
    else if (lcd.cmd === 0x2a || lcd.cmd === 0x2b) {
      lcd.args.push(b);
      if (lcd.args.length === 4) {
        const s0 = (lcd.args[0] << 8) | lcd.args[1], e = (lcd.args[2] << 8) | lcd.args[3];
        if (lcd.cmd === 0x2a) { lcd.xs = s0; lcd.xe = e; } else { lcd.ys = s0; lcd.ye = e; }
      }
    } else if (lcd.cmd === 0x2c) {
      const ww = lcd.xe - lcd.xs + 1, p = lcd.cur >> 1, x = lcd.xs + (p % ww), y = lcd.ys + Math.floor(p / ww);
      if (x < 240 && y < 240) frame[(y * 240 + x) * 2 + (lcd.cur & 1)] = b;
      lcd.cur++;
    }
    spi.completeTransmit(0);
  };
}
if (args.includes("--shot")) {           // the home screen, from the slot's shot answer (rgb565, big-endian)
  const rid = ++id, parts = [];
  h.chip.write(JSON.stringify({ id: rid, type: "shot" }) + "\n");
  h.until((b) => { const L = b.split("\n").filter((l) => l.includes(`"id": ${rid}`)); return L.length && JSON.parse(L[0]).n === L.length; }, 30000, 20);
  for (const l of h.out.split("\n").filter((l) => l.includes(`"id": ${rid}`))) parts.push(JSON.parse(l));
  const px = Buffer.concat(parts.sort((a, b) => a.i - b.i).map((p) => Buffer.from(p.data, "base64"))), W = parts[0].w, H = parts[0].h;
  png(args[args.indexOf("--shot") + 1], px, W, H);
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
// Instant Wallet's "change the daily limit" (USDC + ETH allowances on this Safe's Roles, the relay's fee): one page
const W32 = (n) => BigInt(n).toString(16).padStart(64, "0");
const ROLES = "0x556a10637548f31dd0f284b1143807a5dbc66dd0";      // Instant's rolesAddress(safe) for this safe
const allow = (k, v) => ({ to: ROLES, data: "0xa8ec43ee" + k + W32(v).repeat(3) + W32(86400) + W32(1) });
const limit = { ...tx("0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", pack([
  allow("8cf0b93cd9d3e32167f8de799f8e55df33697bb155a46b384f39bd78e75879b5", 50000000),
  allow("45cc4838df5ba19e2e80bafaf996e5acf9194b3706f31dfa92fdfb8cc4fd3017", 10n ** 16n),
  { to: usdc, data: E.transferData("0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f", 23321n) }])), operation: 1 };
// Uniswap's Universal Router on Ethereum, real calldata: a V4 swap of 0.4805 ETH for USDC (0x40d62b8011385cf60e6a10566b45a4e8ceadbd2889802be96f6f36a3a241e23e), and a V3
// exact-out for 50 USDC with the ETH left over sent back (0xb813cd409e4e630b261904c8ee824a7740e8822721b0f7f77b8577c197d437d5)
const UR = "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85";
const urIn = { ...tx(UR, "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006ad98d2c00000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000360000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000006ab143846b870fd0000000000000000000000000000000000000000000000000000000045ca1cc50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ab143846b870fd0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000045ca1cc5", "480500017182306557"), chainId: 1 };
const urOut = { ...tx(UR, "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006ad9926200000000000000000000000000000000000000000000000000000000000000030b010c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000048dcc2d7c0c78900000000000000000000000000000000000000000000000000000000000001400000000000000000000000002379ff2df78aeb938277eb2da0fc4c82f83f20770000000000000000000000000000000000000000000000000000000002faf0800000000000000000000000000000000000000000000000000048dcc2d7c0c78900000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002ba0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000064c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000002379ff2df78aeb938277eb2da0fc4c82f83f20770000000000000000000000000000000000000000000000000000000000000000756e6978000001a161c836088000ad7f0000000c0100", "20508927724668809"), chainId: 1 };
// clear signing (safe-24+): real registry txs (tools/fixtures/clear-txs.json) with the bundle /safe sends from
// public/clear/<tag> (wire/release.py), as the app's hello asks: Aave, Lido, Uniswap's V3 router (a call inside a
// call), one not audited, a MultiSend batch (app.morpho.org)
const clearTxs = JSON.parse(readFileSync(new URL("fixtures/clear-txs.json", import.meta.url), "utf8"));
const clearDir = args.includes("--clear") ? args[args.indexOf("--clear") + 1] : new URL("../public/clear", import.meta.url).pathname;
Clear.loadFrom(async (p) => { try { return JSON.parse(readFileSync(join(clearDir, `${p}.json`), "utf8")); } catch { return null; } });
const txsFile = args.includes("--txs") ? args[args.indexOf("--txs") + 1] : null;
const cases = txsFile ? JSON.parse(readFileSync(txsFile, "utf8")).map((c) =>
  [c.name, { ...tx(c.to, c.data, c.value), chainId: c.chainId, safe: c.safe || safe, operation: c.operation || 0, ...(c.sim ? { sim: c.sim } : {}) }, 1, true, c.keys]) : [
  ...clearTxs.map((c) => [`clear signing: ${c.name}${c.trust === "a" ? "" : " (not audited)"}`, { ...tx(c.to, c.data, c.value), chainId: c.chainId, operation: c.operation || 0 }, 1, true]),
  ["change the daily limit (3 actions, 1 page)", limit, 1],
  ["Uniswap: swap 0.4805 ETH for USDC (V4, ERC-8362 descriptor)", urIn, 1, true],
  ["Uniswap: at most 0.0205 ETH for 50 USDC (V3 exact-out, ERC-8362 descriptor)", urOut, 1, true],
  ["send 0.5 ETH", tx("0x" + "77".repeat(20), "0x", "500000000000000000"), 1],
  ["send 0.5 POL on Polygon", { ...tx("0x" + "77".repeat(20), "0x", "500000000000000000"), chainId: 137 }, 1],
  ["add owner: itself", tx(safe, E.addOwnerData(signer, 2)), 1, true],
  ["remove owner: itself", tx(safe, E.removeOwnerData(E.SENTINEL, signer, 1)), 1, true],
  [`MultiSend batch, ${n} USDC sends (${JSON.stringify(batch).length} B line)`, batch, n],
];
/** Send one safe_sign, press k once a second (the app drops presses made before its question is up) until
 *  it answers; the answer and how long it took in chip time. */
function ask(t, k, msg = { type: "safe_sign", tx: t }, cb = null, shot = null, keys = []) {
  keys = [...(keys || [])];          // pressed first, one a second (a case's "keys": the d-pad through its details)
  for (let o = 0; cb && o < cb.length; o += hi.safe_chunk) {     // a clear-signing bundle first, in pieces
    const a = h.req({ id: ++id, type: "safe_clear", at: o / 2, hex: cb.slice(o, o + hi.safe_chunk), ...(o ? {} : { n: cb.length / 2 }) }, 20000);
    if (a?.type !== "safe_clear") console.log("     clear piece:", JSON.stringify(a));
  }
  // as /safe does (LINE_MAX): a safe_sign line over 3 KB sends its data in safe_data pieces first, then "@"
  if (msg.type === "safe_sign" && hi?.safe_chunk && JSON.stringify({ id: 1000, ...msg }).length > 3000 && msg.tx.data !== "@") {
    let at = 0;
    for (let o = 2; o < msg.tx.data.length; o += hi.safe_chunk) {
      const hex = msg.tx.data.slice(o, o + hi.safe_chunk);
      const a = h.req({ id: ++id, type: "safe_data", at, hex }, 20000);
      at += hex.length / 2;
      if (a?.type !== "safe_data" || a.have !== at) { console.log("     piece:", JSON.stringify(a)); break; }
    }
    msg = { ...msg, tx: { ...msg.tx, data: "@" } };
  }
  const rid = ++id, t0 = h.chip.ms;
  h.chip.write(JSON.stringify({ id: rid, ...msg }) + "\n");
  let got = null;
  const seen = [];
  const re = new RegExp(`\\{[^\\n]*"id": ${rid}[,}][^\\n]*\\n`);
  for (let s = 0; s < 240 && !got; s++) {
    h.until((b) => { const m = b.match(re); if (m) got = JSON.parse(m[0]); return !!m; }, 1000, 20);
    if (!got && shot && !(seen.length && seen[seen.length - 1].equals(frame))) seen.push(Buffer.from(frame));
    const kk = keys.length ? keys.shift() : k;
    if (!got && kk !== "wait") press(kk);     // "wait": a second with no press (a slow page)
  }
  seen.forEach((f, i) => png(`${shot}-${i + 1}.png`, f, 240, 240));     // each page it showed, in order
  return { got, secs: ((h.chip.ms - t0) / 1000).toFixed(1) };
}
for (const [what, t, pages, clear, keys] of cases) {
  const before = all.length;
  const cb = clear && hi?.safe_clear ? await Clear.bundle(hi.safe_clear, t.chainId, t) : null;
  if (clear && !cb && !t.sim) { check(!hi?.safe_clear, `${what}: no bundle for it (an app without clear signing: skipped)`); continue; }
  if (t.sim === "live") {   // as /safe does: the wedgie's nonce, then a clear-sim server (SIM_URL) simulates it
    const n = h.req({ id: ++id, type: "safe_nonce" }, 5000);
    const go = () => fetch(process.env.SIM_URL || "https://sim.wedgie.dev", { method: "POST", body: JSON.stringify({ chain: t.chainId,
      from: t.safe, to: t.to, value: String(t.value), data: t.data, nonce: n?.nonce, ...(t.operation ? { operation: 1 } : {}) }) }).then((x) => x.json());
    const r = await go().catch(go);     // once more: a kept-alive connection can close during a long case
    console.log(`     ${what}: nonce ${n?.nonce?.slice(0, 8)}…, sim ${r.ok || r.error} ${(r.changes || []).map((c) => c.amount + " " + c.symbol).join(", ")}`);
    t.sim = r;
  }
  const { got, secs } = ask(t, "A", undefined, cb, shots && join(shots, what.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)), keys);
  const out = all.slice(before);
  if (!got || process.env.DUMP) console.log("     it said:", JSON.stringify(out.slice(-1500)));
  const r = ram(what);
  // a yes reaches the chip step: no chip here, so the app answers its error (anything but a crash)
  const chipStep = got?.type === "safe_sig" || /trustm|ATECC608/.test(got?.error || "");
  check(chipStep && !crash(out), `${what}: ${pages} page(s), A through them, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 200) + ")" : "") : "nothing"} · ${r?.ram} B free`);
}
if (txsFile) { console.log(failed ? `${failed} FAILED` : "all checks passed"); process.exit(failed ? 1 : 0); }
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
    const chipStep = got?.type === "safe_sig" || /trustm|ATECC608/.test(got?.error || "");
    if (size > (hi.safe_max || 8000)) { check(!okp && !crash(all.slice(before)), `a ${size} B transaction: refused as too big, no crash`); continue; }
    check(okp && chipStep && !crash(all.slice(before)), `a ${size} B transaction in ${Math.ceil(size * 2 / hi.safe_chunk)} safe_data pieces, then signed, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 200) + ")" : "") : "nothing"} · ${r?.ram} B free`);
  }
}
if (hi?.app && hi.app >= "safe-23") {     // safe_remove: the delete request for a queued tx (its data as a hash)
  const { data, ...rest } = cases[0][1], before = all.length;
  const rm = { ...rest, dataHash: E.hex(E.keccak256(E.bytes(data || "0x"))) };
  const { got, secs } = ask(null, "A", { type: "safe_remove", tx: rm, totp: 497960 });
  const r = ram("safe_remove");
  const chipStep = got?.type === "safe_sig" || /trustm|ATECC608/.test(got?.error || "");
  check(chipStep && !crash(all.slice(before)), `safe_remove: "Remove it?" #${rm.nonce}, A, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 200) + ")" : "") : "nothing"} · ${r?.ram} B free`);
  const no = ask(null, "Y", { type: "safe_remove", tx: rm, totp: 497960 });
  check(no.got?.type === "refused" && no.got.safeTxHash === E.safeTxHash(rm.chainId, rm.safe, { ...rm, data: data || "0x" }),
    `safe_remove Y: refused, with the Safe tx hash it worked out (${no.got?.safeTxHash?.slice(0, 10)}…)`);
}
if (hi?.app && hi.app >= "safe-29") {     // safe_message: a site's text (sign-in), its SafeMessage hash worked out on the wedgie
  const { hashMessage, hashTypedData, toHex } = await import("viem");
  const text = "opensea.io wants you to sign in with your Ethereum account:\n" + safe + "\n\nClick to sign in and accept the Platform Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).\n\nURI: https://opensea.io/\nVersion: 1\nChain ID: 1\nNonce: qbtt8jjjgo32tbk977cu01e9e\nIssued At: 2026-10-27T04:04:28.135Z";
  const m = { type: "safe_message", chainId: 1, safe, hex: toHex(text) }, before = all.length;
  const want = hashTypedData({ domain: { chainId: 1, verifyingContract: safe }, types: { SafeMessage: [{ name: "message", type: "bytes" }] }, primaryType: "SafeMessage", message: { message: hashMessage(text) } });
  const { got, secs } = ask(null, "A", m, null, shots && join(shots, "safe-message"));
  const r = ram("safe_message");
  const chipStep = got?.type === "safe_sig" || /trustm|ATECC608/.test(got?.error || "");
  check(chipStep && !crash(all.slice(before)), `safe_message: a sign-in text, A through its pages, ${secs} s: answered ${got ? got.type + (got.error ? " (" + got.error.slice(0, 200) + ")" : "") : "nothing"} · ${r?.ram} B free`);
  const no = ask(null, "Y", m);
  check(no.got?.type === "refused" && no.got.safeMessageHash === want, `safe_message Y: refused, with the SafeMessage hash viem gets (${no.got?.safeMessageHash?.slice(0, 10)}…)`);
  const bad = h.req({ id: ++id, type: "safe_message", chainId: 1, safe, hex: toHex("h\u00e9llo") }, 8000);
  check(bad?.type === "error" && /plain text/.test(bad.error || ""), `safe_message: not plain ASCII refused (${bad?.error?.slice(0, 30)})`);
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
