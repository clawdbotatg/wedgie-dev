// Memory on a real RP2040 (CLAUDE.md landmine 13): the firmware runs on a virtual RP2040 (rp2040js, the
// very MicroPython build wedgie.dev flashes, its real ~230 KB heap: tools/rp2040/chip.mjs), and this
// drives it the way the site does (src/serial/install.ts job(): hello, sums, the job, A pressed on its
// buttons, the signed list, sums, the files in 1024-byte chunks, commit, the restart):
//   - every app installed over another app's running copy (each over the one before it; --all: every pair);
//   - a full firmware update (every core file) while each app runs;
// A MemoryError, a traceback, "wedgie broke" or any error answer fails it. It prints the least free heap
// seen (hello's ram, asked mid-job). The release list is signed with a throwaway key put in the test
// image's wedgie.py, so the real P-256 check (and its memory) runs too. The browser emulator can't do
// this: its heap starts at 128 MB and grows on demand.
//   node tools/chipprobe.mjs [--fw <firmware dir>] [--from <app>] [--to <app>] [--no-update] [--all] [--b64] [--log <file>]
//   (needs uv: the flash image is made with littlefs-python)
import { generateKeyPairSync, createPublicKey, sign, createHash } from "node:crypto";
import { appendFileSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host } from "./rp2040/chip.mjs";
import { firmware, image, appEntry } from "./rp2040/image.mjs";
import { appLines } from "./release.mjs";

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const F = firmware(arg("--fw") || undefined);
// a second app to install over and from: Hello (tools/fixtures), a Timer app, beside the shelf's (Buttons: a loop)
F.app({ mod: "hello", name: "Hello", files: ["hello.py"] }, { "hello.py": readFileSync(new URL("./fixtures/hello.py", import.meta.url)) });
const LOG = arg("--log");                 // every byte the chip sends, to read after a failure
if (LOG) writeFileSync(LOG, "");
const version = (F.file("wedgie.py").toString().match(/VERSION = "([^"]+)"/) || [])[1];

// a throwaway release key: the test image's wedgie trusts it, the list is signed with it. wedgie ships
// compiled (0.3.14+), so the test copy is compiled too, as tools/mpy.py does (needs uv).
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = createPublicKey(privateKey).export({ format: "jwk" });
const hx = (b) => Buffer.from(b, "base64url").toString("hex");
const wedgiePy = Buffer.from(F.file("wedgie.py").toString().replace(/^RELEASE_KEY = .*$/m, `RELEASE_KEY = ("${hx(jwk.x)}", "${hx(jwk.y)}")`));
const KD = mkdtempSync(join(tmpdir(), "chipkey-"));
writeFileSync(join(KD, "wedgie.py"), wedgiePy);
execFileSync("uv", ["run", "-q", "--with", "mpy-cross==1.29.0.post2", "python3", "-c",
  "import mpy_cross,subprocess,sys; subprocess.run([mpy_cross.mpy_cross,'-s','wedgie.py','-o',sys.argv[2],sys.argv[1]],check=True)",
  join(KD, "wedgie.py"), join(KD, "wedgie.mpy")]);
const wedgieMpy = readFileSync(join(KD, "wedgie.mpy"));
const fileOf = (n) => (n === "wedgie.py" ? wedgiePy : n === "wedgie.mpy" ? wedgieMpy : F.file(n));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const relText = `wedgie-release 1\nversion ${version}\n` + F.all.map((n) => `${sha(fileOf(n))}  ${n}\n`).join("") + appLines(F.carts);
const sg = sign("sha256", Buffer.from(relText), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex");
const relSig = sg.slice(0, 64) + " " + sg.slice(64);

const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const BAD = /MemoryError|memory allocation failed|Traceback|wedgie broke/;
let failed = 0, leastFree = Infinity, leastWhere = "";
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

// old: the core as 0.3.13 and before had it, source (.py) where the release has bytecode (.mpy): a firmware
// update then sends, commits and boots every compiled file, and the old .py must be gone after (MicroPython
// imports a .py before a .mpy). The same files would go nowhere: their hashes match.
const compiled = F.core.filter((n) => n.endsWith(".mpy") && existsSync(join(F.dir, n.slice(0, -4) + ".py")));
const older = () => Object.fromEntries(compiled.map((n) => n.slice(0, -4) + ".py").map((n) => [n, fileOf(n)]));

function wedgie(app, old = false) {
  let all = "";      // everything it ever printed: h.take() clears h.out, and a failure before that must still count
  const h = host({ fs: image(F, app, old ? older() : { "wedgie.mpy": wedgieMpy }, old ? compiled : []), onData: (b) => { all += Buffer.from(b).toString("latin1"); if (LOG) appendFileSync(LOG, Buffer.from(b)); } });
  for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);     // buttons: pulled up
  let id = 100;
  const w = {
    h,
    get all() { return all; },
    req: (m, ms, raw) => h.req({ ...m, id: ++id }, ms, raw),
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
  const bin = args.includes("--b64") ? 0 : h.bin || 0;      // 0.3.16+: raw 4 KB puts, as the site sends them
  const ex = w.req({ type: "sums", names: [], exists: F.all }, 30000);
  if (!ex?.sums) return `sums before the job: ${JSON.stringify(ex)}`;
  w.h.chip.write(JSON.stringify({ type: "job", job: title, version, write, delete: del, apps: apps && JSON.stringify(apps), bytes: write.reduce((t, n) => t + fileOf(n).length, 0), raw: !!bin, id: 900 }) + "\n");
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
  const send = write.filter((n) => s.sums[n] !== sha(fileOf(n)));
  w.sent = send.length;
  const t0 = w.h.chip.ms, kb = send.reduce((t, n) => t + fileOf(n).length, 0) / 1024;
  for (const n of send) {
    const buf = fileOf(n);
    const size = bin ? Math.min(bin, 4096) : 1024;
    for (let o = 0; o < Math.max(buf.length, 1); o += size) {
      const part = buf.subarray(o, o + size), end = o + size >= buf.length;
      const p = bin ? w.req({ type: "put", name: n, end }, 30000, part) : w.req({ type: "put", name: n, data: part.toString("base64"), end }, 30000);
      if (p?.type !== "ok") return `put ${n} @${o}: ${JSON.stringify(p)}`;
    }
    w.ram(`${where}, after ${n}`);
  }
  w.put = `${kb.toFixed(0)} KB in ${((w.h.chip.ms - t0) / 1000).toFixed(1)} s on the chip, ${bin ? "raw" : "base64"}`;
  w.h.take();
  const d = w.req({ type: "commit" }, 30000);
  if (d?.type !== "done") return `commit: ${JSON.stringify(d)}`;
  if (!w.h.until((b) => b.includes('"ready"'), 30000, 20)) return `no ready after the restart: ${JSON.stringify(w.h.out.slice(-300))}`;
  return true;
}

// what went wrong: from the first traceback (or error line) on, so the cause is in the output
const bad = (w) => { const L = w.all.split("\n"), i = L.findIndex((l) => BAD.test(l) || /Error/.test(l)); return L.slice(i, i + 8).map((l) => l.trim()).join(" / "); };
const carts = F.carts;
const from = arg("--from"), to = arg("--to");
// default: each app over the one before it (a ring: every app goes on once, every app is the old one once).
// --all: every app over every other (56 installs, ~40 min).
const pairs = from ? [[carts.find((c) => c.mod === from), carts.find((c) => c.mod === (to || from))]]
  : args.includes("--all") ? carts.flatMap((a) => carts.filter((b) => b !== a).map((b) => [a, b]))
  : carts.map((c, i) => [c, carts[(i + 1) % carts.length]]);
console.log(`firmware ${version} (${F.dir}) on a virtual RP2040, MicroPython ${"v1.29.0"}`);
for (const [a, b] of pairs) {
  const t0 = Date.now();
  let w;
  try { w = wedgie(a.mod); }
  catch (e) { check(false, `${a.mod} starts: ${e.message.slice(0, 300)}`); continue; }   // an app that can't start (F3) fails here
  const r0 = w.ram(`${a.mod} running`);
  const del = a.files.filter((n) => !b.files.includes(n) && !F.core.includes(n));
  let r = job(w, `Install ${b.name}`, b.files, del, [appEntry(F, b)], `${a.mod} -> ${b.mod}`);
  if (r === true) {                 // it restarted into the new app, and it runs
    const back = w.h.out.match(/\{[^\n]*"type": "ready"[^\n]*\n/);
    if (!back || !back[0].includes(`"running": "${b.mod}"`) && !back[0].includes('"fw": "usb-1"')) r = `after the restart it runs ${back ? back[0].slice(0, 120) : "nothing"}`;
  }
  check(r === true && !BAD.test(w.all), `install ${b.mod} while ${a.mod} runs (${r0} B free before): ${r === true ? "done, restarted into it" : r} ${BAD.test(w.all) ? "| " + bad(w) : ""}(${Math.round((Date.now() - t0) / 1000)} s)`);
  if (args.includes("--no-update")) continue;
  w = wedgie(a.mod, true);  // the same app on an older core: every core .py differs
  const want = compiled.length;
  r = job(w, "Update firmware", F.core, [], null, `${a.mod}, firmware update`);
  if (r === true && w.sent !== want) r = `sent ${w.sent} files, not ${want}`;
  if (r === true) {                 // booted on the new core: every core file is the target's now
    w.h.chip.run(1500);
    const olds = Object.keys(older());
    const s = w.req({ type: "sums", names: [...F.core, ...olds] }, 60000);
    const off = F.core.filter((n) => s?.sums?.[n] !== sha(fileOf(n)));
    const left = olds.filter((n) => s?.sums?.[n]);
    if (off.length) r = `after the update these aren't the new ones: ${off.join(" ")}`;
    else if (left.length) r = `the old .py is still there (it would run instead): ${left.join(" ")}`;
  }
  check(r === true && !BAD.test(w.all), `firmware update (${want} core files sent, booted on them) while ${a.mod} runs: ${r === true ? "done, " + w.put : r} ${BAD.test(w.all) ? "| " + bad(w) : ""}`);
}
console.log(`     least free heap seen: ${leastFree} bytes (${leastWhere})`);
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
