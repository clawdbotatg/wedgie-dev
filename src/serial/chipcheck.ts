// Checks what bench.py's chipwork() brought back, in the browser (WebCrypto, no libraries):
//  ATECC608: the chip's SHA-256 of random bytes equals ours; its Random answers (a fixed pattern
//  while its config is unlocked, which is how they ship and how we leave them).
//  Trust M: its device certificate (OID E0E0) chains to an Infineon root we ship
//  (public/device/infineon, from Infineon's PKI), and its factory key signed our random bytes.

const hexb = (h: string) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

type Tlv = { tag: number; start: number; end: number; hdr: number };
function tlv(b: Uint8Array, o: number): Tlv {
  const tag = b[o];
  let len = b[o + 1], hdr = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | b[o + 2 + i]; hdr += n; }
  return { tag, start: o + hdr, end: o + hdr + len, hdr };
}
const kids = (b: Uint8Array, t: Tlv) => { const out: Tlv[] = []; for (let o = t.start; o < t.end; ) { const k = tlv(b, o); out.push(k); o = k.end; } return out; };
const raw = (b: Uint8Array, t: Tlv) => b.slice(t.start - t.hdr, t.end);

const CURVES: [string, string, number][] = [["2a8648ce3d030107", "P-256", 32], ["2b81040022", "P-384", 48], ["2b81040023", "P-521", 66]];
const HASHES: Record<string, string> = { "2a8648ce3d040302": "SHA-256", "2a8648ce3d040303": "SHA-384", "2a8648ce3d040304": "SHA-512" };
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

type Cert = { tbs: Uint8Array; issuer: Uint8Array; subject: Uint8Array; spki: Uint8Array; curve: string; size: number; hash: string; sig: Uint8Array; cn: string };
function cert(der: Uint8Array): Cert {
  const top = tlv(der, 0), [tbsT, algT, sigT] = kids(der, top);
  const f = kids(der, tbsT), i = f[0].tag === 0xa0 ? 1 : 0;
  const spkiT = f[i + 5], spki = raw(der, spkiT);
  const curveOid = hex(raw(der, kids(der, kids(der, spkiT)[0])[1]).slice(2));
  const c = CURVES.find(([o]) => o === curveOid);
  const hash = HASHES[hex(raw(der, kids(der, algT)[0]).slice(2))];
  if (!c || !hash) throw new Error("certificate uses an algorithm this check doesn't know");
  const subject = raw(der, f[i + 4]);
  let cn = "";
  for (let o = 0; o + 5 < subject.length; o++) if (hex(subject.slice(o, o + 5)) === "0603550403") { const t = tlv(subject, o + 5); cn = new TextDecoder().decode(subject.slice(t.start, t.end)); }
  return { tbs: raw(der, tbsT), issuer: raw(der, f[i + 2]), subject, spki, curve: c[1], size: c[2], hash, sig: der.slice(sigT.start + 1, sigT.end), cn };
}
// DER SEQUENCE { INTEGER r, INTEGER s } → r||s, each padded to the curve size.
function rs(der: Uint8Array, size: number) {
  const [r, s] = kids(der, tlv(der, 0)).map((k) => der.slice(k.start, k.end));
  const pad = (x: Uint8Array) => { const y = x.slice(Math.max(0, x.length - size)); const o = new Uint8Array(size); o.set(y, size - y.length); return o; };
  const out = new Uint8Array(size * 2); out.set(pad(r)); out.set(pad(s), size); return out;
}
async function key(c: Cert) {
  return crypto.subtle.importKey("spki", c.spki as BufferSource, { name: "ECDSA", namedCurve: c.curve }, false, ["verify"]);
}
async function signedBy(c: Cert, by: Cert) {
  return crypto.subtle.verify({ name: "ECDSA", hash: c.hash }, await key(by), rs(c.sig, by.size) as BufferSource, c.tbs as BufferSource);
}

let anchors: Promise<Cert[]> | null = null;
const infineon = () => (anchors ??= Promise.all(["ca101", "ca300", "ca306", "rootC", "root2"].map((n) =>
  fetch(`/device/infineon/${n}.crt`).then((r) => r.arrayBuffer()).then((b) => cert(new Uint8Array(b))))));

export type ChipCheck = { pass: boolean; detail: string; facts: [string, string][] };

export async function checkChip(d: any): Promise<ChipCheck> {
  if (d.error) return { pass: false, detail: `Chip didn't finish: ${d.error}`, facts: [["Chip test", d.error]] };
  const msg = hexb(d.msg);
  if (d.kind === "atecc") {
    const want = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
    const ok = same(hexb(d.sha), want);
    const [r1, r2] = d.random as string[];
    const fixed = r1 === "ffff0000".repeat(8) && r2 === r1;
    const facts: [string, string][] = [
      ["Chip SHA-256", ok ? "matches ours (100 random bytes hashed on the chip)" : `wrong: ${d.sha}`],
      ["Chip random", fixed ? "fixed pattern: config not locked yet, as shipped (left unlocked)" : `${r1.slice(0, 16)}… ${r2.slice(0, 16)}…`],
    ];
    const rndOk = fixed || (r1 !== r2 && !/^(00)+$|^(ff)+$/.test(r1));
    return { pass: ok && rndOk, detail: ok ? "ATECC608: hashed on the chip ✓" : "ATECC608 hashed wrong", facts };
  }
  // Trust M: the certificate is stored behind a small header (tag C0, lengths); the DER starts at 30 82.
  const blob = hexb(d.cert);
  let at = 0;
  while (at < blob.length - 4 && !(blob[at] === 0x30 && blob[at + 1] === 0x82 && tlv(blob, at).end <= blob.length)) at++;
  const dev = cert(blob.slice(at, tlv(blob, at).end));
  const facts: [string, string][] = [["Trust M certificate", dev.cn || "?"]];
  const devKey = await key(dev);
  const sigOk = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, devKey, hexb(d.r + d.s), msg);
  facts.push(["Trust M signature", sigOk ? "valid: its factory key signed our random bytes" : "INVALID"]);
  const cas = await infineon();
  const mid = cas.find((c) => same(c.subject, dev.issuer));
  let chain = "";
  if (!mid) chain = "issuer isn't an Infineon CA we know";
  else if (!(await signedBy(dev, mid))) chain = `not really signed by ${mid.cn}`;
  else {
    const root = cas.find((c) => same(c.subject, mid.issuer) && same(c.issuer, c.subject));
    chain = !root ? `${mid.cn}, root unknown` : (await signedBy(mid, root)) ? "" : `${mid.cn} not signed by ${root.cn}`;
    if (!chain) facts.push(["Trust M chain", `${dev.cn} ← ${mid.cn} ← ${root!.cn}`]);
  }
  if (chain) facts.push(["Trust M chain", chain]);
  const [r1, r2] = d.random as string[];
  facts.push(["Trust M random", `${r1.slice(0, 16)}… ${r2.slice(0, 16)}…`]);
  const pass = sigOk && !chain && r1 !== r2;
  return { pass, detail: pass ? "Trust M: signed, traces to Infineon ✓" : !sigOk ? "Trust M signature didn't verify" : chain ? `Trust M: ${chain}` : "Trust M random repeated", facts };
}
