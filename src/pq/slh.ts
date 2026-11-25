// Checks an SLH-DSA signature (FIPS 205; the SHA2-128s and SHA2-128f sets) in the browser. /pq uses it on
// what a wedgie signed. Signing is the wedgie's job (clawdbotatg/wedgie-pq, mp/slh/slh.c); this file only
// checks. tools/test_slh.mjs runs it against signatures OpenSSL also accepts.
import { sha256 } from "@noble/hashes/sha2";

export type SlhSet = "128s" | "128f";
/** h' (tree height per layer), d (layers), a (FORS tree height), k (FORS trees). */
const SETS: Record<SlhSet, [number, number, number, number]> = { "128s": [9, 7, 12, 14], "128f": [3, 22, 6, 33] };
const N = 16, LEN = 35;
export const sigSize = (set: SlhSet) => { const [hp, d, a, k] = SETS[set]; return N * (1 + k * (a + 1) + d * (LEN + hp)); };

const WOTS_HASH = 0, WOTS_PK = 1, TREE = 2, FORS_TREE = 3, FORS_ROOTS = 4;
/** An address, in the 22 bytes the SHA2 sets hash: layer(1) tree(8) type(1) then three 4-byte words. */
class Adrs {
  b = new Uint8Array(22);
  v = new DataView(this.b.buffer);
  layer(n: number) { this.b[0] = n; return this; }
  tree(t: bigint) { this.v.setBigUint64(1, t); return this; }
  type(t: number) { this.b[9] = t; this.b.fill(0, 10); return this; }
  w(i: 1 | 2 | 3, n: number) { this.v.setUint32(6 + 4 * i, n); return this; }
  get(i: 1 | 2 | 3) { return this.v.getUint32(6 + 4 * i); }
  copy() { const a = new Adrs(); a.b.set(this.b); return a; }
}

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of p) { o.set(x, at); at += x.length; } return o; };

/** What the signer hashes for a plain message with no context (FIPS 205 slh_sign). */
export const wrap = (msg: Uint8Array) => cat(new Uint8Array(2), msg);

/** True if sig is `set`'s signature of msg (already wrapped) by public key pk (PK.seed || PK.root, 32 bytes). */
export function verify(set: SlhSet, pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  const [hp, d, a, k] = SETS[set];
  if (pk.length !== 2 * N || sig.length !== sigSize(set)) return false;
  const seed = pk.subarray(0, N), root = pk.subarray(N);
  const seeded = sha256.create().update(seed).update(new Uint8Array(64 - N));
  const T = (ad: Adrs, m: Uint8Array) => seeded.clone().update(ad.b).update(m).digest().subarray(0, N);

  // the message digest: which FORS leaves, which tree, which leaf
  const R = sig.subarray(0, N);
  const inner = sha256(cat(R, seed, root, msg));
  const dig = cat(...[0, 1].map((c) => sha256(cat(R, seed, inner, new Uint8Array([0, 0, 0, c])))));
  const mdLen = Math.ceil((k * a) / 8), tBits = hp * (d - 1), tLen = Math.ceil(tBits / 8), lLen = Math.ceil(hp / 8);
  const int = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
  let tree = int(dig.subarray(mdLen, mdLen + tLen)) & ((1n << BigInt(tBits)) - 1n);
  let leaf = Number(int(dig.subarray(mdLen + tLen, mdLen + tLen + lLen)) & ((1n << BigInt(hp)) - 1n));

  /** Up an authentication path from a node (ad's w3 is its index at height 0) to the root. */
  const climb = (ad: Adrs, idx: number, height: number, auth: Uint8Array, node: Uint8Array) => {
    for (let j = 0; j < height; j++) {
      ad.w(2, j + 1).w(3, ad.get(3) >>> 1);
      const sib = auth.subarray(j * N, (j + 1) * N);
      node = (idx >> j) & 1 ? T(ad, cat(sib, node)) : T(ad, cat(node, sib));
    }
    return node;
  };

  // FORS: the public key its part of the signature points to
  let at = N;
  const ad = new Adrs().tree(tree).type(FORS_TREE).w(1, leaf);
  const roots: Uint8Array[] = [];
  const bits = int(dig.subarray(0, mdLen)), total = mdLen * 8;
  for (let i = 0; i < k; i++) {
    const idx = Number((bits >> BigInt(total - a * (i + 1))) & ((1n << BigInt(a)) - 1n));
    const sk = sig.subarray(at, at + N), auth = sig.subarray(at + N, at + (a + 1) * N);
    at += (a + 1) * N;
    ad.w(2, 0).w(3, i * 2 ** a + idx);
    roots.push(climb(ad, idx, a, auth, T(ad, sk)));
  }
  let node = T(ad.copy().type(FORS_ROOTS).w(1, leaf), cat(...roots));

  // the hypertree: each layer's WOTS key signs the node below; the top must be the public key's root
  for (let j = 0; j < d; j++) {
    const lad = new Adrs().layer(j).tree(tree).type(WOTS_HASH).w(1, leaf);
    const dg: number[] = [];
    for (const x of node) dg.push(x >> 4, x & 15);
    const csum = dg.reduce((s, x) => s + 15 - x, 0);
    dg.push((csum >> 8) & 15, (csum >> 4) & 15, csum & 15);
    const ends: Uint8Array[] = [];
    for (let i = 0; i < LEN; i++) {
      let x: Uint8Array = sig.subarray(at + i * N, at + (i + 1) * N);
      lad.w(2, i);
      for (let s = dg[i]; s < 15; s++) x = T(lad.w(3, s), x);
      ends.push(x);
    }
    const wpk = T(lad.copy().type(WOTS_PK).w(1, leaf), cat(...ends));
    const auth = sig.subarray(at + LEN * N, at + (LEN + hp) * N);
    at += (LEN + hp) * N;
    node = climb(lad.type(TREE).w(3, leaf), leaf, hp, auth, wpk);
    leaf = Number(tree & ((1n << BigInt(hp)) - 1n));
    tree >>= BigInt(hp);
  }
  return node.every((x, i) => x === root[i]);
}

/** A throwaway key's parts: what the signer needs. Random, from this browser. */
export const testKey = () => ({ skSeed: crypto.getRandomValues(new Uint8Array(N)), skPrf: crypto.getRandomValues(new Uint8Array(N)), pkSeed: crypto.getRandomValues(new Uint8Array(N)) });
