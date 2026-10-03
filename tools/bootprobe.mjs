// A fresh plug-in, on the virtual RP2040 (tools/rp2040/chip.mjs: the MicroPython build wedgie.dev
// flashes, a real board's heap): boot.py adds the WEDGIE drive, the "Mac" reads all of it at once (the
// mount: every sector, twice, then a TEST UNIT READY a second; chip.mjs mscHost), and main.py starts
// the app meanwhile. 0.3.12-0.3.19 said "wedgie broke: memory allocation failed" here (a real board;
// here too once the Mac's reads were played: the drive's read path made objects per sector). Each app, and no app: no traceback, and the free heap with it running is
// at least MIN. One app per process, so tools/gate.mjs runs them side by side.
//   node tools/bootprobe.mjs [app ...|none] [--fw <firmware dir>]     (no app named: all of them)
import { host } from "./rp2040/chip.mjs";
import { firmware, image } from "./rp2040/image.mjs";

export const MIN = 16384;
const KEYS = [15, 17, 19, 21, 2, 18, 16, 20, 3];      // every button up (pulled up), so Y doesn't skip the drive
const BAD = /MemoryError|memory allocation failed|Traceback|wedgie broke/;

const args = process.argv.slice(2);
const fi = args.indexOf("--fw");
const F = firmware(fi >= 0 ? args[fi + 1] : undefined);
const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--fw");
const apps = named.length ? named : ["none", ...F.carts.map((c) => c.mod)];

let failed = 0;
for (const a of apps) {
  const app = a === "none" ? null : a;
  const h = host({ fs: image(F, app), drive: true });
  for (const p of KEYS) h.chip.mcu.gpio[p].setInputValue(true);
  let all = "";
  const seen = () => (all += h.take());
  const up = h.until((b) => /"ready"|wedgie broke|Traceback/.test(b), 40000, 20);
  seen();
  h.chip.run(2500);                       // its first screens
  seen();
  const hi = h.req({ type: "hello", id: 7 }, 8000);
  seen();
  const ram = hi?.ram;
  const dr = h.chip.drive || {};
  const why = !dr.reads ? `the Mac never read the drive (${JSON.stringify(dr)})` : dr.failed ? `drive reads failed: ${dr.errors.join(", ")}` : !up ? "never said ready" : BAD.test(all) ? all.split("\n").filter((l) => BAD.test(l) || /File "/.test(l)).slice(0, 4).join(" / ").trim()
    : typeof ram !== "number" ? `no hello: ${JSON.stringify(hi)}` : ram < MIN ? `only ${ram} B free (min ${MIN})` : "";
  console.log(`${why ? "FAIL" : "ok  "} fresh plug-in, ${app || "no app"}: ${why || `${ram} B free, the drive read (${(dr.bytes / 1024) | 0} KB)`}`);
  if (why) failed++;
}
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
