// A real RP2040 in software for the page: rp2040js (MIT, Wokwi) running the very MicroPython build
// wedgie.dev flashes (public/mp/RPI_PICO.uf2), so the firmware, its .mpy files, its heap, its raw REPL
// and its USB are a real board's. The browser port of tools/rp2040/chip.mjs (same flash calls, same
// watchdog reboot, same USB replug), plus what a wedgie has around the chip: the ST7789 screen on SPI1,
// the nine buttons, and the I2C bus (a device answers through `i2c`).
// Runs the chip at most as fast as a real one; in practice JS runs it slower (chip time vs wall time: `ms`).
import { Simulator, USBCDC, ConsoleLogger, LogLevel } from "rp2040js";

export const FLASH_BYTES = 2 * 1024 * 1024;          // a Pico's flash (the .uf2's layout: fs from 0xa0000)
export const KEYS: Record<string, number> = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const DC = 8, W = 240, H = 240;

/** The bytes of a .uf2 laid into a blank flash. */
export function flashFromUf2(uf2: Uint8Array) {
  const img = new Uint8Array(FLASH_BYTES).fill(0xff);
  const v = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  for (let o = 0; o + 512 <= uf2.length; o += 512) {
    const addr = v.getUint32(o + 12, true) - 0x10000000, size = v.getUint32(o + 16, true);
    if (addr >= 0 && addr + size <= FLASH_BYTES) img.set(uf2.subarray(o + 32, o + 32 + size), addr);
  }
  return img;
}

export interface I2CDevice {
  /** The 7-bit address it answers (it may still NACK while busy). */
  addr: number;
  connect(read: boolean): boolean;           // ack?
  write(b: number): boolean;                 // ack?
  read(): number;
  stop(): void;
}

export interface ChipOpts {
  rom: Uint8Array;                 // bootrom-b1.bin
  flash: Uint8Array;               // FLASH_BYTES
  onData?: (b: Uint8Array) => void;        // bytes the chip sends on USB serial
  onUsb?: (up: boolean) => void;           // the USB port appears (enumerated) or drops
  onFrame?: (frame: Uint8Array) => void;   // 240x240 RGB565 big-endian, after a push to the panel
  onFlash?: () => void;                    // the flash changed
  i2c?: I2CDevice | null;
  uid?: Uint8Array;                        // the flash chip's 8-byte unique ID (machine.unique_id()): the board's ID
}

export function boot(o: ChipOpts) {
  let sim: any, mcu: any, clock: any, hook: () => boolean, flashRE = -1, flashRP = -1, cdc: any, connected = false, base = 0, rebooting = false;
  const flash = o.flash;
  const pending: number[] = [];
  let head = 0;
  const held = new Set<string>();
  const frame = new Uint8Array(W * H * 2);
  const lcd = { cmd: 0, args: [] as number[], xs: 0, xe: W - 1, ys: 0, ye: H - 1, cur: 0, dirty: false };

  const make = (wd?: { scratch: Uint32Array; reason: number }) => {
    if (clock) base += clock.nanos / 1e6;
    sim = new Simulator();
    mcu = sim.rp2040; clock = sim.clock;
    mcu.loadBootrom(new Uint32Array(o.rom.buffer, o.rom.byteOffset, o.rom.length / 4));
    mcu.logger = new ConsoleLogger(LogLevel.Error);
    mcu.flash.set(flash);
    const w = mcu.peripherals[0x40058];     // WATCHDOG
    if (wd) { w.scratchData.set(wd.scratch); w.reason = wd.reason; }
    w.onWatchdogTrigger = () => { rebooting = true; };
    for (const [k, p] of Object.entries(KEYS)) mcu.gpio[p].setInputValue(!held.has(k));   // pulled up; a held key reads low
    hook = flashWrites();
    if (o.uid) uniqueId(o.uid);
    screen();
    bus();
    if (connected) { connected = false; o.onUsb?.(false); }
    attach();
    // A re-enumeration with the controller already on (the WEDGIE drive added after boot) only drops and
    // raises the D+ pull-up, which rp2040js ignores; a real host sees a replug (tools/rp2040/chip.mjs).
    const sie = mcu.usbCtrl.handleSieCtrlWrite.bind(mcu.usbCtrl);
    let pullup = false;
    mcu.usbCtrl.handleSieCtrlWrite = (v: number) => {
      sie(v);
      const up = !!(mcu.usbCtrl.sieCtrl & (1 << 16));
      if (up && !pullup && mcu.usbCtrl.mainCtrl & 1 && !mcu.usbCtrl.hostMode) mcu.usbCtrl.onUSBEnabled?.();
      pullup = up;
    };
    mcu.core.PC = 0x10000000;
  };
  const attach = () => {
    cdc = new USBCDC(mcu.usbCtrl);
    mcu.usbCtrl.onUSBEnabled = () => {
      if (connected) { connected = false; o.onUsb?.(false); }
      pending.length = 0; head = 0;
      attach(); mcu.usbCtrl.resetDevice();
    };
    cdc.onDeviceConnected = () => { connected = true; o.onUsb?.(true); feed(); };
    cdc.onSerialData = (b: Uint8Array) => o.onData?.(b);
  };
  // rp2040js's CDC holds 512 bytes and drops the rest: bytes wait here and go in as the FIFO empties.
  const feed = () => {
    if (!connected) return;
    while (head < pending.length && !cdc.txFIFO.full) cdc.sendSerialByte(pending[head++]);
    if (head === pending.length) { pending.length = 0; head = 0; }
  };

  // ---- the screen: an ST7789 on SPI1, DC on GP8. Each byte takes its real time on the wire.
  function screen() {
    const spi = mcu.spi[1];
    const alarm = clock.createAlarm(() => spi.completeTransmit(0));
    spi.onTransmit = (b: number) => {
      lcdByte(b);
      // baud = clk_peri / (CPSDVSR * (1 + SCR)); clk_peri is 125 MHz (lcd.py machine.freq)
      const div = (spi.clockDivisor || 2) * (1 + ((spi.control0 >> 8) & 0xff));
      alarm.schedule((8 * 1e9 * div) / 125e6);
    };
  }
  function lcdByte(b: number) {
    if (!mcu.gpio[DC].outputValue) { lcd.cmd = b; lcd.args = []; if (b === 0x2c) lcd.cur = 0; return; }
    if (lcd.cmd === 0x2a || lcd.cmd === 0x2b) {
      lcd.args.push(b);
      if (lcd.args.length === 4) {
        const s = (lcd.args[0] << 8) | lcd.args[1], e = (lcd.args[2] << 8) | lcd.args[3];
        if (lcd.cmd === 0x2a) { lcd.xs = s; lcd.xe = e; } else { lcd.ys = s; lcd.ye = e; }
      }
      return;
    }
    if (lcd.cmd !== 0x2c) return;
    const ww = lcd.xe - lcd.xs + 1, p = lcd.cur >> 1;
    const x = lcd.xs + (p % ww), y = lcd.ys + Math.floor(p / ww);
    if (x < W && y < H) frame[(y * W + x) * 2 + (lcd.cur & 1)] = b;
    lcd.cur++;
    lcd.dirty = true;
  }

  // ---- I2C0 (GP4/GP5): the Trust M's bus. No device: every address NACKs, like a board without the chip.
  function bus() {
    const i2c = mcu.i2c[0];
    let dev: I2CDevice | null = null;
    i2c.onStart = () => i2c.completeStart();
    i2c.onConnect = (addr: number, mode: number) => {
      dev = o.i2c && o.i2c.addr === addr ? o.i2c : null;
      i2c.completeConnect(!!dev && dev.connect(mode === 1));
    };
    i2c.onWriteByte = (b: number) => i2c.completeWrite(!!dev && dev.write(b));
    i2c.onReadByte = () => i2c.completeRead(dev ? dev.read() : 0xff);
    i2c.onStop = () => { dev?.stop(); dev = null; i2c.completeStop(); };
  }

  // The flash chip's Read Unique ID (0x4B, 4 dummy bytes, then 8 ID bytes), one byte in and out of the
  // SSI's data register at a time (pico-sdk flash_get_unique_id). rp2040js answers 0 to every byte.
  function uniqueId(uid: Uint8Array) {
    const ssi = mcu.peripherals[0x18000], w0 = ssi.writeUint32.bind(ssi);
    let i = -1;
    ssi.writeUint32 = (off: number, v: number) => {
      if (off === 0x60) { i = v === 0x4b && (i < 0 || i >= 12) ? 0 : i >= 0 && i < 12 ? i + 1 : -1; if (i >= 5) { ssi.dr0 = uid[i - 5]; return; } }
      w0(off, v);
    };
  }

  /** rp2040js reads flash but never writes it: the bootrom's erase ('RE') and program ('RP') calls are
   *  done here in JS when the core reaches them (tools/rp2040/chip.mjs flashWrites). */
  function flashWrites() {
    const rom = o.rom, u16 = (i: number) => rom[i] | (rom[i + 1] << 8);
    const fn: Record<string, number> = {};
    for (let i = u16(0x14); u16(i); i += 4) fn[String.fromCharCode(rom[i], rom[i + 1])] = u16(i + 2) & ~1;
    const RE = fn.RE, RP = fn.RP, r = mcu.core.registers;
    flashRE = RE; flashRP = RP;
    return () => {
      const pc = mcu.core.PC;
      if (pc !== RE && pc !== RP) return false;
      if (pc === RE) { mcu.flash.fill(0xff, r[0], r[0] + r[1]); if (r[0] < FLASH_BYTES) flash.fill(0xff, r[0], Math.min(FLASH_BYTES, r[0] + r[1])); }
      else for (let i = 0; i < r[2]; i++) { const v = mcu.flash[r[0] + i] & mcu.readUint8(r[1] + i); mcu.flash[r[0] + i] = v; if (r[0] + i < FLASH_BYTES) flash[r[0] + i] = v; }
      o.onFlash?.();
      mcu.core.PC = r[14] & ~1;
      return true;
    };
  }

  const reboot = () => {
    rebooting = false;
    const w = mcu.peripherals[0x40058];
    pending.length = 0; head = 0;
    make({ scratch: new Uint32Array(w.scratchData), reason: w.reason });
  };
  make();

  return {
    get connected() { return connected; },
    get mcu() { return mcu; },
    frame,
    /** Bytes to its USB serial (lost while the port is down, like a real host's writes). */
    write(b: Uint8Array) {
      if (!connected) return;
      for (const c of b) pending.push(c);
      feed();
    },
    key(name: string, down: boolean) {
      if (!(name in KEYS)) return;
      if (down) held.add(name); else held.delete(name);
      mcu.gpio[KEYS[name]].setInputValue(!down);
    },
    /** Pulled the plug and plugged it back in: everything fresh but the flash. */
    powerCycle() { make(); },
    /** chip time in ms (across reboots) */
    get ms() { return base + clock.nanos / 1e6; },
    /** Run the chip for ms of its own time. Calls onFrame once at the end if the screen changed. */
    run(ms: number) {
      let end = clock.nanos + ms * 1e6, core = mcu.core, regs = core.registers, n = 0;
      while (clock.nanos < end) {
        if (rebooting) { const left = end - clock.nanos; reboot(); end = clock.nanos + left; core = mcu.core; regs = core.registers; continue; }
        if ((++n & 255) === 0 && pending.length) feed();
        const pc = regs[15];
        if ((pc === flashRE || pc === flashRP) && hook()) continue;
        if (core.waiting) clock.tick(Math.min(clock.nanosToNextAlarm, end - clock.nanos) || 1000);
        else clock.tick(core.executeInstruction() * 8);     // 8 ns a cycle: 125 MHz
      }
      if (lcd.dirty) { lcd.dirty = false; o.onFrame?.(frame); }
    },
  };
}
export type Chip = ReturnType<typeof boot>;
