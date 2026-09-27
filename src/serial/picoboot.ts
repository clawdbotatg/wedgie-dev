// Put MicroPython on a Pico in BOOTSEL mode (a blank one boots there) from the browser: WebUSB to the
// bootrom's PICOBOOT interface (RP2040 datasheet 2.8.5, RP2350 datasheet 5.6). Erase + write each 4 KB
// sector the UF2 touches, erase the rest of the build's flash (the old filesystem: a used wedgie
// comes back as blank as a new one), then reboot into it. Only blocks for this chip's family are written, which
// skips the RP2350-E10 "absolute" block MicroPython's RP2350 UF2 starts with.
import { RPI_VID } from "./wedgies";

export const BOOT_PIDS: Record<number, "RP2040" | "RP2350"> = { 0x0003: "RP2040", 0x000f: "RP2350" };
const FAMILY = { RP2040: 0xe48bff56, RP2350: 0xe48bff59 };
// The plain builds boot on any board; a board found to have the Pico W's WiFi chip gets the W build.
const UF2 = { RP2040: ["/mp/RPI_PICO.uf2", "/mp/RPI_PICO_W.uf2"], RP2350: ["/mp/RPI_PICO2.uf2", "/mp/RPI_PICO2_W.uf2"] };
const MAGIC = 0x431fd10b;
const FLASH = 0x10000000, FLASH_END = 0x11000000, SECTOR = 4096, BLOCK = 0x10000;
// The flash size each MicroPython build assumes (its filesystem ends there): Pico 2 MB, Pico 2 4 MB.
const BUILD_FLASH = { RP2040: 2 << 20, RP2350: 4 << 20 };
const CMD = { exclusive: 0x01, reboot: 0x02, erase: 0x03, write: 0x05, exitXip: 0x06, reboot2: 0x0a };

export const usbSupported = () => "usb" in navigator;
export const isBoot = (d: USBDevice) => d.vendorId === RPI_VID && d.productId in BOOT_PIDS;
export const pickBoot = () => navigator.usb.requestDevice({ filters: Object.keys(BOOT_PIDS).map((p) => ({ vendorId: RPI_VID, productId: +p })) });
export async function bootDevices() { return usbSupported() ? (await navigator.usb.getDevices()).filter(isBoot) : []; }

/** The UF2's flash contents for one chip, as 4 KB sectors (unwritten bytes 0xFF). */
export function sectors(uf2: ArrayBuffer, family: number) {
  const dv = new DataView(uf2), out = new Map<number, Uint8Array<ArrayBuffer>>();
  for (let o = 0; o + 512 <= uf2.byteLength; o += 512) {
    if (dv.getUint32(o, true) !== 0x0a324655 || dv.getUint32(o + 4, true) !== 0x9e5d5157 || dv.getUint32(o + 508, true) !== 0x0ab16f30) throw new Error("bad UF2 block " + o / 512);
    const flags = dv.getUint32(o + 8, true), addr = dv.getUint32(o + 12, true), n = dv.getUint32(o + 16, true);
    if (flags & 1) continue;                                                         // not for main flash
    if (flags & 0x2000 && dv.getUint32(o + 28, true) !== family) continue;           // another chip's block
    if (addr < FLASH || addr + n > FLASH_END || n > 476) continue;
    for (let i = 0; i < n; ) {
      const a = addr + i, base = a & ~(SECTOR - 1), m = Math.min(n - i, base + SECTOR - a);
      let s = out.get(base);
      if (!s) out.set(base, (s = new Uint8Array(SECTOR).fill(0xff)));
      s.set(new Uint8Array(uf2, o + 32 + i, m), a - base);
      i += m;
    }
  }
  return out;
}

/** Wipe a BOOTSEL Pico, put MicroPython on it and reboot it. It comes back as a serial port. */
export async function flashMicroPython(dev: USBDevice, onProgress: (p: number) => void, wifi = false) {
  const chip = BOOT_PIDS[dev.productId];
  const uf2 = await (await fetch(UF2[chip][wifi ? 1 : 0])).arrayBuffer();
  const secs = [...sectors(uf2, FAMILY[chip])].sort((a, b) => a[0] - b[0]);
  if (!secs.length) throw new Error("the MicroPython file has nothing for " + chip);
  const wipeFrom = Math.ceil((secs[secs.length - 1][0] + SECTOR) / BLOCK) * BLOCK, wipeTo = FLASH + BUILD_FLASH[chip];
  const steps = secs.length + (wipeTo - wipeFrom) / BLOCK;

  await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  const itf = dev.configuration!.interfaces.find((i) => i.alternates[0].interfaceClass === 0xff);
  if (!itf) throw new Error("this Pico's boot mode has no PICOBOOT interface");
  const eps = itf.alternates[0].endpoints;
  const epOut = eps.find((e) => e.direction === "out")!.endpointNumber, epIn = eps.find((e) => e.direction === "in")!.endpointNumber;
  await dev.claimInterface(itf.interfaceNumber);
  await dev.controlTransferOut({ requestType: "vendor", recipient: "interface", request: 0x41, value: 0, index: itf.interfaceNumber }); // INTERFACE_RESET

  let token = 1;
  const status = async () => {
    const r = await dev.controlTransferIn({ requestType: "vendor", recipient: "interface", request: 0x42, value: 0, index: itf.interfaceNumber }, 16).catch(() => null);
    return r?.data && r.data.byteLength >= 8 ? r.data.getUint32(4, true) : -1;
  };
  const ok = async (r: USBOutTransferResult | USBInTransferResult, what: string) => {
    if (r.status !== "ok") throw new Error(`${what}: ${r.status}, bootrom status ${await status()}`);
  };
  async function cmd(id: number, args: number[], data?: Uint8Array<ArrayBuffer>) {
    const b = new DataView(new ArrayBuffer(32));
    b.setUint32(0, MAGIC, true); b.setUint32(4, token++, true);
    b.setUint8(8, id); b.setUint8(9, id === CMD.exclusive ? 1 : args.length * 4);
    b.setUint32(12, data ? data.byteLength : 0, true);
    if (id === CMD.exclusive) b.setUint8(16, args[0]); else args.forEach((v, i) => b.setUint32(16 + 4 * i, v >>> 0, true));
    await ok(await dev.transferOut(epOut, b.buffer), `command 0x${id.toString(16)}`);
    if (data) await ok(await dev.transferOut(epOut, data), `data for 0x${id.toString(16)}`);
    await ok(await dev.transferIn(epIn, 64), `ack for 0x${id.toString(16)}`);           // zero-length ack
  }

  await cmd(CMD.exclusive, [1]);
  if (chip === "RP2040") await cmd(CMD.exitXip, []);
  for (let i = 0; i < secs.length; i++) {
    const [addr, data] = secs[i];
    await cmd(CMD.erase, [addr, SECTOR]);
    await cmd(CMD.write, [addr, SECTOR], data);
    onProgress((i + 1) / steps);
  }
  for (let a = wipeFrom, i = secs.length; a < wipeTo; a += BLOCK) {
    await cmd(CMD.erase, [a, BLOCK]);
    onProgress(++i / steps);
  }
  // The reboot cuts the USB link, so its ack may never come.
  try {
    if (chip === "RP2040") await cmd(CMD.reboot, [0, 0x20042000, 500]);
    else await cmd(CMD.reboot2, [0, 500, 0, 0]);
  } catch {}
  try { await dev.close(); } catch {}
}
