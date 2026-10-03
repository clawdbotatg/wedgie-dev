// A real RP2040 in software: rp2040js (MIT, Wokwi) runs the very MicroPython build wedgie.dev flashes
// (public/mp/RPI_PICO.uf2), so the heap, its size and how it fragments are a real board's. The
// browser emulator (src/emu) is MicroPython for WebAssembly: its heap starts at 128 MB and grows on
// demand, so nothing there ever runs out of memory. This is what tools/chipprobe.mjs tests memory on.
// The bootrom (bootrom-b1.bin) is Raspberry Pi's (BSD-3), from rp2040js's demo/bootrom.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Simulator, USBCDC, ConsoleLogger, LogLevel } from "rp2040js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const FLASH = 0x10000000;

/** A booted chip: write(bytes|str) to its USB serial, every byte it sends goes to onData. */
export function boot({ uf2 = join(root, "public/mp/RPI_PICO.uf2"), flash = null, fs = null, onData = () => {}, log = false, drive = false } = {}) {
  const sim = new Simulator();
  const mcu = sim.rp2040, clock = sim.clock;
  const rom = readFileSync(join(here, "bootrom-b1.bin"));
  mcu.loadBootrom(new Uint32Array(rom.buffer, rom.byteOffset, rom.length / 4));
  mcu.logger = new ConsoleLogger(log ? LogLevel.Warn : LogLevel.Error);
  if (flash) mcu.flash.set(flash);
  else {
    const f = readFileSync(uf2);
    for (let o = 0; o + 512 <= f.length; o += 512) {
      const v = new DataView(f.buffer, f.byteOffset + o, 512);
      const addr = v.getUint32(12, true), size = v.getUint32(16, true);
      mcu.flash.set(f.subarray(o + 32, o + 32 + size), addr - FLASH);
    }
  }
  if (fs) mcu.flash.set(fs, 0xa0000);     // the littlefs image (mkfs.py): where a Pico's filesystem starts
  const hook = flashWrites(mcu, rom);
  let cdc, connected = false, msc = null;
  const pending = [];
  const attach = () => {
    // a fresh host each time the device (re)enables USB: boot.py re-enumerates to add the WEDGIE drive
    cdc = new USBCDC(mcu.usbCtrl);
    const enabled = mcu.usbCtrl.onUSBEnabled;
    mcu.usbCtrl.onUSBEnabled = () => { connected = false; attach(); mcu.usbCtrl.resetDevice(); };
    void enabled;
    cdc.onDeviceConnected = () => { connected = true; feed(); if (drive) msc = mscHost(cdc, mcu, msc); };
    cdc.onSerialData = (b) => onData(b);
    if (drive) {        // the drive's OUT endpoint asks for data before the drive host is set up: remember it
      const r0 = mcu.usbCtrl.onEndpointRead;
      mcu.usbCtrl.armed = {};
      mcu.usbCtrl.onEndpointRead = (ep, size) => { if (ep === cdc.outEndpoint) r0(ep, size); else mcu.usbCtrl.armed[ep] = size; };
    }
  };
  // rp2040js's CDC holds 512 bytes and drops the rest: a long line (the 2.6 KB signed list) lost its
  // middle and the chip never saw its newline. Bytes wait here and go in as the FIFO empties.
  let head = 0;
  const feed = () => {
    if (!connected) return;
    while (head < pending.length && !cdc.txFIFO.full) cdc.sendSerialByte(pending[head++]);
    if (head === pending.length) { pending.length = 0; head = 0; }
  };
  attach();
  mcu.core.PC = 0x10000000;
  return {
    mcu,
    get connected() { return connected; },
    get cdc() { return cdc; },
    /** drive: true: what the Mac's reads of the WEDGIE drive did (mscHost), or null */
    get drive() { return msc && msc.stats; },
    write(x) {
      const b = typeof x === "string" ? Buffer.from(x) : x;
      for (const c of b) pending.push(c);
      feed();
    },
    /** chip time in ms */
    get ms() { return clock.nanos / 1e6; },
    /** Run the chip for ms of its own time (the Simulator's loop, without its setTimeout pacing). */
    run(ms) {
      const until = clock.nanos + ms * 1e6, cyc = 8;   // 1e9 / 125 MHz
      let n = 0;
      while (clock.nanos < until) {
        if ((++n & 255) === 0) { if (pending.length) feed(); msc?.tick?.(clock.nanos / 1e6); }
        if (hook()) continue;
        if (mcu.core.waiting) clock.tick(Math.min(clock.nanosToNextAlarm, until - clock.nanos) || 1000);
        else clock.tick(mcu.core.executeInstruction() * cyc);
      }
    },
  };
}

/** Talk to a chip: wait for text, the raw REPL, JSON requests. Times are the chip's own. */
export function host(opts = {}) {
  let buf = "";
  const lines = [];
  const chip = boot({ ...opts, onData: (b) => { buf += Buffer.from(b).toString("latin1"); opts.onData?.(b); } });
  const self = {
    chip,
    get out() { return buf; },
    /** Run until fn(buf) is true or ms of chip time pass. */
    until(fn, ms = 5000, step = 5) {
      const end = chip.ms + ms;
      while (chip.ms < end) {
        if (fn(buf)) return true;
        chip.run(step);
      }
      return fn(buf);
    },
    take() { const b = buf; buf = ""; return b; },
    /** Raw REPL exec (only while the REPL is free: before main.py exists, or after a yes). */
    exec(code, ms = 20000) {
      self.take();
      chip.write("\r\x03\x03\x01");
      if (!self.until((b) => b.includes("raw REPL; CTRL-B to exit\r\n>"), 3000)) throw new Error("no raw REPL: " + JSON.stringify(buf.slice(-200)));
      self.take();
      chip.write(code);
      chip.write("\x04");
      if (!self.until((b) => /\x04[\s\S]*\x04>$/.test(b), ms)) throw new Error("exec timed out: " + JSON.stringify(buf.slice(-300)));
      const m = buf.match(/^OK([\s\S]*?)\x04([\s\S]*?)\x04>$/);
      chip.write("\x02");
      self.until((b) => b.endsWith(">>> "), 1000);
      if (!m) throw new Error("exec: " + JSON.stringify(buf.slice(0, 300)));
      if (m[2]) throw new Error(m[2]);
      return m[1];
    },
    /** Put a file on its flash (raw REPL). */
    put(name, data) {
      const b = Buffer.from(data);
      let code = `f=open(${JSON.stringify(name)},'wb')\nw=f.write\n`;
      for (let o = 0; o < b.length; o += 256) code += `w(${pyBytes(b.subarray(o, o + 256))})\n`;
      self.exec(code + "f.close()\n", 60000);
    },
    /** A JSON request to the slot; the answer whose id matches, or null. */
    req(msg, ms = 20000, raw = null) {
      chip.write(JSON.stringify(raw ? { ...msg, n: raw.length } : msg) + "\n");
      if (raw) chip.write(raw);              // a raw put: the bytes right after the line (0.3.16+)
      let got = null;
      const re = new RegExp(`\\{[^\\n]*"id": ${msg.id}[,}][^\\n]*\\n`);
      self.until((b) => { const m = b.match(re); if (m) { try { got = JSON.parse(m[0]); } catch { got = { type: "junk", line: m[0] }; } return true; } return false; }, ms);
      return got;
    },
  };
  return self;
}

function pyBytes(b) {
  let s = "b'";
  for (const c of b) s += c >= 32 && c < 127 && c !== 39 && c !== 92 ? String.fromCharCode(c) : "\\x" + c.toString(16).padStart(2, "0");
  return s + "'";
}

/** rp2040js reads flash but never writes it: nothing plays the flash chip behind the SSI, so every file
 *  write on the chip vanished (littlefs then fails: OSError 36, and no install could finish). This does
 *  the bootrom's two flash calls in JS instead: when the core reaches flash_range_erase ('RE') or
 *  flash_range_program ('RP') in the ROM's function table, the flash array changes and the call returns.
 *  Returns the hook run() checks before each instruction. */
function flashWrites(mcu, rom) {
  const fn = {};
  for (let o = rom.readUInt16LE(0x14); rom.readUInt16LE(o); o += 4)
    fn[String.fromCharCode(rom[o], rom[o + 1])] = rom.readUInt16LE(o + 2) & ~1;
  const RE = fn.RE, RP = fn.RP, r = mcu.core.registers;
  return () => {
    const pc = mcu.core.PC;
    if (pc !== RE && pc !== RP) return false;
    if (pc === RE) mcu.flash.fill(0xff, r[0], r[0] + r[1]);                     // (addr, count, block size, cmd)
    else for (let i = 0; i < r[2]; i++) mcu.flash[r[0] + i] &= mcu.readUint8(r[1] + i);   // (addr, data, count): bits go 1 -> 0
    mcu.core.PC = r[14] & ~1;                                                   // return to the caller (bx lr)
    return true;
  };
}

/** The Mac reading the WEDGIE drive at a plug-in (boot({ drive: true })). macOS mounts it as soon as it
 *  enumerates: INQUIRY, TEST UNIT READY, READ CAPACITY, MODE SENSE, then READ(10)s of the boot sector,
 *  the FATs, the root and every file on it (the underwear icon is most of it), and a TEST UNIT READY
 *  every second after. On a wedgie those reads are answered by Python (usbdev.py, wedgiedrive.py), right
 *  while main.py starts the app: that's when 0.3.13 broke on a real board, and nothing here did that
 *  before. Bulk-only transport on the mass-storage interface's own endpoints, next to the CDC host. */
function mscHost(cdc, mcu, prev) {
  const d = cdc.descriptors;
  let out = -1, inn = -1, isMsc = false;
  for (let i = 0; i < d.length && d[i]; i += d[i]) {
    if (d[i + 1] === 4) isMsc = d[i + 5] === 8;
    if (isMsc && d[i + 1] === 5 && (d[i + 3] & 3) === 2) { if (d[i + 2] & 0x80) inn = d[i + 2] & 15; else out = d[i + 2] & 15; }
  }
  const stats = prev ? prev.stats : { mounts: 0, commands: 0, reads: 0, bytes: 0, failed: 0, blocks: 0, errors: [] };
  if (out < 0 || inn < 0) return { stats };
  stats.mounts++;
  const usb = mcu.usbCtrl, w0 = usb.onEndpointWrite, r0 = usb.onEndpointRead;
  let tag = 1, cur = null, sendQ = null, readWaiting = usb.armed?.[out] || 0, blocks = 0, bs = 512;
  const queue = [];
  const cbw = (cb, len, dirIn) => {
    const b = new Uint8Array(31), v = new DataView(b.buffer);
    v.setUint32(0, 0x43425355, true); v.setUint32(4, tag++, true); v.setUint32(8, len, true);
    b[12] = dirIn ? 0x80 : 0; b[13] = 0; b[14] = cb.length; b.set(cb, 15);
    return b;
  };
  const cmd = (cb, len, then) => queue.push({ cb, len, then });
  const read10 = (lba, n) => [0x28, 0, lba >>> 24, (lba >> 16) & 255, (lba >> 8) & 255, lba & 255, 0, n >> 8, n & 255, 0];
  const next = () => {
    if (cur || !queue.length) return;
    cur = { ...queue.shift(), got: 0, data: [], csw: false };
    stats.commands++;
    sendQ = cbw(cur.cb, cur.len, cur.len > 0);
    if (readWaiting) { const s = sendQ; sendQ = null; readWaiting = 0; usb.endpointReadDone(out, s); }
  };
  usb.onEndpointRead = (ep, size) => {
    if (ep !== out) return r0(ep, size);
    if (sendQ) { const s = sendQ; sendQ = null; usb.endpointReadDone(out, s); } else readWaiting = size;
  };
  usb.onEndpointWrite = (ep, buf) => {
    if (ep !== inn) return w0(ep, buf);
    if (!cur) return;
    const isCsw = buf.length === 13 && buf[0] === 0x55 && buf[1] === 0x53 && buf[2] === 0x42 && buf[3] === 0x53;
    if (!isCsw || cur.got < cur.len && buf.length === 64) { cur.data.push(...buf); cur.got += buf.length; if (!isCsw) return; }
    const status = buf[12], c = cur; cur = null;
    if (status) { stats.failed++; if (stats.errors.length < 5) stats.errors.push(`scsi ${c.cb[0].toString(16)} status ${status}`); }
    if (c.cb[0] === 0x28) { stats.reads++; stats.bytes += c.got; }
    c.then?.(Uint8Array.from(c.data), status);
    next();
  };
  // the mount, as macOS does it
  cmd([0x12, 0, 0, 0, 36, 0], 36);                                  // INQUIRY
  cmd([0x00, 0, 0, 0, 0, 0], 0);                                    // TEST UNIT READY
  cmd([0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8, (r, st) => {             // READ CAPACITY(10)
    if (st || r.length < 8) return;
    const v = new DataView(r.buffer); blocks = v.getUint32(0) + 1; bs = v.getUint32(4); stats.blocks = blocks;
    cmd([0x1a, 0, 0x3f, 0, 192, 0], 192);                           // MODE SENSE(6)
    cmd(read10(0, 1), bs);                                          // the boot sector
    for (let pass = 0; pass < 2; pass++)                            // everything, twice: FATs, root, the icon
      for (let lba = 0; lba < blocks; lba += 8) { const n = Math.min(8, blocks - lba); cmd(read10(lba, n), n * bs); }
  });
  next();
  // then a TEST UNIT READY a second, as long as it stays mounted (run() calls tick with the chip's ms)
  let due = 0;
  const tick = (ms) => { if (ms < due) return; due = ms + 1000; if (!cur && !queue.length) { cmd([0x00, 0, 0, 0, 0, 0], 0); next(); } };
  return { stats, tick };
}
