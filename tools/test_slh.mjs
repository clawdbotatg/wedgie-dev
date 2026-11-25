// src/pq/slh.ts (the browser's SLH-DSA check on /pq) against the wedgie's signer built for this computer
// (clawdbotatg/wedgie-pq mp/slh/slh.c, whose signatures OpenSSL accepts: its tools/check_slh.py).
//   cc -O2 -DSLH_HOST -o /tmp/slhhost ../wedgie-pq/mp/slh/slh.c && node tools/test_slh.mjs /tmp/slhhost
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const { verify, wrap, sigSize } = await import("../src/pq/slh.ts");      // node runs .ts as is (types stripped)
let bad = 0;
const check = (ok, what) => { console.log(ok ? "OK  " : "FAIL", what); bad += !ok; };
for (const [set, n] of [["128f", 1], ["128s", 0]]) {
  for (const len of [0, 32, 200]) {
    const [skSeed, skPrf, pkSeed, msg] = [16, 16, 16, len].map((x) => randomBytes(x));
    const m = wrap(msg);
    const [root, sig] = execFileSync(process.argv[2], [String(n), skSeed.toString("hex"), skPrf.toString("hex"), pkSeed.toString("hex"), Buffer.from(m).toString("hex")]).toString().trim().split("\n").map((h) => Buffer.from(h, "hex"));
    const pk = Buffer.concat([pkSeed, root]);
    check(sig.length === sigSize(set) && verify(set, pk, m, sig), `${set}: a ${len}-byte message checks`);
    let no = true;
    for (const at of [0, 20, sig.length >> 1, sig.length - 1]) { const s = Buffer.from(sig); s[at] ^= 1; no &&= !verify(set, pk, m, s); }
    const m2 = Buffer.from(m); m2[m2.length - 1] ^= 1;
    const pk2 = Buffer.from(pk); pk2[20] ^= 1;
    check(no && !verify(set, pk, m2, sig) && !verify(set, pk2, m, sig), `${set}: a changed signature, message or key fails`);
  }
}
process.exit(bad ? 1 : 0);
