// wire/wire.py (the ERC-7730 wire format) on a virtual RP2040 (tools/rp2040/chip.mjs, a real board's heap), as an
// app: tools/fixtures/wiretest.py reads a 4 KB descriptor (the spec's minimum) in place, cuts out its signed
// message, and decodes its fields one at a time, each value found by a slot program in 4 KB of calldata. Its results must hash the same as on
// CPython, with no MemoryError, and at least MIN bytes of heap left at the lowest point.
//   node tools/wirechip.mjs        (needs uv: the flash image)
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";

const MIN = 16384;
const at = (p) => new URL(p, import.meta.url);
const blob = join(mkdtempSync(join(tmpdir(), "wire-")), "blob.bin"), py = at("fixtures/wiretest.py").pathname;
execFileSync("python3", [py, "blob", blob]);
const want = execFileSync("python3", [py, "check", blob]).toString().trim();
const F = firmware();
F.app({ mod: "wiretest", name: "Wire test", entry: "run", files: ["wiretest.py", "wire.py", "wiretest_blob.bin"] },
  { "wiretest.py": readFileSync(py), "wire.py": readFileSync(at("../wire/wire.py")), "wiretest_blob.bin": readFileSync(blob) });
const h = host({ fs: image(F, "wiretest") });
for (const p of [15, 17, 19, 21, 2, 18, 16, 20, 3]) h.chip.mcu.gpio[p].setInputValue(true);
let got = null;
h.until((b) => { const m = b.match(/\{[^\n]*"type": "wiretest"[^\n]*\n/); if (m) got = JSON.parse(m[0]); return !!got || /Traceback|MemoryError|wedgie broke/.test(b); }, 60000, 20);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
if (!got) { console.log(h.out.split("\n").slice(-12).join("\n")); check(false, "the test app answered"); process.exit(1); }
check(got.digest === want, `same results as CPython (${got.blob} B descriptor, ${got.calldata} B calldata)`);
check(got.least >= MIN, `least free heap ${got.least} B (min ${MIN})`);
console.log(`     ${got.ms} ms of chip time`);
process.exit(failed ? 1 : 0);
