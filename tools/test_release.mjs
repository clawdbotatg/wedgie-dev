// What must never be signed (audit 11-13): a compiled file in firmware/ with no source beside it (nobody can read a
// .mpy in review; published() signed it and sent it as core, and mpy.py --check never looked at it), and a firmware
// file with a MicroPython module's name. On a scratch copy of firmware/: the release step (tools/release.mjs
// checkFirmware, which sign.mjs runs before the Touch ID) and tools/mpy.py --check must both refuse and name it.
//   node tools/test_release.mjs      (needs uv, for mpy-cross)
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFirmware, root } from "./release.mjs";

let bad = 0;
const check = (ok, what, got = "") => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what, ok ? "" : String(got).slice(0, 300)); };
const T = mkdtempSync(join(tmpdir(), "release-")), fw = join(T, "firmware");
mkdirSync(join(T, "tools"));
cpSync(join(root, "firmware"), fw, { recursive: true });
copyFileSync(join(root, "tools/mpy.py"), join(T, "tools/mpy.py"));
const said = () => { try { checkFirmware(fw); return ""; } catch (e) { return e.message; } };
const mpy = () => { const r = spawnSync("uv", ["run", "-q", "--with", "mpy-cross==1.29.0.post2", "python3", join(T, "tools/mpy.py"), "--check"], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stderr || "") + (r.stdout || "") }; };

check(said() === "", "firmware/ as it is: can be signed", said());
let m = mpy();
check(m.ok, "…and every .mpy matches its source", m.out);

copyFileSync(join(fw, "ui.mpy"), join(fw, "hashlib.mpy"));        // bytecode with no source, named like a built-in
check(/hashlib\.mpy/.test(said()), "a hashlib.mpy with no source: the release step refuses it", said());
m = mpy();
check(!m.ok && /hashlib\.mpy/.test(m.out), "…and so does mpy.py --check", m.out);
rmSync(join(fw, "hashlib.mpy"));

copyFileSync(join(fw, "ui.mpy"), join(fw, "extra.mpy"));          // …or under any other name
check(/extra\.mpy/.test(said()), "an extra.mpy with no source: refused", said());
m = mpy();
check(!m.ok && /extra\.mpy/.test(m.out), "…and by mpy.py --check", m.out);
rmSync(join(fw, "extra.mpy"));

writeFileSync(join(fw, "json.py"), "MINE = 1\n");                 // source that would be imported for json
check(/json\.py/.test(said()), "a json.py in firmware/: refused (it would be imported in place of json)", said());
rmSync(join(fw, "json.py"));

check(said() === "", "back as it was: can be signed", said());
rmSync(T, { recursive: true });
console.log(bad ? `${bad} FAILED` : "ALL OK");
process.exit(bad ? 1 : 0);
