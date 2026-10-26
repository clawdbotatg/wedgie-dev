// tls.py on a virtual RP2040 (the real MicroPython build, its real heap) with the software Trust M on I2C,
// a real TCP socket to the site carried by this script (the "computer").
//   node tlschip.mjs <host> <path> [--tamper]
import { readFileSync } from "node:fs";
import net from "node:net";
import { boot, flashFromUf2 } from "../src/chip/sim.ts";
import { trustM, newTrustM } from "../src/chip/trustm.ts";
const [host, path] = process.argv.slice(2);
const tamper = process.argv.includes("--tamper");
const leave = process.argv.includes("--leave") ? Number(process.argv[process.argv.indexOf("--leave") + 1]) : 0;   // fill the heap till only this much is free
let buf = "";
const tm = trustM(newTrustM(), () => chip.ms, () => {});
const chip = boot({ rom: readFileSync(new URL("../tools/rp2040/bootrom-b1.bin", import.meta.url)), flash: flashFromUf2(readFileSync(new URL("../public/mp/RPI_PICO.uf2", import.meta.url))), i2c: tm,
  uid: Uint8Array.from([1,2,3,4,5,6,7,8]), onData: (b) => { buf += Buffer.from(b).toString("latin1"); } });
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, ms) { const end = chip.ms + ms; while (chip.ms < end) { if (fn()) return true; chip.run(5); await tick(); } return fn(); }
const write = (s) => chip.write(Buffer.from(s, "latin1"));
async function exec(code, ms = 60000) {
  buf = ""; write("\r\x03\x03\x01");
  if (!await until(() => buf.includes("raw REPL; CTRL-B to exit\r\n>"), 5000)) throw new Error("no raw REPL " + JSON.stringify(buf.slice(-200)));
  buf = ""; write(code); write("\x04");
  if (!await until(() => /\x04[\s\S]*\x04>$/.test(buf), ms)) throw new Error("exec timeout " + JSON.stringify(buf.slice(-300)));
  const m = buf.match(/^OK([\s\S]*?)\x04([\s\S]*?)\x04>$/); write("\x02"); await until(() => buf.endsWith(">>> "), 1000);
  if (m[2]) throw new Error(m[2]); return m[1];
}
const py = (b) => "b'" + [...b].map((c) => "\\x" + c.toString(16).padStart(2, "0")).join("") + "'";
async function put(name, data) { let code = `f=open('${name}','wb')\n`; for (let o = 0; o < data.length; o += 256) code += `f.write(${py(data.subarray(o, o + 256))})\n`; await exec(code + "f.close()\n"); }

if (!await until(() => chip.connected && buf.includes(">>> "), 30000)) { write("\r\n"); await until(() => buf.includes(">>> "), 5000); }
for (const f of ["tls.mpy", "roots.bin"]) await put(f, readFileSync(new URL("./" + f, import.meta.url)));
for (const f of ["trustm.mpy"]) await put(f, readFileSync(new URL("../firmware/" + f, import.meta.url)));
console.log("files on, chip ms", Math.round(chip.ms));

// the run: the chip asks for bytes with \x1eR, sends with \x1eS<hex>
const wall0 = Date.now();
const sock = net.connect(443, host);
sock.on("close", () => console.log("  (site closed the connection after", ((Date.now() - wall0) / 1000).toFixed(1), "s of real time)"));
let inq = Buffer.alloc(0), closed = false, flipped = false;
sock.on("data", (d) => { inq = Buffer.concat([inq, d]); });
sock.on("end", () => { closed = true; }); sock.on("error", (e) => { console.log("sock", e.message); closed = true; });
await new Promise((r) => sock.once("connect", r));
const code = `
import gc, time, binascii, sys, trustm
trustm.bus()
gc.collect()
ball = []
k = 65536
while ${leave} and k >= 256:
    want = gc.mem_free() - ${leave} - 64
    if want < 256:
        break
    try:
        ball.append(bytearray(min(k, want)))
    except MemoryError:
        k //= 2
gc.collect()
free0 = gc.mem_free()
print('free before import', free0)
import tls
gc.collect()
low = [gc.mem_free()]
t0 = time.ticks_ms()
def log(m):
    gc.collect(); low[0] = min(low[0], gc.mem_free())
    print("  %s %d ms, free %d" % (m, time.ticks_diff(time.ticks_ms(), t0), gc.mem_free()))
def send(b):
    sys.stdout.write("\\x1eS" + binascii.hexlify(b).decode() + "\\n")
def recv():
    sys.stdout.write("\\x1eR\\n")
    return binascii.unhexlify(sys.stdin.readline().strip())
try:
    c = tls.Conn("${host}", send, recv, log=log)
    b = c.get("${path}")
    log("got %d bytes, status %d" % (len(b), c.status))
    print("BODY", b[:200])
except tls.Error as e:
    print("TLS ERROR", e)
print("lowest free", low[0])
`;
buf = ""; write("\r\x03\x03\x01");
await until(() => buf.includes("raw REPL; CTRL-B to exit\r\n>"), 5000);
buf = ""; write(code); write("\x04");
let seen = 0, out = "";
const end = chip.ms + 600000;
while (chip.ms < end) {
  chip.run(5); await tick();
  let i;
  while ((i = buf.indexOf("\n", seen)) >= 0) {
    const line = buf.slice(seen, i); seen = i + 1;
    const k = line.indexOf("\x1e");
    if (k < 0) { out += line + "\n"; if (!line.startsWith("OK")) console.log(line.replace(/^OK/, "")); continue; }
    if (line[k + 1] === "S") sock.write(Buffer.from(line.slice(k + 2).trim(), "hex"));
    else if (line[k + 1] === "R") {
      while (!inq.length && !closed) { chip.run(1); await new Promise((r) => setTimeout(r, 5)); }
      let give = inq.subarray(0, 512); inq = inq.subarray(give.length);
      if (tamper && !flipped && give.length > 300) { give = Buffer.from(give); give[200] ^= 1; flipped = true; console.log("  (computer flipped one bit)"); }
      write(give.toString("hex") + "\n");
    }
  }
  if (/\x04>$/.test(buf) || buf.includes("\x04\x04")) break;
}
const err = buf.match(/\x04([\s\S]*?)\x04>?$/);
if (err && err[1]) console.log("ERR", err[1]);
console.log("chip ms total", Math.round(chip.ms));
sock.destroy(); process.exit(0);
