// Is the contract at an address one of Safe's own? Anything can answer getOwners() (audit 11-13): a link to a fake
// that names the wedgie as an owner was remembered and written into the wedgie's own list with no click. A real
// Safe is one of Safe's proxies (its code, by hash) pointing at one of Safe's singletons (storage slot 0).
// Read on chain 2026-11-14 (Ethereum and Base): the proxy code from each factory and from Safes it made, and
// VERSION() on each singleton.
import { bytes, hex, keccak256 } from "./eth";

/** keccak256 of the proxy's runtime code, its first 20 bytes: Safe 1.1.1, 1.3.0, 1.4.1, 1.5.0. */
export const PROXY_CODE = ["aea7d4252f6245f301e540cfbee27d3a88de543a", "b89c1b3bdf2cf8827818646bce9a8f6e372885f8",
  "d7d408ebcd99b2b70be43e20253d6d92a8ea8fab", "4e381985ca68b3e5d27b4425fa581c19cf33146d"];
/** Safe's singletons, lowercase: 1.1.1, 1.2.0, 1.3.0 (Safe, L2, and both again for EIP-155 chains), 1.4.1 (Safe, L2), 1.5.0 (L2, Safe). */
export const SINGLETONS = ["0x34cfac646f301356faa8b21e94227e3583fe3f5f", "0x6851d6fdfafd08c0295c392436245e5bc78b0185",
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552", "0x3e5c63644e683549055b9be8653de26e0b4cd36e",
  "0x69f4d1788e39c87893c980c06edf4b7f686e2938", "0xfb1bffc9d739b8d520daf37df666da4c687191ea",
  "0x41675c099f32341bf84bfc5382af534df5c7461a", "0x29fcb43b46531bca003ddc8fcb67ffe91900c762",
  "0xedd160febbd92e350d4d398fb636302fccd67c7e", "0xff51a5898e281db6dfc7855790607438df2ca44b"];

/** code: eth_getCode of the address; slot0: eth_getStorageAt(address, 0). */
export function realSafe(code: string, slot0: string): boolean {
  try {
    if (!/^0x([0-9a-fA-F]{2})+$/.test(code) || !/^0x[0-9a-fA-F]{64}$/.test(slot0)) return false;
    const h = hex(keccak256(bytes(code))).slice(2, 42);
    return PROXY_CODE.includes(h) && /^0x0{24}/.test(slot0) && SINGLETONS.includes("0x" + slot0.slice(26).toLowerCase());
  } catch { return false; }
}
