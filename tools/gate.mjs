// The release gate: every check a firmware release must pass, side by side (~10 min). tools/sign.mjs runs
// it and refuses to sign unless it passes, so nothing untested reaches wedgie.dev (Austin, 2026-10-03:
// "no more memory errors"). What it covers (docs/PLAN-BOOT-MEMORY.md, the north star):
//   - nothing compiles on the wedgie at boot: every core file ships as .mpy (0.3.13 broke on a real
//     board compiling slot.py at a fresh plug-in) and every .mpy matches its .py (tools/mpy.py --check)
//   - a fresh plug-in with each app and with none (tools/bootprobe.mjs): no traceback, >= 16 KB free
//   - installs and firmware updates where memory is tightest, with the core really replaced
//     (tools/chipprobe.mjs: onto Buttons, off Buttons, each with an update from an older core)
//   - checked installs against a hostile host (tools/test_job.py), the memory and style rules
// Not covered: the virtual chip has no computer reading the WEDGIE drive at boot (macOS does: that's
// when 0.3.13 broke), and no real board. Run tools/boardprobe.py on one before telling anyone it works.
//   node tools/gate.mjs            (needs uv; run from the tree being signed)
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fw = join(root, "firmware");
const UV = ["uv", "run", "-q", "--with", "mpy-cross==1.29.0.post2", "python3"];

function bootSource() {
  // the core may keep only these two as source: MicroPython runs nothing else at boot from a .py
  const carts = JSON.parse(readFileSync(join(fw, "carts.json"), "utf8"));
  const claimed = new Set(carts.flatMap((c) => c.files.map((n) => n.replace(/\.m?py$/, ""))));
  const names = readdirSync(fw);
  return names.filter((n) => n.endsWith(".py") && !["boot.py", "main.py"].includes(n) && !claimed.has(n.slice(0, -3)) && !names.includes(n.slice(0, -3) + ".mpy"));
}

const carts = JSON.parse(readFileSync(join(fw, "carts.json"), "utf8")).map((c) => c.mod);
const jobs = [
  ["test_job", ["python3", "tools/test_job.py"]],
  ["test_memory", ["python3", "tools/test_memory.py"]],
  ["test_style", ["python3", "tools/test_style.py"]],
  ["mpy --check", [...UV, "tools/mpy.py", "--check"]],
  ["chip: install Buttons + update", ["node", "tools/chipprobe.mjs", "--from", "hello", "--to", "buttons"]],
  ["chip: install over Buttons + update", ["node", "tools/chipprobe.mjs", "--from", "buttons", "--to", "hello"]],
  ...["none", ...carts].map((a) => [`fresh plug-in: ${a}`, ["node", "tools/bootprobe.mjs", a]]),
];

const t0 = Date.now();
const src = bootSource();
let failed = src.length ? [`compiled core: ${src.join(" ")} would compile on the wedgie at boot (run tools/mpy.py)`] : [];
console.log(`gate: ${jobs.length + 1} checks, side by side`);
const results = await Promise.all(jobs.map(([name, cmd]) => new Promise((res) => {
  const p = spawn(cmd[0], cmd.slice(1), { cwd: root });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => {
    const fails = out.split("\n").filter((l) => /^FAIL|FAILED|out of date|Error/.test(l)).slice(0, 3);
    console.log(`${code === 0 ? "ok  " : "FAIL"} ${name} (${Math.round((Date.now() - t0) / 1000)} s)${code === 0 ? "" : "\n       " + (fails.join("\n       ") || out.slice(-300))}`);
    res(code === 0 ? null : name);
  });
})));
console.log(`${src.length ? "FAIL" : "ok  "} compiled core: nothing but boot.py and main.py runs from source`);
failed = failed.concat(results.filter(Boolean));
console.log(failed.length ? `gate FAILED: ${failed.join("; ")}` : `gate passed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failed.length ? 1 : 0);
