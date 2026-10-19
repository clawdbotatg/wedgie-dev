// Secrets (clawdbotatg/wedgie-secret) on a virtual RP2040 (rp2040js, the real MicroPython build and its
// real heap: tools/rp2040/chip.mjs), the way /secret drives it.
//  1. The app running, its key saved: hello carries it; garbage is refused; a 1500-byte message (the most
//     /secret seals) asks, Y says no, A reaches the chip step (the virtual chip has no secure chip, so the
//     app answers its error there: anything but a crash).
//  2. No app, the REPL: secret_box.py opens that message on real MicroPython (cryptolib AES, its HMAC),
//     given the ECDH secret Node works out, and the reader draws it.
//  3. Chat, in the REPL with the chip's ECDH and the press played: every message asks (a "from" name is the
//     computer's word: it never skips the press or shows), a screen shot is refused while one is up, red closes it.
// A MemoryError, a traceback that isn't the chip's, or no answer fails it. Prints the least free heap seen.
//   node tools/secretchip.mjs [--app <wedgie-secret checkout>] [--shots <dir>]   (default: the shelf's copy; until it is on the shelf, pass --app)
// Needs uv (the flash image: littlefs-python).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";
import * as S from "../src/secret/box.ts";

const args = process.argv.slice(2);
const appDir = args.includes("--app") ? args[args.indexOf("--app") + 1] : null;
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const F = firmware();
if (appDir) {
  const a = JSON.parse(readFileSync(join(appDir, "wedgie.json"), "utf8")).apps[0];
  const i = F.carts.findIndex((c) => c.mod === "secret");
  if (i >= 0) F.carts.splice(i, 1);
  F.app(a, Object.fromEntries(a.files.filter((n) => existsSync(join(appDir, n))).map((n) => [n, readFileSync(join(appDir, n))])));
}
const cart = F.carts.find((c) => c.mod === "secret");
console.log(`Secrets (${appDir || "the shelf's copy"}): ${cart.files.join(" ")}`);

// the wedgie's key, played here: its public half saved as the app saves it, its private half for step 2
const C = globalThis.crypto.subtle;
const kp = await C.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const pub = new Uint8Array(await C.exportKey("raw", kp.publicKey));
const hex = (u) => Buffer.from(u).toString("hex");
const key = { pub: hex(pub), chip: "OPTIGA Trust M", id: await S.keyId(pub) };
const text = "Meet at the usual place at nine. " + "The quick brown fox jumps over the lazy dog. ".repeat(40);
const msg = text.slice(0, S.MAX);
const blob = await S.seal(pub, msg);
const E = S.unb64u(blob.slice(S.PREFIX.length)).slice(0, 65);
const z = new Uint8Array(await C.deriveBits({ name: "ECDH", public: await C.importKey("raw", E, { name: "ECDH", namedCurve: "P-256" }, false, []) }, kp.privateKey, 256));

const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|wedgie broke/;
const crash = (out) => BAD.test(out) || out.split("Traceback").slice(1).some((t) => !/OSError: (trustm|optiga|I2C)|ENODEV|ETIMEDOUT|EIO/.test(t.split("\n{")[0]));
let all = "", failed = 0, least = Infinity, leastWhere = "", id = 100;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

function png(lines, file) {         // shot answers (rgb565, big-endian) -> a PNG
  const parts = lines.map((l) => JSON.parse(l)).sort((a, b) => a.i - b.i);
  const px = Buffer.concat(parts.map((p) => Buffer.from(p.data, "base64"))), W = parts[0].w, H = parts[0].h;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

{ // 1. the app
  const h = host({ fs: image(F, "secret", { "saves/secret/key.json": Buffer.from(JSON.stringify(key)) }), onData: (b) => { all += Buffer.from(b).toString("latin1"); } });
  for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);
  const press = (k) => { const p = h.chip.mcu.gpio[KEYS[k]]; p.setInputValue(false); h.chip.run(150); p.setInputValue(true); h.chip.run(100); };
  const ram = (where) => {
    const r = h.req({ type: "hello", id: ++id }, 8000);
    if (typeof r?.ram === "number" && r.ram < least) { least = r.ram; leastWhere = where; }
    return r;
  };
  if (!h.until((b) => b.includes('"ready"'), 30000, 20)) { console.log("no ready line:", JSON.stringify(h.out.slice(-400))); process.exit(1); }
  h.chip.run(1500);
  const hi = ram("started, its key loaded");
  check(hi?.running === "secret" && hi?.secret?.pub === key.pub, `hello: running secret, its key ${hi?.secret?.id} (${hi?.ram} B free)`);
  if (shots) {
    const rid = ++id;
    h.chip.write(JSON.stringify({ id: rid, type: "shot" }) + "\n");
    h.until((b) => { const L = b.split("\n").filter((l) => l.includes(`"id": ${rid}`)); return L.length && JSON.parse(L[0]).n === L.length; }, 30000, 20);
    png(h.out.split("\n").filter((l) => l.includes(`"id": ${rid}`)), join(shots, "secret-home.png"));
    h.take();
  }
  for (const [what, b] of [["garbage", "hello"], ["a cut-off message", blob.slice(0, 120)]]) {
    const r = h.req({ id: ++id, type: "secret_open", blob: b }, 8000);
    check(r?.type === "error", `${what}: refused before asking (${r?.error})`);
  }
  /** Send the message, press k once a second until it answers. */
  const ask = (k) => {
    const rid = ++id, t0 = h.chip.ms, re = new RegExp(`\\{[^\\n]*"id": ${rid}[,}][^\\n]*\\n`);
    h.chip.write(JSON.stringify({ id: rid, type: "secret_open", blob }) + "\n");
    let got = null;
    for (let i = 0; i < 20 && !got; i++) {
      h.until((b) => { const m = b.match(re); if (m) got = JSON.parse(m[0]); return !!m; }, 1000, 20);
      if (!got) press(k);
    }
    return { got, secs: ((h.chip.ms - t0) / 1000).toFixed(1) };
  };
  let before = all.length;
  let { got, secs } = ask("Y");
  check(got?.type === "refused" && !crash(all.slice(before)), `${S.MAX}-byte message, Y: ${got?.type} (${secs} s) · ${ram("after a no")?.ram} B free`);
  before = all.length;
  ({ got, secs } = ask("A"));
  const out = all.slice(before);
  if (!got) console.log("     no answer; it said:", JSON.stringify(out.slice(-800)));
  check(got && got.type !== "refused" && !crash(out), `${S.MAX}-byte message, A: reaches the chip step, ${secs} s: ${got?.type}${got?.error ? " (" + got.error.slice(0, 50) + ")" : ""} · ${ram("after the chip step")?.ram} B free`);
}

{ // 2. secret_box on real MicroPython, and the reader's screen
  const h = host({ fs: image(F, null, Object.fromEntries(cart.files.map((n) => [n, F.file(n)])), ["main.py"]) });
  h.until((b) => b.includes(">>> "), 30000, 20);
  const t0 = h.chip.ms;
  const r = h.exec(`import gc, binascii, hashlib
gc.collect()
f0 = gc.mem_free()
import secret_box as B
e, iv, ct, tag = B.parse(${JSON.stringify(blob)})
m = B.open_box(binascii.unhexlify(${JSON.stringify(hex(z))}), e, binascii.unhexlify(${JSON.stringify(key.pub)}), iv, ct, tag)
print(binascii.hexlify(hashlib.sha256(m).digest()).decode(), f0, gc.mem_free())
`, 60000).trim();
  const [h256, f0, f1] = r.split(/\s+/);
  const want = Buffer.from(await C.digest("SHA-256", new TextEncoder().encode(msg))).toString("hex");
  check(h256 === want, `secret_box opens the ${S.MAX}-byte message on MicroPython in ${((h.chip.ms - t0) / 1000).toFixed(1)} s (${f0} B free before, ${f1} after)`);
  if (shots) {
    const shot = (code, name) => {
      const o = h.exec(code + "\nimport wedgie\nwedgie.shot()\n", 60000);
      png(o.split("\n").filter((l) => l.includes('"shot"')), join(shots, name));
    };
    shot(`import lcd, ui, secret
secret.d = lcd.LCD()
secret.chat = {"from": "Bob", "lines": secret.text_lines(m), "at": 0, "t0": 0}
secret.draw_chat()`, "secret-read.png");
    shot(`ui.ask(secret.d, "Read a secret?", (), "read", "no", 1)`, "secret-ask.png");
    console.log(`     shots in ${shots}`);
  }
}
{ // 3. chat
  const h = host({ fs: image(F, null, Object.fromEntries(cart.files.map((n) => [n, F.file(n)])), ["main.py"]) });
  h.until((b) => b.includes(">>> "), 30000, 20);
  const r = h.exec(`import gc, binascii, lcd, ui, secret
secret.d = lcd.LCD()
secret.key = ${JSON.stringify(key)}
secret.ecdh = lambda e: binascii.unhexlify(${JSON.stringify(hex(z))})
asks = []
ui.ask = lambda d, q, *a, **k: asks.append(q) or True
ui.progress = lambda *a, **k: None
b = ${JSON.stringify(blob)}
gc.collect()
f0 = gc.mem_free()
secret.on_open(1, b, "Bob")
one = (len(asks), secret.chat["from"] or "-", len(secret.chat["lines"]))
secret.draw_chat()
secret.on_open(2, b, "Bob")
two = len(asks)
secret.on_open(3, b, "")
three = len(asks)
import wedgie as W
sent = []
_send, W.send = W.send, sent.append
secret.handle({"id": 9, "type": "shot"})
W.send = _send
shot = "refused" if sent and sent[0].get("type") == "error" else "SENT"
secret.chat_key("down")
pg = secret.chat["at"]
secret.chat_key("Y")
gc.collect()
print("RES", one[0], one[1], one[2], two, three, pg, secret.chat is None, f0 - gc.mem_free(), shot, asks[0])
`, 60000);
  const m = r.match(/RES (.*)/);
  const [a1, from, lines, a2, a3, pg, closed, used, shot, ...q] = m ? m[1].trim().split(" ") : [], q0 = q.join(" ");
  if (!m) console.log("     it said:", JSON.stringify(r.slice(-600)));
  check(a1 === "1" && from === "-" && Number(lines) > 10, `chat: a message asks ("${q0}"), ${lines} lines on screen, no sender name`);
  check(a2 === "2", "chat: the same \"from\" asks again");
  check(a3 === "3", "chat: a message with no name asks");
  check(shot === "refused", "chat: a screen shot is refused while a secret is up");
  check(pg === "1" && closed === "True", `chat: down pages, red closes it (${used} B held after)`);
}
console.log(`     least free heap seen with the app running: ${least} bytes (${leastWhere})`);
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
