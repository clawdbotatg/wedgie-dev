// A QR for an address with its blockie in the middle, like Instant Wallet (and punk wallet). Error correction H,
// so the covered middle still scans.
import { blo } from "blo";
import qrcode from "qrcode-generator";

export function addressQr(data: string, addr: string, cellSize = 6): string {
  const q = qrcode(0, "H"); q.addData(data); q.make();
  return `<div class="qr-mid">${q.createSvgTag({ cellSize, margin: 2, scalable: true })}<span><img src="${blo(addr as `0x${string}`)}" alt=""></span></div>`;
}
