// Memory on a real RP2040 (CLAUDE.md landmine 13): the firmware runs on a virtual RP2040 (rp2040js, the
// very MicroPython build wedgie.dev flashes, its real ~230 KB heap: tools/rp2040/chip.mjs), and this
// drives it the way the site does (src/serial/install.ts job(): hello, sums, the job, A pressed on its
// buttons, the signed list, sums, the files in 1024-byte chunks, commit, the restart):
//   - every app installed over every other app's running copy (from each app to the next);
//   - a full firmware update (every core file) while each app runs;
// A MemoryError, a traceback, "wedgie broke" or any error answer fails it. It prints the least free heap
// seen (hello's ram, asked mid-job). The release list is signed with a throwaway key put in the test
// image's wedgie.py, so the real P-256 check (and its memory) runs too. The browser emulator can't do
// this: its heap starts at 128 MB and grows on demand.
//   node tools/chipprobe.mjs [--fw <firmware dir>] [--from <app>] [--to <app>] [--no-update] [--log <file>]
//   (needs uv: the flash image is made with littlefs-python)
import { generateKeyPairSync, createPublicKey, sign, createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { host } from "./rp2040/chip.mjs";
import { firmware, image, appEntry } from "./rp2040/image.mjs";

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const F = firmware(arg("--fw") || undefined);
const LOG = arg("--log");                 // every byte the chip sends, to read after a failure
if (LOG) writeFileSync(LOG, "");
const version = (F.file("wedgie.py").toString().match(/VERSION = "([^"]+)"/) || [])[1];

// a throwaway release key: the test image's wedgie.py trusts it, the list is signed with it
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = createPublicKey(privateKey).export({ format: "jwk" });
const hx = (b) => Buffer.from(b, "base64url").toString("hex");
const wedgiePy = Buffer.from(F.file("wedgie.py").toString().replace(/^RELEASE_KEY = .*$/m, `RELEASE_KEY = ("${hx(jwk.x)}", "${hx(jwk.y)}")`));
const fileOf = (n) => (n === "wedgie.py" ? wedgiePy : F.file(n));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const relText = `wedgie-release 1\nversion ${version}\n` + F.all.map((n) => `${sha(fileOf(n))}  ${n}\n`).join("");
const sg = sign("sha256", Buffer.from(relText), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex");
const relSig = sg.slice(0, 64) + " " + sg.slice(64);

const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|Traceback|wedgie broke/;
let failed = 0, leastFree = Infinity, leastWhere = "";
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

function wedgie(app) {
  const h = host({ fs: image(F, app, { "wedgie.py": wedgiePy }), onData: LOG && ((b) => appendFileSync(LOG, Buffer.from(b))) });
  for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);     // buttons: pulled up
  let id = 100;
  const w = {
    h,
    req: (m, ms) => h.req({ ...m, id: ++id }, ms),
    press(k) {
      const p = h.chip.mcu.gpio[KEYS[k]];
      p.setInputValue(false); h.chip.run(150); p.setInputValue(true); h.chip.run(50);
    },
    ram(where) {
      const r = w.req({ type: "hello" }, 8000)?.ram;
      if (typeof r === "number" && r < leastFree) { leastFree = r; leastWhere = where; }
      return r;
    },
  };
  if (!h.until((b) => b.includes('"ready"'), 30000, 20)) throw new Error(`${app}: no ready line: ${JSON.stringify(h.out.slice(-400))}`);
  h.chip.run(1500);                 // the app's first screens
  return w;
}

/** One checked job the way install.ts sends it (0.3.10+). true, or what went wrong. */
function job(w, title, write, del, apps, where) {
  const h = w.req({ type: "hello" });
  if (!h?.jobs) return `hello: ${JSON.stringify(h)}`;
  const ex = w.req({ type: "sums", names: [], exists: F.all }, 30000);
  if (!ex?.sums) return `sums before the job: ${JSON.stringify(ex)}`;
  w.h.chip.write(JSON.stringify({ type: "job", job: title, version, write, delete: del, apps: apps && JSON.stringify(apps), bytes: write.reduce((t, n) => t + fileOf(n).length, 0), id: 900 }) + "\n");
  w.h.chip.run(800);                // the question is up
  w.press("A");
  let g = null;
  w.h.until((b) => { const m = b.match(/\{[^\n]*"id": 900[,}][^\n]*\n/); if (m) g = JSON.parse(m[0]); return !!m; }, 20000);
  if (g?.type !== "go") return `job: ${JSON.stringify(g)}`;
  w.ram(where + ", after the yes");
  const a = w.req({ type: "release", release: relText, sig: relSig }, 240000);
  if (a?.type !== "ok") return `release: ${JSON.stringify(a)}`;
  w.ram(where + ", after the signature");
  const s = w.req({ type: "sums", names: write }, 60000);
  if (s?.type !== "sums") return `sums: ${JSON.stringify(s)}`;
  for (const n of write.filter((n) => s.sums[n] !== sha(fileOf(n)))) {
    const buf = fileOf(n);
    for (let o = 0; o < Math.max(buf.length, 1); o += 1024) {
      const p = w.req({ type: "put", name: n, data: buf.subarray(o, o + 1024).toString("base64"), end: o + 1024 >= buf.length }, 30000);
      if (p?.type !== "ok") return `put ${n} @${o}: ${JSON.stringify(p)}`;
    }
    w.ram(`${where}, after ${n}`);
  }
  w.h.take();
  const d = w.req({ type: "commit" }, 30000);
  if (d?.type !== "done") return `commit: ${JSON.stringify(d)}`;
  if (!w.h.until((b) => b.includes('"ready"'), 30000, 20)) return `no ready after the restart: ${JSON.stringify(w.h.out.slice(-300))}`;
  return true;
}

// what went wrong: from the first traceback (or error line) on, so the cause is in the output
const bad = (w) => { const L = w.h.out.split("\n"), i = L.findIndex((l) => BAD.test(l) || /Error/.test(l)); return L.slice(i, i + 8).map((l) => l.trim()).join(" / "); };
const carts = F.carts;
const from = arg("--from"), to = arg("--to");
const pairs = from ? [[carts.find((c) => c.mod === from), carts.find((c) => c.mod === (to || from))]] : carts.map((c, i) => [c, carts[(i + 1) % carts.length]]);
console.log(`firmware ${version} (${F.dir}) on a virtual RP2040, MicroPython ${"v1.29.0"}`);
for (const [a, b] of pairs) {
  const t0 = Date.now();
  let w;
  try { w = wedgie(a.mod); }
  catch (e) { check(false, `${a.mod} starts: ${e.message.slice(0, 300)}`); continue; }   // an app that can't start (F3) fails here
  const r0 = w.ram(`${a.mod} running`);
  const del = a.files.filter((n) => !b.files.includes(n) && !F.core.includes(n));
  let r = job(w, `Install ${b.name}`, b.files, del, [appEntry(F, b)], `${a.mod} -> ${b.mod}`);
  check(r === true && !BAD.test(w.h.out), `install ${b.mod} while ${a.mod} runs (${r0} B free before): ${r === true ? "done, restarted" : r} ${BAD.test(w.h.out) ? "| " + bad(w) : ""}(${Math.round((Date.now() - t0) / 1000)} s)`);
  if (args.includes("--no-update")) continue;
  w = wedgie(a.mod);       // it started a moment ago, so it starts again
  r = job(w, "Update firmware", F.core, [], null, `${a.mod}, firmware update`);
  check(r === true && !BAD.test(w.h.out), `firmware update (${F.core.length} core files) while ${a.mod} runs: ${r === true ? "done" : r} ${BAD.test(w.h.out) ? "| " + bad(w) : ""}`);
}
console.log(`     least free heap seen: ${leastFree} bytes (${leastWhere})`);
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
