// net.get on a virtual RP2040 (the real MicroPython build and heap, the firmware, src/chip/trustm.ts's Trust M):
// tools/fixtures/nettest.py gets real sites over the wedgie's own TLS, and this plays its computer the way its
// wedgie.dev page does (src/serial/net.ts answerTcp), with the site's bytes over a plain TCP socket (or through
// relay.wedgie.dev: --relay). Each site must come back right; one not in the app's "net" must be refused; a bit
// the computer flips must be caught ("tampered with"); no traceback, no memory error.
//   node tools/netchip.mjs [--relay]        (needs uv: the flash image)
import { readFileSync } from "node:fs";
import net from "node:net";
import { boot, flashFromUf2 } from "../src/chip/sim.ts";
import { trustM, newTrustM } from "../src/chip/trustm.ts";
import { firmware, image } from "./rp2040/image.mjs";

const relay = process.argv.includes("--relay");
const NET = ["api.coinbase.com", "api.coingecko.com", "api.github.com", "api.kraken.com"];
const F = firmware();
F.app({ mod: "nettest", name: "Net Test", files: ["nettest.py"], entry: "run", net: NET }, { "nettest.py": readFileSync(new URL("./fixtures/nettest.py", import.meta.url)) });
const flash = flashFromUf2(readFileSync(new URL("../public/mp/RPI_PICO.uf2", import.meta.url)));
flash.set(image(F, "nettest"), 0xa0000);
let out = "", seen = 0, failed = 0, opened = 0;
const tm = trustM(newTrustM(), () => chip.ms, () => {});
const chip = boot({ rom: readFileSync(new URL("./rp2040/bootrom-b1.bin", import.meta.url)), flash, i2c: tm, uid: Uint8Array.from([0xe6, 0x61, 0x64, 0x08, 0x13, 0x77, 0x23, 0x2f]),
  onData: (b) => { out += Buffer.from(b).toString("latin1"); } });
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const write = (o) => chip.write(Buffer.from(JSON.stringify(o) + "\n"));
const socks = new Map();
const results = [];

function tcp(v) {
  const rid = v.rid;
  if (typeof v.host === "string") {
    opened++;
    if (!NET.includes(v.host)) return write({ type: "tcp", rid, error: `${v.host} isn't in the app's "net" (wedgie.json)` });
    const flip = opened === 6;          // the last site: the computer changes one bit of what the site sent
    let n = 0;
    const s = relay ? null : net.connect(443, v.host);
    const me = { s, ws: null, held: [] };
    const fromSite = (b) => {
      if (flip && n < 1500 && n + b.length > 1500) { b = Buffer.from(b); b[1500 - n] ^= 4; }
      n += b.length;
      for (let o = 0; o < b.length; o += 3000) write({ type: "tcp", rid, d: b.subarray(o, o + 3000).toString("base64") });
    };
    if (relay) {
      const ws = new WebSocket(`wss://relay.wedgie.dev/?host=${v.host}`, { headers: { Origin: "https://wedgie.dev" } });
      ws.binaryType = "arraybuffer";
      me.ws = ws;
      ws.onopen = () => { for (const b of me.held.splice(0)) ws.send(b); };
      ws.onmessage = (e) => fromSite(Buffer.from(e.data));
      ws.onclose = () => { if (socks.get(rid) === me) { socks.delete(rid); write({ type: "tcp", rid, end: true }); } };
    } else {
      s.on("data", fromSite);
      s.on("close", () => { if (socks.get(rid) === me) { socks.delete(rid); write({ type: "tcp", rid, end: true }); } });
      s.on("error", () => {});
    }
    socks.set(rid, me);
    return;
  }
  const me = socks.get(rid);
  if (!me) return;
  if (v.end) { socks.delete(rid); me.s?.destroy(); me.ws?.close(); return; }
  if (typeof v.d === "string") {
    const b = Buffer.from(v.d, "base64");
    if (me.s) me.s.write(b);
    else if (me.ws.readyState === 1) me.ws.send(b); else me.held.push(b);
  }
}

const t0 = Date.now();
let done = false;
while (!done && Date.now() - t0 < 600_000) {
  chip.run(20);
  await new Promise((r) => setImmediate(r));
  let i;
  while ((i = out.indexOf("\n", seen)) >= 0) {
    const line = out.slice(seen, i).trim();
    seen = i + 1;
    if (/Traceback|MemoryError|memory allocation failed/.test(line)) { console.log("  |", line); failed++; }
    if (!line.startsWith("{")) continue;
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type === "tcp") tcp(v);
    else if (v.type === "nettest" && v.done) done = true;
    else if (v.type === "nettest") { results.push(v); console.log("     ", JSON.stringify(v).slice(0, 150)); }
    else if (v.type === "nettest_free") console.log(`      free ${v.before} before, ${v.after} after`);
  }
}
check(done, "the app got through every site");
const [cb, cg, gh, kr, ex, flip] = results;
check(cb && /^\d+\.\d+$/.test(cb.v), `Coinbase: ${cb?.v ?? cb?.error} (${cb?.ms} ms)`);
check(cg && typeof cg.v?.usd === "number", `CoinGecko (P-384 root): ${JSON.stringify(cg?.v ?? cg?.error)} (${cg?.ms} ms)`);
check(gh && typeof gh.v === "string" && gh.v.length > 3, `GitHub, text: ${gh?.v ?? gh?.error} (${gh?.ms} ms)`);
check(kr && typeof kr.v === "number", `Kraken: ${kr?.v ?? kr?.error} (${kr?.ms} ms)`);
check(ex && /isn't in the app's "net"/.test(ex.error || ""), `a site not in "net": ${ex?.error}`);
check(flip && /tampered/.test(flip.error || ""), `a bit flipped by the computer: ${flip?.error}`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
