// The little Ethereum the /safe page needs, without a library: keccak256, ABI words, the Safe tx hash,
// a wedgie's signer address (CREATE2, no RPC), and the Safe signature for it. The wedgie app is
// clawdbotatg/wedgie-safe; it works out the same hash itself and signs only on a real A press.

const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn,
  0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an,
  0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const PI = ROT.map((_, i) => (i / 5 | 0) + 5 * ((2 * (i % 5) + 3 * (i / 5 | 0)) % 5));
const M = (1n << 64n) - 1n;
const rol = (v: bigint, r: number) => (r ? ((v << BigInt(r)) | (v >> BigInt(64 - r))) & M : v);

function f(A: bigint[]) {
  const B = new Array<bigint>(25), C = new Array<bigint>(5);
  for (const rc of RC) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let i = 0; i < 25; i++) B[PI[i]] = rol(A[i] ^ C[(i + 4) % 5] ^ rol(C[(i + 1) % 5], 1), ROT[i]);
    for (let i = 0; i < 25; i++) A[i] = B[i] ^ (~B[i - (i % 5) + ((i + 1) % 5)] & M & B[i - (i % 5) + ((i + 2) % 5)]);
    A[0] ^= rc;
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const A = new Array<bigint>(25).fill(0n);
  const n = data.length, full = n - (n % 136);
  const last = new Uint8Array(136);
  last.set(data.subarray(full));
  last[n - full] ^= 1;
  last[135] ^= 0x80;
  const absorb = (b: Uint8Array, off: number) => {
    for (let i = 0; i < 17; i++) {
      let v = 0n;
      for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(b[off + 8 * i + j]);
      A[i] ^= v;
    }
    f(A);
  };
  for (let off = 0; off < full; off += 136) absorb(data, off);
  absorb(last, 0);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[8 * i + j] = Number((A[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}

export const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function bytes(h: string): Uint8Array {
  const s = h.replace(/^0x/i, "");
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}
export const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) { o.set(x, i); i += x.length; }
  return o;
};
export const word = (n: bigint | number | string) => bytes(BigInt(n).toString(16).padStart(64, "0"));
export const aword = (a: string) => cat(new Uint8Array(12), bytes(a));
export const keccakText = (s: string) => keccak256(new TextEncoder().encode(s));
export const selector = (sig: string) => hex(keccakText(sig).slice(0, 4));
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** EIP-55 checksum (Safe's API wants it). */
export function checksum(a: string) {
  const s = a.toLowerCase().replace(/^0x/, "");
  const h = hex(keccakText(s)).slice(2);
  return "0x" + [...s].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

export type SafeTx = {
  to: string; value: string; data: string; operation: number; safeTxGas: string | number; baseGas: string | number;
  gasPrice: string | number; gasToken: string; refundReceiver: string; nonce: number | string;
};

const DOMAIN = hex(keccakText("EIP712Domain(uint256 chainId,address verifyingContract)"));
const SAFE_TX = hex(keccakText("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"));

/** Safe 1.3+'s getTransactionHash. */
export function safeTxHash(chainId: number, safe: string, t: SafeTx) {
  const domain = keccak256(cat(bytes(DOMAIN), word(chainId), aword(safe)));
  const st = keccak256(cat(bytes(SAFE_TX), aword(t.to), word(t.value), keccak256(bytes(t.data || "0x")), word(t.operation),
    word(t.safeTxGas), word(t.baseGas), word(t.gasPrice), aword(t.gasToken), aword(t.refundReceiver), word(t.nonce)));
  return hex(keccak256(cat(bytes("0x1901"), domain, st)));
}

// Safe's passkey signer (safe-modules passkey v0.2.1), the same address on every chain it's on.
export const FACTORY = "0x1d31F259eE307358a26dFb23EB365939E8641195";
const SINGLETON = "0x4E27b51350e6c2083EE19011120F50DAfEc5CA50";
// Verify with the chain's P-256 precompile (EIP-7951 / RIP-7212) and no fallback contract.
export const VERIFIERS = 0x100n << 160n;
// SafeWebAuthnSignerProxy's creation code, from the factory's bytecode on Base (it CREATE2s this).
const PROXY_CODE = "0x610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b2578084926080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c98239608051816082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b600052604160045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f000000000000000000000000000000000000000000000000000000000000000060a03601527f000000000000000000000000000000000000000000000000000000000000000036608001523660006080376000806056360160807f00000000000000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fea26469706673582212201660515548d15702d720bbc046b457ca85e941a4559ab9f9518488e4c82e5ee964736f6c634300081a0033";

export function signerAddress(x: string, y: string) {
  const code = keccak256(cat(bytes(PROXY_CODE), aword(SINGLETON), word(x), word(y), word(VERIFIERS)));
  return checksum(hex(keccak256(cat(bytes("0xff"), bytes(FACTORY), new Uint8Array(32), code)).slice(12)));
}

export type WedgieSig = { r: string; s: string; authenticatorData: string; clientDataFields: string };

/** The signer's signature as the signer contract reads it: abi.encode(authenticatorData, clientDataFields, r, s). */
export function webauthnSig(g: WedgieSig) {
  const pad = (b: Uint8Array) => cat(b, new Uint8Array((32 - (b.length % 32)) % 32));
  const a = bytes(g.authenticatorData), fld = new TextEncoder().encode(g.clientDataFields);
  const ae = cat(word(a.length), pad(a)), fe = cat(word(fld.length), pad(fld));
  return cat(word(128), word(128 + ae.length), word(g.r), word(g.s), ae, fe);
}

/** A Safe contract signature (v = 0) for one owner: r = the owner, s = where its data starts. */
export function safeSignature(owner: string, g: WedgieSig) {
  const w = webauthnSig(g);
  return hex(cat(aword(owner), word(65), new Uint8Array([0]), word(w.length), w));
}

// ---- ABI: enough for setup, createProxyWithNonce, aggregate3, addOwnerWithThreshold ----

const padTo32 = (b: Uint8Array) => cat(b, new Uint8Array((32 - (b.length % 32)) % 32));
/** One argument: a 32-byte word as is, or { dyn } = an encoded tail the head points at. */
export type Arg = Uint8Array | { dyn: Uint8Array };
export function encode(args: Arg[]): Uint8Array {
  const head: Uint8Array[] = [], tail: Uint8Array[] = [];
  let at = args.length * 32;
  for (const a of args) {
    if (a instanceof Uint8Array) { head.push(a); continue; }
    head.push(word(at)); tail.push(a.dyn); at += a.dyn.length;
  }
  return cat(...head, ...tail);
}
export const dynBytes = (h: string | Uint8Array) => { const b = typeof h === "string" ? bytes(h) : h; return { dyn: cat(word(b.length), padTo32(b)) }; };
export const dynAddrs = (as: string[]) => ({ dyn: cat(word(as.length), ...as.map(aword)) });
/** Calldata: the function's selector and its encoded arguments. */
export const call = (sig: string, args: Arg[]) => selector(sig) + hex(encode(args)).slice(2);

// ---- a new Safe (Safe 1.4.1, L2 singleton: the same addresses on every chain here) ----

export const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_L2 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** SafeProxyFactory's ProxyCreation(proxy indexed, singleton): the new Safe's address is topics[1]. */
export const PROXY_CREATION = hex(keccakText("ProxyCreation(address,address)"));

export const createSignerData = (x: string, y: string) => call("createSigner(uint256,uint256,uint176)", [word(x), word(y), word(VERIFIERS)]);

/** One wallet transaction: the wedgie's signer contract (if it isn't there yet), then the Safe. */
export function newSafeData(x: string, y: string, owners: string[], threshold: number, salt: bigint) {
  const Z = new Uint8Array(32);
  const setup = call("setup(address[],uint256,address,bytes,address,address,uint256,address)",
    [dynAddrs(owners), word(threshold), Z, dynBytes("0x"), aword(FALLBACK_HANDLER), Z, Z, Z]);
  const create = call("createProxyWithNonce(address,bytes,uint256)", [aword(SAFE_L2), dynBytes(setup), word(salt)]);
  const one = (to: string, allowFailure: boolean, data: string) => ({ dyn: encode([aword(to), word(allowFailure ? 1 : 0), dynBytes(data)]) });
  const calls = [one(FACTORY, true, createSignerData(x, y)), one(SAFE_FACTORY, false, create)];
  return call("aggregate3((address,bool,bytes)[])", [{ dyn: cat(word(calls.length), encode(calls)) }]);
}

export const addOwnerData = (owner: string, threshold: number) => call("addOwnerWithThreshold(address,uint256)", [aword(owner), word(threshold)]);

// ---- a browser wallet's signature (eth_signTypedData_v4) ----

export function typedData(chainId: number, safe: string, t: SafeTx) {
  const s = (v: unknown) => String(v);
  return {
    types: {
      EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      SafeTx: [["to", "address"], ["value", "uint256"], ["data", "bytes"], ["operation", "uint8"], ["safeTxGas", "uint256"], ["baseGas", "uint256"],
        ["gasPrice", "uint256"], ["gasToken", "address"], ["refundReceiver", "address"], ["nonce", "uint256"]].map(([name, type]) => ({ name, type })),
    },
    primaryType: "SafeTx",
    domain: { chainId, verifyingContract: safe },
    message: { to: t.to, value: s(t.value), data: t.data || "0x", operation: +t.operation, safeTxGas: s(t.safeTxGas), baseGas: s(t.baseGas),
      gasPrice: s(t.gasPrice), gasToken: t.gasToken, refundReceiver: t.refundReceiver, nonce: s(t.nonce) },
  };
}
/** Safe wants v = 27/28; a few wallets answer 0/1. */
export function ecdsa(sig: string) {
  const b = bytes(sig);
  if (b.length !== 65) throw new Error("The wallet's signature isn't 65 bytes.");
  if (b[64] < 27) b[64] += 27;
  return hex(b);
}

/**
 * Every owner's signature as execTransaction reads them: sorted by owner, a 65-byte head each, and the
 * contract signatures' data after the heads (each head's s = where its data starts). Takes signatures as
 * Safe's API keeps them (a contract one is its own head + data) and moves the data.
 */
export function packSignatures(sigs: { owner: string; signature: string }[]) {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const heads: Uint8Array[] = [], tails: Uint8Array[] = [];
  let at = sorted.length * 65;
  for (const s of sorted) {
    const b = bytes(s.signature);
    if (b[64] !== 0) { heads.push(b.slice(0, 65)); continue; }       // EOA (27/28, eth_sign 31/32) or approved hash (1)
    const off = Number(BigInt(hex(b.slice(32, 64)))), len = Number(BigInt(hex(b.slice(off, off + 32))));
    const data = b.slice(off, off + 32 + len);
    heads.push(cat(b.slice(0, 32), word(at), new Uint8Array([0]))); tails.push(data); at += data.length;
  }
  return hex(cat(...heads, ...tails));
}

/** execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures) */
export function execData(t: SafeTx, sigs: string) {
  const pad = (b: Uint8Array) => cat(b, new Uint8Array((32 - (b.length % 32)) % 32));
  const d = bytes(t.data || "0x"), s = bytes(sigs);
  const head = 10 * 32, dataPart = cat(word(d.length), pad(d));
  return selector("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)") + hex(cat(
    aword(t.to), word(t.value), word(head), word(t.operation), word(t.safeTxGas), word(t.baseGas), word(t.gasPrice),
    aword(t.gasToken), aword(t.refundReceiver), word(head + dataPart.length), dataPart, word(s.length), pad(s))).slice(2);
}
