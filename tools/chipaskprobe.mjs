// Who may open the secure chip (firmware 0.3.79+, firmware/chipask.py), on the virtual RP2040. An app that
// opens it (optiga.Chip()) and then asks the firmware for random bytes:
//   signed, says it uses the chip ("chipuse": true)      -> let through
//   signed, doesn't say so                                -> OSError "secure chip: not for this app"
//   put on before 0.3.79 (no word): safe/secret/welcome   -> let through; any other -> refused
//   a computer had full control (the "modified" mark)     -> the wedgie asks; green lets it through, red doesn't
// and wedgie.rand() works in every one (the firmware's own use). No Trust M on this chip: "let through" is any
// other error (the bus doesn't answer).
//   node tools/chipaskprobe.mjs
import { host } from "./rp2040/chip.mjs";
import { firmware, image } from "./rp2040/image.mjs";

const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
const code = (mod) => Buffer.from(`import time, wedgie
def run():
    try:
        import optiga
        optiga.Chip()
        print("ZAP chip open")
    except Exception as e:
        print("ZAP chip:", e)
    try:
        print("ZAP rand", len(wedgie.rand(8)))
    except Exception as e:
        print("ZAP rand failed:", e)
    while True:
        time.sleep_ms(50)
`);
const REFUSED = /ZAP chip: secure chip: not for this app/, ASKED = /ZAP chip/;

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

function run(mod, record, { modified = false, key = null } = {}) {
  const F = firmware();
  const i = F.carts.findIndex((c) => c.mod === mod);
  if (i >= 0) F.carts.splice(i, 1);                       // our app under a shelf app's name
  F.app({ mod, name: "Zap", entry: "run", files: [mod + ".py"] }, { [mod + ".py"]: code(mod) });
  const over = { "apps.json": Buffer.from(JSON.stringify([{ mod, name: "Zap", entry: "run", v: "1", ...record }])) };
  if (modified) over.modified = Buffer.from("");
  const h = host({ fs: image(F, mod, over) });
  for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);
  let waited = false;
  if (key) {
    waited = !h.until((b) => ASKED.test(b), 12000, 20);    // nothing until a button: the question is up
    const p = h.chip.mcu.gpio[KEYS[key]];
    h.chip.run(1500); p.setInputValue(false); h.chip.run(200); p.setInputValue(true);
  }
  h.until((b) => /ZAP rand/.test(b), 30000, 20);
  return { out: h.out, waited };
}
const through = (o) => ASKED.test(o) && !REFUSED.test(o) || /ZAP chip open/.test(o);
const rand = (o) => /ZAP rand 8/.test(o);

let r = run("zap", { chipuse: true });
check(through(r.out) && rand(r.out), "signed, uses the chip: let through, rand works");
r = run("zap", { chipuse: false });
check(REFUSED.test(r.out) && rand(r.out), "signed, doesn't say so: refused, rand still works");
r = run("zap", {});
check(REFUSED.test(r.out) && rand(r.out), "from before 0.3.79, not one of the three: refused");
r = run("safe", {});
check(through(r.out) && rand(r.out), "from before 0.3.79, Safe Signer: let through");
r = run("zap", { chipuse: false }, { modified: true, key: "A" });
check(r.waited && through(r.out) && rand(r.out), "full control was given: it asks, green lets it through");
r = run("zap", { chipuse: true }, { modified: true, key: "Y" });
check(r.waited && REFUSED.test(r.out) && rand(r.out), "full control was given: it asks, red refuses");
if (failed) console.log(r.out.slice(-600));
console.log(failed ? `${failed} FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
