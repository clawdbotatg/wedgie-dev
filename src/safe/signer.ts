// Whose signature is it? By Safe's own rules (checkNSignatures), so a list of [owner, signature] from outside (a link)
// can be held to them: the label beside a signature proves nothing (audit 11-13).
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytes, cat, checksum, hex, keccak256 } from "./eth";

/** The owner a Safe would take this signature for, or null if it doesn't read. v 0: a contract's (r is the
 *  contract); v 1: an approved hash (r is the owner); v 31/32: eth_sign, over the prefixed hash; 27/28: plain. */
export function signerOf(safeTxHash: string, signature: string): string | null {
  try {
    const b = bytes(signature), v = b[64];
    if (b.length < 65) return null;
    if (v === 0 || v === 1) return b.slice(0, 12).some((x) => x) ? null : checksum(hex(b.slice(12, 32)));
    const sign = v > 30;
    const rec = v - (sign ? 31 : 27);
    if (rec !== 0 && rec !== 1 || b.length !== 65) return null;
    const h = sign ? keccak256(cat(new TextEncoder().encode("\x19Ethereum Signed Message:\n32"), bytes(safeTxHash))) : bytes(safeTxHash);
    const pub = secp256k1.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(rec).recoverPublicKey(h).toRawBytes(false);
    return checksum(hex(keccak256(pub.slice(1)).slice(-20)));
  } catch { return null; }
}

/** The pairs whose signature really is its owner's, one per owner. */
export function ownSigs<T extends { owner: string; signature: string }>(safeTxHash: string, sigs: T[]): T[] {
  const out: T[] = [];
  for (const s of sigs) {
    const who = signerOf(safeTxHash, s.signature);
    if (who && who.toLowerCase() === s.owner.toLowerCase() && !out.some((x) => x.owner.toLowerCase() === who.toLowerCase())) out.push(s);
  }
  return out;
}
