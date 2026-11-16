// /reset writes only the MicroPython builds wedgie.dev ships (audit 11-13, INST-10): their hashes are in the code.
//   node tools/test_uf2.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
const src = readFileSync("src/serial/picoboot.ts", "utf8"), sec = readFileSync("public/security.md", "utf8");
const pins = [...src.matchAll(/"(\/mp\/[^"]+\.uf2)": "([0-9a-f]{40})"/g)];
check(pins.length === 4, "four builds pinned");
for (const [, f, h] of pins) {
  const real = createHash("sha256").update(readFileSync("public" + f)).digest("hex");
  check(real.startsWith(h), `${f}: its hash matches`);
  check(sec.includes(h.slice(0, 12)), `${f}: security.md shows it`);
}
check(/if \(!sha\.startsWith\(UF2_SHA\[url\]\)\) throw/.test(src), "a file that doesn't match is refused before anything is written");
check(!/wedgie\.dev\/reset/.test(readFileSync("firmware/listcheck.py", "utf8")), "'Not signed' doesn't send people to /reset");
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
