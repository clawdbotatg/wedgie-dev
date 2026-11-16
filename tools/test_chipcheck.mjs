// The page's "is the chip real" check can't be fooled by a recording (audit 11-13). The wedgie used to pick every
// byte its Trust M signed, so one answer recorded from any real wedgie passed forever. The page now sends 32 random
// bytes with each ask; firmware 0.3.83+ signs "wedgie-chip-v1" + those + its own, and the page checks with the
// bytes it sent. A made-up Trust M here: a P-256 key with a certificate under a test root (openssl).
//   node tools/test_chipcheck.mjs
import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

const T = mkdtempSync(join(tmpdir(), "chipcheck-"));
const ssl = (...a) => execFileSync("openssl", a, { cwd: T, stdio: ["ignore", "pipe", "ignore"] });
for (const n of ["root", "ca", "dev"]) ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
writeFileSync(join(T, "ext"), "basicConstraints=CA:TRUE\n");
ssl("req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "2", "-subj", "/CN=Test Root", "-out", "root.pem");
ssl("req", "-new", "-key", "ca.key", "-subj", "/CN=Test CA", "-out", "ca.csr");
ssl("x509", "-req", "-in", "ca.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-sha256", "-days", "2", "-extfile", "ext", "-out", "ca.pem");
ssl("req", "-new", "-key", "dev.key", "-subj", "/CN=Test Trust M", "-out", "dev.csr");
ssl("x509", "-req", "-in", "dev.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-sha256", "-days", "2", "-out", "dev.pem");
const der = (n) => ssl("x509", "-in", `${n}.pem`, "-outform", "DER");
const ROOT = der("root"), CA = der("ca"), DEV = der("dev"), key = createPrivateKey(readFileSync(join(T, "dev.key")));
// the page fetches Infineon's CAs: here, the test ones
globalThis.fetch = async (u) => ({ arrayBuffer: async () => { const b = /ca101/.test(u) ? CA : ROOT; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });

const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const C = await vs.ssrLoadModule("/src/serial/chipcheck.ts");
let bad = 0;
const check = (ok, what, got) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what, ok ? "" : JSON.stringify(got).slice(0, 300)); };
const hex = (b) => Buffer.from(b).toString("hex");
/** A wedgie's answer, as firmware/wedgie.py chip() makes it: with a nonce (0.3.83+) or without (older). */
function answer(nonce) {
  const msg = randomBytes(100);
  const signed = nonce ? Buffer.concat([Buffer.from("wedgie-chip-v1"), Buffer.from(nonce, "hex"), msg]) : msg;
  const sg = sign("sha256", signed, { key, dsaEncoding: "ieee-p1363" });
  return { type: "chip", kind: "trustm", chip: "OPTIGA Trust M", msg: hex(msg), cert: "c0" + "0000" + hex(DEV), r: hex(sg.subarray(0, 32)), s: hex(sg.subarray(32)),
    random: [hex(randomBytes(32)), hex(randomBytes(32))], ...(nonce ? { v: 1 } : {}) };
}
const n1 = C.chipNonce(), n2 = C.chipNonce();
check(/^[0-9a-f]{64}$/.test(n1) && n1 !== n2, "the page's nonce: 32 random bytes, new each time", [n1, n2]);

let r = await C.checkChip(answer(n1), "", n1, "0.3.83");
check(r.pass && r.proven && /✓/.test(r.detail), "an answer made for this page's nonce: real", r);

const recorded = answer(n1);
r = await C.checkChip(recorded, "", n2, "0.3.83");
check(!r.pass && !r.proven, "an answer recorded for another nonce, played back: refused", r);

r = await C.checkChip({ ...recorded, nonce: n1 }, "", n2, "0.3.83");
check(!r.pass, "…even if the answer names the nonce it was made for (the page uses its own)", r);

r = await C.checkChip(answer(), "", n2, "0.3.83");
check(!r.pass && !r.proven && /didn't sign this page's bytes/.test(r.detail), "an old-style answer from firmware that knows nonces: refused", r);

r = await C.checkChip(answer(), "", n2, "0.3.82");
check(r.pass && !r.proven && !/✓/.test(r.detail) && /update/.test(r.detail), "an old-style answer from old firmware: works, not proven, no ✓", r);

r = await C.checkChip({ ...answer(), v: 1 }, "", n2, "0.3.82");
check(!r.pass, "an old-style answer that claims v 1: refused", r);

r = await C.checkChip(answer());
check(r.pass && !r.proven, "no nonce asked (the bench): works, not proven", r);

const msg = randomBytes(100);
r = await C.checkChip({ kind: "atecc", msg: hex(msg), sha: createHash("sha256").update(msg).digest("hex"), random: [hex(randomBytes(32)), hex(randomBytes(32))] }, "", n1, "0.3.83");
check(r.pass && !r.proven && !/✓/.test(r.detail) && /can't be proven/.test(r.detail), "an ATECC608: works, never proven real, no ✓", r);

await vs.close();
console.log(bad ? `${bad} FAILED` : "ALL OK");
process.exit(bad ? 1 : 0);
