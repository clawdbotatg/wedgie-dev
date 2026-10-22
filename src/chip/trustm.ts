// The virtual wedgie's secure chip: an OPTIGA Trust M in software, on the virtual I2C bus at 0x30. It
// speaks what the real one does, byte for byte, so firmware/trustm.py and firmware/optiga.py (and every
// app on top of them) run unchanged: Infineon's I2C registers (DATA 0x80, I2C_STATE 0x82, soft reset
// 0x88), its data link (frame numbers, acks, CRC-16 FCS, chaining) and its commands (APDUs): open,
// read/write objects and metadata, random, SHA-256, ECDSA sign/verify, key pairs, ECDH, HKDF/PRF, HMAC,
// counters. Access rules work: a key or object whose lifecycle went to 07 is locked for good.
// What it can't be: genuine. Its factory certificate is signed by a "wedgie virtual" CA, not Infineon,
// so wedgie.dev's chip check (serial/chipcheck.ts) says so. Its keys live in this browser (IndexedDB).
// Not here: RSA and AES (the commands answer "not on this chip version"). Command times are a real
// chip's, roughly, in the chip's own time.
import { p256, p384 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import type { I2CDevice } from "./sim";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const cat = (...a: (Uint8Array | number[])[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function crc(b: Uint8Array) {
  let c = 0;
  for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0x8408 : c >> 1; }
  return c;
}
const tlv = (tag: number, v: Uint8Array | number[]) => cat([tag, ...u16(v.length)], v);
function tlvs(b: Uint8Array) {
  const out: Record<number, Uint8Array> = {};
  for (let i = 0; i + 3 <= b.length; ) { const n = (b[i + 1] << 8) | b[i + 2]; out[b[i]] = b.slice(i + 3, i + 3 + n); i += 3 + n; }
  return out;
}

// ---- OIDs (firmware/optiga.py) ----
const KEYS = [0xe0f0, 0xe0f1, 0xe0f2, 0xe0f3];
const RSA = [0xe0fc, 0xe0fd];
const SESSIONS = [0xe100, 0xe101, 0xe102, 0xe103];
const COUNTERS = [0xe120, 0xe121, 0xe122, 0xe123];
const DATA = Array.from({ length: 12 }, (_, i) => 0xf1d0 + i);
const BIG = [0xf1e0, 0xf1e1];
const CERTS = [0xe0e0, 0xe0e1, 0xe0e2, 0xe0e3];
const TRUST = [0xe0e8, 0xe0e9, 0xe0ef];
const MAX: Record<number, number> = {};
for (const o of DATA) MAX[o] = 140;
for (const o of BIG) MAX[o] = 1500;
for (const o of [...CERTS, ...TRUST]) MAX[o] = 1728;
for (const o of COUNTERS) MAX[o] = 8;
MAX[0xe140] = 64;
const CURVE: Record<number, any> = { 0x03: p256, 0x04: p384 };
const SIZE: Record<number, number> = { 0x03: 32, 0x04: 48 };
const OPEN = [0x00, 0xe1, 0xfc, 0x07];      // "while the object's lifecycle is below 07"

type Key = { alg: number; priv: string; usage: number };
export type TrustMState = { uid: string; factory: string; cert: string; keys: Record<string, Key>; data: Record<string, string>; meta: Record<string, Record<string, string>> };

/** A new chip: its own UID, factory key and certificate. */
export function newTrustM(): TrustMState {
  const uid = cat([0xcd, 0x16, 0x33, 0x82, 0x01, 0x00, 0x1c, 0x00, 0x05, 0x00, 0x00], rnd(12), [0x0a, 0x09, 0x1b, 0x5c]);   // the build: like a V3's
  const factory = p256.utils.randomPrivateKey();
  const der = certificate(factory, uid);
  const stored = cat([0xc0, ...u16(der.length + 6), 0xc3, 0, ...u16(der.length + 3), 0, ...u16(der.length)], der);   // the identity header real ones have
  const data: Record<string, string> = { [0xe0e0]: hex(stored) };
  for (const o of COUNTERS) data[o] = "00000000ffffffff";
  return { uid: hex(uid), factory: hex(factory), cert: hex(der), keys: {}, data, meta: {} };
}

export function trustM(state: TrustMState, now: () => number, onChange: () => void): I2CDevice {
  const keys = state.keys, data = state.data, meta = state.meta;
  let reg = 0, wrote: number[] = [], readAt = 0;
  let out: Uint8Array | null = null, readyAt = 0;       // the frame the host reads next, and when it's ready
  let myFr = 0, open = false, lastError = 0, chain: Uint8Array[] = [];
  let hashing: Uint8Array[] | null = null;
  const sessions = new Map<number, Uint8Array>();
  const changed = () => onChange();

  // ---- metadata and access rules ----
  function metaOf(oid: number): Map<number, Uint8Array> {
    const m = new Map<number, Uint8Array>();
    const isKey = KEYS.includes(oid) || RSA.includes(oid);
    if (oid === 0xe0f0) { m.set(0xc0, Uint8Array.of(7)); m.set(0xd0, Uint8Array.of(0xff)); m.set(0xd3, Uint8Array.of(0)); m.set(0xe0, Uint8Array.of(3)); m.set(0xe1, Uint8Array.of(1)); }
    else if (isKey) {
      const k = keys[oid];
      m.set(0xc0, Uint8Array.of(1)); m.set(0xd0, Uint8Array.from(OPEN.slice(1))); m.set(0xd3, Uint8Array.of(0));
      m.set(0xe0, Uint8Array.of(k?.alg ?? (RSA.includes(oid) ? 0x42 : 3))); m.set(0xe1, Uint8Array.of(k?.usage ?? 0x10));
    } else if (oid in MAX || oid === 0xe0e0) {
      const used = (data[oid] || "").length / 2;
      m.set(0xc0, Uint8Array.of(1)); m.set(0xc4, Uint8Array.from(u16(MAX[oid] ?? 1728))); m.set(0xc5, Uint8Array.from(u16(used)));
      m.set(0xd0, oid === 0xe0e0 ? Uint8Array.of(0xff) : Uint8Array.from(OPEN.slice(1))); m.set(0xd1, Uint8Array.of(0));
    } else return m;
    for (const [t, v] of Object.entries(meta[oid] || {})) m.set(+t, unhex(v));
    return m;
  }
  const lcso = (oid: number) => metaOf(oid).get(0xc0)?.[0] ?? 1;
  // 00 always, FF never, E1 FC xx: while its lifecycle is below xx. Anything else: allowed (not modeled).
  function allows(oid: number, tag: number) {
    const r = metaOf(oid).get(tag);
    if (!r || (r.length === 1 && r[0] === 0)) return true;
    if (r.length === 1 && r[0] === 0xff) return false;
    if (r.length === 3 && r[0] === 0xe1 && r[1] === 0xfc) return lcso(oid) < r[2];
    return true;
  }
  const metaBytes = (oid: number) => { const b: number[] = []; for (const [t, v] of metaOf(oid)) b.push(t, v.length, ...v); return cat([0x20, b.length], b); };

  function objectBytes(oid: number): Uint8Array | null {
    switch (oid) {
      case 0xe0c0: return Uint8Array.of(7);
      case 0xe0c1: return Uint8Array.of(0x20);
      case 0xe0c2: return unhex(state.uid);
      case 0xe0c3: return Uint8Array.of(20);
      case 0xe0c4: return Uint8Array.of(6);
      case 0xe0c5: return Uint8Array.of(0);
      case 0xe0c6: return Uint8Array.from(u16(0x0615));
      case 0xf1c0: return Uint8Array.of(7);
      case 0xf1c1: return Uint8Array.of(0);
    }
    if (oid in MAX || oid === 0xe0e0) return unhex(data[oid] || "");
    return null;
  }

  // ---- commands ----
  class Fail extends Error { code: number; constructor(code: number) { super("optiga " + code); this.code = code; } }
  const need = (ok: unknown, code: number) => { if (!ok) throw new Fail(code); };
  const der = (sig: Uint8Array, n: number) => {
    const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? cat([2, b.length + 1, 0], b) : cat([2, b.length], b); };
    return cat(int(sig.slice(0, n)), int(sig.slice(n)));
  };
  const undDer = (b: Uint8Array, n: number) => {
    const out = new Uint8Array(2 * n);
    for (let i = 0, k = 0; k < 2 && i < b.length; k++) { const l = b[i + 1], v = b.slice(i + 2, i + 2 + l).slice(-n); out.set(v, k * n + n - v.length); i += 2 + l; }
    return out;
  };
  const bits = (b: Uint8Array) => b.slice((b[1] < 0x80 ? 2 : 2 + (b[1] & 0x7f)) + 1);
  const bitstring = (pub: Uint8Array) => cat([0x03, pub.length + 1, 0x00], pub);
  function keyAt(oid: number): Key | null {
    if (oid === 0xe0f0) return { alg: 3, priv: state.factory, usage: 0x01 };
    return keys[oid] || null;
  }
  const secretOf = (oid: number) => (SESSIONS.includes(oid) ? sessions.get(oid) : (meta[oid]?.[0xe8] === "21" ? unhex(data[oid] || "") : undefined));

  function run(cmd: number, p: number, d: Uint8Array): [Uint8Array, number] {
    if (cmd !== 0x70) need(open, 0x0b);
    const oid = (d[0] << 8) | d[1];
    switch (cmd) {
      case 0x70: open = true; return [new Uint8Array(0), 10];
      case 0x71: need(p === 0, 0x0c); open = false; sessions.clear(); return [new Uint8Array(0), 5];
      case 0x01: {                                  // GetDataObject
        if (p === 0x01) { need(objectBytes(oid) || keyAt(oid) || KEYS.includes(oid) || RSA.includes(oid), 0x01); return [metaBytes(oid), 5]; }
        if (oid === 0xf1c2) { const e = lastError; lastError = 0; return [e ? Uint8Array.of(e) : new Uint8Array(0), 3]; }
        const b = objectBytes(oid);
        need(b, KEYS.includes(oid) || RSA.includes(oid) || SESSIONS.includes(oid) ? 0x07 : 0x01);
        need(allows(oid, 0xd1), 0x07);
        const off = d.length >= 6 ? (d[2] << 8) | d[3] : 0, n = d.length >= 6 ? (d[4] << 8) | d[5] : b!.length;
        need(off < b!.length || (off === 0 && b!.length === 0), 0x08);
        return [b!.slice(off, off + n), 5];
      }
      case 0x02: {                                  // SetDataObject
        const off = (d[2] << 8) | d[3], v = d.slice(4);
        if (p === 0x01) {                           // metadata: 20 LL tags
          need(KEYS.includes(oid) || RSA.includes(oid) || oid in MAX, 0x01);
          need(allows(oid, 0xd0) && oid !== 0xe0f0, 0x07);
          const m = (meta[oid] ||= {});
          for (let i = 2; i + 2 <= v.length; i += 2 + v[i + 1]) {
            const t = v[i], val = v.slice(i + 2, i + 2 + v[i + 1]);
            if (t === 0xc0) need(val[0] >= lcso(oid), 0x11);       // a lifecycle only goes up
            m[t] = hex(val);
          }
          changed();
          return [new Uint8Array(0), 15];
        }
        need(oid in MAX, KEYS.includes(oid) || RSA.includes(oid) ? 0x07 : 0x01);
        need(allows(oid, 0xd0), 0x07);
        if (p === 0x02) {                           // a counter: + n
          const c = unhex(data[oid]), dv = new DataView(c.buffer), val = dv.getUint32(0) + v[0];
          need(val <= dv.getUint32(4), 0x0e);
          dv.setUint32(0, val); data[oid] = hex(c); changed();
          return [new Uint8Array(0), 10];
        }
        let cur = p & 0x40 ? new Uint8Array(0) : unhex(data[oid] || "");
        need(off + v.length <= MAX[oid], 0x08);
        if (cur.length < off + v.length) cur = cat(cur, new Uint8Array(off + v.length - cur.length));
        cur.set(v, off);
        data[oid] = hex(cur); changed();
        return [new Uint8Array(0), 15];
      }
      case 0x0c: { const n = (d[0] << 8) | d[1]; need(n >= 8 && n <= 256, 0x05); return [rnd(n), 5]; }
      case 0x30: {                                  // CalcHash, SHA-256
        need(p === 0xe2, 0x25);
        const t = d[0], v = d.slice(3), done = (b: Uint8Array) => tlv(0x01, sha256(b));
        if (t === 0x01) return [done(v), 5];
        if (t === 0x11) { const o = (v[0] << 8) | v[1], b = objectBytes(o); need(b, 0x01); const off = (v[2] << 8) | v[3], n = (v[4] << 8) | v[5]; return [done(b!.slice(off, off + n)), 5]; }
        if (t === 0x00) { hashing = [v]; return [new Uint8Array(0), 5]; }
        need(hashing, 0x0b);
        hashing!.push(v);
        if (t === 0x02) return [new Uint8Array(0), 5];
        const all = cat(...hashing!); hashing = null;
        return [done(all), 5];
      }
      case 0x31: {                                  // CalcSign, ECDSA over a digest
        need(p === 0x11, 0x0a);
        const t = tlvs(d), o = (t[0x03][0] << 8) | t[0x03][1], k = keyAt(o);
        need(k && CURVE[k.alg], 0x07);
        need(k!.usage & 0x11 && allows(o, 0xd3), 0x07);
        const n = SIZE[k!.alg], sig = CURVE[k!.alg].sign(t[0x01], unhex(k!.priv), { prehash: false, lowS: false }).toCompactRawBytes();
        return [der(sig, n), 60];
      }
      case 0x32: {                                  // VerifySign
        need(p === 0x11, 0x0a);
        const t = tlvs(d);
        let alg = 3, pub: Uint8Array;
        if (t[0x04]) { need(((t[0x04][0] << 8) | t[0x04][1]) === 0xe0e0, 0x29); pub = p256.getPublicKey(unhex(state.factory), false); }
        else { alg = t[0x05][0]; need(CURVE[alg], 0x25); pub = bits(t[0x06]); }
        const n = SIZE[alg], ok = (() => { try { return CURVE[alg].verify(undDer(t[0x02], n), t[0x01], pub, { prehash: false, lowS: false }); } catch { return false; } })();
        need(ok, 0x2c);
        return [new Uint8Array(0), 80];
      }
      case 0x33: {                                  // CalcSSec, ECDH
        const t = tlvs(d), o = (t[0x01][0] << 8) | t[0x01][1];
        let priv: Uint8Array, alg = t[0x05][0];
        if (SESSIONS.includes(o)) { const s = sessions.get(o); need(s, 0x07); priv = s!; }
        else { const k = keyAt(o); need(k && k.usage & 0x20, 0x07); priv = unhex(k!.priv); alg = k!.alg; }
        need(CURVE[alg], 0x25);
        const x = CURVE[alg].getSharedSecret(priv, bits(t[0x06])).slice(1);
        if (t[0x08]) { sessions.set((t[0x08][0] << 8) | t[0x08][1], x); return [new Uint8Array(0), 60]; }
        return [x, 60];
      }
      case 0x34: {                                  // DeriveKey
        const t = tlvs(d), o = (t[0x01][0] << 8) | t[0x01][1], sec = secretOf(o), n = (t[0x03][0] << 8) | t[0x03][1];
        need(sec, 0x07);
        need(p === 0x08 || p === 0x01, 0x25);         // HKDF-SHA256 or the TLS PRF with SHA-256
        const outB = p === 0x08 ? hkdf(sha256, sec!, t[0x02] || new Uint8Array(0), t[0x04] || new Uint8Array(0), n) : prf(sec!, t[0x02] || new Uint8Array(0), n);
        if (t[0x08]) { sessions.set((t[0x08][0] << 8) | t[0x08][1], outB); return [new Uint8Array(0), 30]; }
        return [outB, 30];
      }
      case 0x14: {                                  // EncryptSym: HMAC-SHA256 only
        need(p === 0x20, 0x0a);
        const sec = secretOf(oid), t = tlvs(d.slice(2));
        need(sec, 0x07);
        return [tlv(0x61, hmac(sha256, sec!, t[0x01] || new Uint8Array(0))), 10];
      }
      case 0x38: {                                  // GenKeyPair
        need(CURVE[p], 0x0a);
        const t = tlvs(d), priv = CURVE[p].utils.randomPrivateKey(), pub = CURVE[p].getPublicKey(priv, false);
        if (t[0x07]) return [cat(tlv(0x01, cat([0x04, priv.length], priv)), tlv(0x02, bitstring(pub))), 60];
        const o = (t[0x01][0] << 8) | t[0x01][1];
        if (SESSIONS.includes(o)) { sessions.set(o, priv); return [tlv(0x02, bitstring(pub)), 60]; }
        need(KEYS.includes(o) && o !== 0xe0f0, 0x07);
        need(allows(o, 0xd0), 0x07);
        keys[o] = { alg: p, priv: hex(priv), usage: t[0x02]?.[0] ?? 0x10 };
        changed();
        return [tlv(0x02, bitstring(pub)), 60];
      }
    }
    throw new Fail(0x0a);                           // RSA, AES, protected update: not on this one
  }
  function prf(secret: Uint8Array, seed: Uint8Array, n: number) {     // TLS 1.2 P_SHA256
    let a = seed, out = new Uint8Array(0);
    while (out.length < n) { a = hmac(sha256, secret, a); out = cat(out, hmac(sha256, secret, cat(a, seed))); }
    return out.slice(0, n);
  }
  function apdu(b: Uint8Array): [Uint8Array, number] {
    const cmd = b[0], p = b[1], n = (b[2] << 8) | b[3];
    try {
      const [r, ms] = run(cmd, p, b.slice(4, 4 + n));
      return [cat([0x00, 0x00, ...u16(r.length)], r), ms];
    } catch (e) {
      lastError = e instanceof Fail ? e.code : 0x06;
      return [Uint8Array.of(0xff, 0x00, 0x00, 0x00), 5];
    }
  }

  // ---- the data link: frames in on DATA, out when ready ----
  function frame(f: Uint8Array) {
    const len = (f[1] << 8) | f[2];
    if (f.length < 5 || f.length !== 5 + len || crc(f.slice(0, 3 + len)) !== ((f[3 + len] << 8) | f[4 + len])) return;   // garbled: ignored
    if (f[0] & 0x80) return;                        // the host's ack of our frame
    const hostFr = (f[0] >> 2) & 3, pctr = f[3], part = f.slice(4, 3 + len);
    const send = (body: Uint8Array, ms: number, ctl = false) => {
      const head = ctl ? [0x80 | hostFr, 0, 0] : [(myFr << 2) | hostFr, ...u16(body.length)];
      if (!ctl) myFr = (myFr + 1) & 3;
      const fr = cat(head, body);
      out = cat(fr, u16(crc(fr)));
      readyAt = now() + ms;
    };
    if ((pctr & 7) === 1 || (pctr & 7) === 2) { chain.push(part); send(new Uint8Array(0), 1, true); return; }
    const whole = cat(...chain, part);
    chain = [];
    const [r, ms] = apdu(whole);
    send(cat([0x00], r), ms);
  }
  function reset() { myFr = 0; open = false; out = null; chain = []; hashing = null; sessions.clear(); lastError = 0; }
  function stateBytes() {
    const busy = out && now() < readyAt, ready = out && !busy;
    return Uint8Array.of(0x08 | (busy ? 0x80 : 0) | (ready ? 0x40 : 0), 0x80, ...u16(ready ? out!.length : 0));
  }

  let reading: Uint8Array = new Uint8Array(0);
  return {
    addr: 0x30,
    connect(read) {
      if (read) { reading = reg === 0x82 ? stateBytes() : reg === 0x80 && out && now() >= readyAt ? out : new Uint8Array(0); readAt = 0; }
      else wrote = [];
      return true;
    },
    write(b) { wrote.push(b); return true; },
    read() { return reading[readAt++] ?? 0xff; },
    stop() {
      if (wrote.length) {
        reg = wrote[0];
        const v = Uint8Array.from(wrote.slice(1));
        wrote = [];
        if (reg === 0x88 && v.length) reset();
        else if (reg === 0x80 && v.length) frame(v);
      } else if (reg === 0x80 && readAt && out && reading === out) { out = null; }   // the frame was read
      readAt = 0;
    },
  };
}

// ---- a factory certificate, X.509 DER, signed by a throwaway "wedgie virtual" CA ----
function certificate(factory: Uint8Array, uid: Uint8Array) {
  const d = (tag: number, ...body: Uint8Array[]) => { const b = cat(...body), n = b.length; return cat([tag], n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 255], b); };
  const oid = (h: string) => d(0x06, unhex(h));
  const name = (cn: string) => d(0x30, d(0x31, d(0x30, oid("550403"), d(0x0c, new TextEncoder().encode(cn)))));
  const ecdsa256 = d(0x30, oid("2a8648ce3d040302"));
  const ca = p256.utils.randomPrivateKey();
  const spki = d(0x30, d(0x30, oid("2a8648ce3d0201"), oid("2a8648ce3d030107")), d(0x03, Uint8Array.of(0), p256.getPublicKey(factory, false)));
  const time = (s: string) => d(0x17, new TextEncoder().encode(s));
  const tbs = d(0x30, d(0xa0, d(0x02, Uint8Array.of(2))), d(0x02, cat([0x01], uid.slice(11, 19))), ecdsa256, name("wedgie virtual CA (not Infineon)"),
    d(0x30, time("260101000000Z"), time("460101000000Z")), name("virtual Trust M"), spki);
  const sig = p256.sign(sha256(tbs), ca, { prehash: false });
  const int = (b: Uint8Array) => d(0x02, b[0] & 0x80 ? cat([0], b) : b);
  const raw = sig.toCompactRawBytes();
  return d(0x30, tbs, ecdsa256, d(0x03, Uint8Array.of(0), d(0x30, int(raw.slice(0, 32)), int(raw.slice(32)))));
}
