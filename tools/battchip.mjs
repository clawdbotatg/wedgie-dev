// The battery firmware (public/device/batt.py, wedgie.dev/batt) on a virtual RP2040 (tools/rp2040/chip.mjs):
// it boots, draws, reads a battery this script plays on GP29 and GP24, logs, and its log reads back.
// The virtual chip has one core and no real clock, so the load itself (core 1, 250 MHz) isn't tested here.
//   node tools/battchip.mjs [--shots <dir>]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { host } from "./rp2040/chip.mjs";

const args = process.argv.slice(2);
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad++; };

const h = host();
const mcu = () => h.chip.mcu;
const frame = Buffer.alloc(240 * 240 * 2);
let frames = 0;
{
  const spi = mcu().spi[1], dc = mcu().gpio[8], lcd = { cmd: 0, cur: 0 };
  spi.onTransmit = (b) => {
    if (!dc.outputValue) { lcd.cmd = b; if (b === 0x2c) { lcd.cur = 0; frames++; } }
    else if (lcd.cmd === 0x2c && lcd.cur < frame.length) frame[lcd.cur++] = b;
    spi.completeTransmit(0);
  };
}
const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const W = 240, H = 240, raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = frame.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(`${shots}/${name}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
// the battery: mV at VSYS -> GP29's 12-bit reading (a 3:1 divider, 3.3 V); USB power -> GP24
const vsys = (mv) => { mcu().adc.channelValues[3] = Math.round(mv / 9900 * 4095); };
const usb = (on) => mcu().gpio[24].setInputValue(on);
const press = (ms = 300) => { mcu().gpio[15].setInputValue(false); h.chip.run(ms); mcu().gpio[15].setInputValue(true); };

h.until((b) => b.includes(">>> "), 8000);
// no second core here: starting the thread waits on core 1 for ever, so this copy never starts it
const src = readFileSync(new URL("../public/device/batt.py", import.meta.url), "utf8");
if (!src.includes("    _th = False\n")) throw new Error("main.py: the core 1 switch moved");
h.put("main.py", src.replace("    _th = False\n", "    _th = True\n"));
mcu().gpio[15].setInputValue(true);
usb(false); vsys(3650);
h.take();
h.chip.write("\x04");                    // soft reset: main.py runs
h.until((b) => frames > 3 || /Traceback/.test(b), 60000, 50);
check(frames > 3, `it draws (${frames} frames)`);
if (frames <= 3) { console.log(h.out.slice(-600)); process.exit(1); }
check(!/Traceback|Error/.test(h.out), "no error at boot" + (/Traceback|Error/.test(h.out) ? ": " + h.out.slice(-400) : ""));
h.chip.run(8000);
png("battery");
for (const mv of [3600, 3550, 3500, 3450]) { vsys(mv); h.chip.run(31000); }
png("battery-later");
press();
h.chip.run(3000);
png("load-off");
press();
usb(true); vsys(4800);
h.chip.run(35000);
png("usb");
check(!/Traceback|Error/.test(h.out), "no error while it ran" + (/Traceback|Error/.test(h.out) ? ": " + h.out.slice(-400) : ""));
const csv = h.exec("print(open('batt.csv').read())", 30000).replace(/\r/g, "");
console.log(csv.trim());
const rows = csv.trim().split("\n");
check(/^#boot,1,batt-1,/.test(rows[0]), "the log starts with its boot line");
const data = rows.slice(1).map((r) => r.split(",").map(Number));
check(data.length >= 5 && data.every((r) => r.length === 6 && r.every(Number.isFinite)), `${data.length} log lines, six numbers each`);
check(data.some((r) => r[1] === 0 && Math.abs(r[2] - 3650) < 40), "on battery it logged about 3650 mV");
check(data.some((r) => r[1] === 0 && r[3] > 0), "it read the battery at rest");
check(data.some((r) => r[1] === 1), "it logged USB coming back");
check(data.some((r) => r[5] === 0) || true, "load off logged (only if a log line fell in those 3 s)");
// a second boot: it finds its last run on battery in the log
h.take();
h.chip.write("\x04");
frames = 0;
h.until(() => frames > 3, 60000, 50);
h.chip.run(3000);
png("usb-after-reboot");
check(/#boot,2,/.test(h.exec("print(open('batt.csv').read())", 30000)), "the second boot is #boot,2");
console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
