// The ETH Price app (clawdbotatg/wedgie-price) on a virtual RP2040 (tools/rp2040/chip.mjs, a real board's
// heap): A asks, this plays the computer with api/price.ts's own answer (PRICE_KEY from .env), and the app
// must show the price; then the same with the price changed on the way, and with an old answer (another
// nonce): both must say "Not trusted". A MemoryError, a traceback or no answer fails it.
//   node tools/pricechip.mjs [--app <wedgie-price checkout>] [--shot <dir>]   (default: the shelf's copy)
// Needs uv (the flash image) and PRICE_KEY in .env.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const appDir = opt("--app"), shots = opt("--shot");
process.env.PRICE_KEY ||= (readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^PRICE_KEY=(.*)$/m) || [])[1];
const { GET } = await import("../api/price.ts");
const F = firmware();
if (appDir) {
  const a = JSON.parse(readFileSync(join(appDir, "wedgie.json"), "utf8")).apps[0];
  const i = F.carts.findIndex((c) => c.mod === "price");
  if (i >= 0) F.carts.splice(i, 1);
  F.app(a, Object.fromEntries(a.files.filter((n) => existsSync(join(appDir, n))).map((n) => [n, readFileSync(join(appDir, n))])));
}
const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|wedgie broke|Traceback/;
let all = "", failed = 0, id = 100;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const h = host({ fs: image(F, "price"), onData: (b) => { all += Buffer.from(b).toString("latin1"); } });
for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);
const press = (k) => { const p = h.chip.mcu.gpio[KEYS[k]]; p.setInputValue(false); h.chip.run(150); p.setInputValue(true); h.chip.run(100); };
if (!h.until((b) => b.includes('"ready"'), 30000, 20)) { console.log("no ready line:", JSON.stringify(h.out.slice(-400))); process.exit(1); }
h.chip.run(1500);

function shot(name) {
  if (!shots) return;
  const rid = ++id;
  h.take();
  h.chip.write(JSON.stringify({ id: rid, type: "shot" }) + "\n");
  h.until((b) => { const L = b.split("\n").filter((l) => l.includes(`"id": ${rid}`)); return L.length && JSON.parse(L[0]).n === L.length; }, 30000, 20);
  const parts = h.out.split("\n").filter((l) => l.includes(`"id": ${rid}`)).map((l) => JSON.parse(l));
  const px = Buffer.concat(parts.sort((a, b) => a.i - b.i).map((p) => Buffer.from(p.data, "base64"))), W = parts[0].w, H = parts[0].h;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(join(shots, `price-${name}.png`), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** Press A, catch the question, answer it with change(answer); the hello after (its screen is up by then). */
let last = null;
async function round(what, change) {
  h.take();
  press("A");
  let ask = null;
  h.until((b) => { const m = b.match(/\{[^\n]*"price_ask"[^\n]*\n/); if (m) ask = JSON.parse(m[0]); return !!ask; }, 5000, 20);
  check(!!ask && /^[0-9a-f]{32}$/.test(ask.nonce), `${what}: asks with a fresh nonce`);
  if (!ask) return null;
  const a = await (await GET(new Request(`https://wedgie.dev/api/price?nonce=${ask.nonce}`))).json();
  const sent = change(a);
  last = a;
  h.chip.write(JSON.stringify({ ...sent, type: "price" }) + "\n");
  h.chip.run(8000);                       // the check: ~2 s of pure-Python P-256 on an RP2040
  const c = (h.out.match(/\{[^\n]*"price_checked"[^\n]*\n/) || [])[0];
  const hi = h.req({ type: "hello", id: ++id }, 8000);
  check(typeof hi?.ram === "number", `${what}: still answers (${hi?.ram} B free)`);
  return c ? JSON.parse(c).ok : null;
}

shot("home");
check((await round("real answer", (x) => x)) === true, `real answer: trusted and shown (${last?.price})`);
shot("good");
const old = last;
check((await round("price changed on the way", (x) => ({ ...x, price: "99999.99" }))) === false, "price changed on the way: not trusted");
shot("evil");
check((await round("an old answer (last nonce)", () => old)) === false, "an old answer: not trusted");
check(!BAD.test(all), "no traceback, no memory error");
if (BAD.test(all)) console.log(all.split("\n").filter((l) => BAD.test(l) || /File "/.test(l)).slice(0, 6).join("\n"));
process.exit(failed ? 1 : 0);
