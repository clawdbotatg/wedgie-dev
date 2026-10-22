// Signs a firmware release: every file wedgie.dev publishes from firmware/ (the same ones tools/fw.mjs
// puts in the manifest), as "sha256  name" lines, signed with a release key (P-256). A wedgie checks
// the signature with RELEASE_KEYS in firmware/wedgie.py (wedgie.release_ok) before it trusts a file list,
// so a computer can't pass off other files as "Buttons" or "firmware 0.2.9" (docs/SECURITY-ROADMAP.md).
//   node tools/sign.mjs        runs the release gate (tools/gate.mjs), then writes release/firmware.txt +
//                              release/firmware.sig; run before every push
//                              that changes firmware/ (fw.mjs marks the manifest unsigned otherwise)
// The keys (firmware/wedgie.py RELEASE_KEYS) can't be copied: 0 is this Mac's Secure Enclave (Touch ID;
// ~/.wedgie/sekey + release-se.key, tools/sekey.swift), 1 the YubiKey (PIN + touch, tools/yksign.py).
// Either signs:  node tools/sign.mjs  (the Mac)   node tools/sign.mjs --yubikey
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { releaseText, root, signedSerial } from "./release.mjs";

const yk = process.argv.includes("--yubikey");
const se = join(homedir(), ".wedgie"), seKey = join(se, "release-se.key");
if (!yk && !existsSync(seKey)) { console.error(`sign: no ${seKey} on this Mac. Sign on the Mac that made it, or with --yubikey`); process.exit(1); }
const keys = [...readFileSync(join(root, "firmware/wedgie.py"), "utf8").matchAll(/\("([0-9a-f]{64})", "([0-9a-f]{64})"\)/g)].map((m) => [m[1], m[2]]);
if (keys.length !== 2) { console.error("sign: firmware/wedgie.py should list 2 RELEASE_KEYS"); process.exit(1); }
const pubOf = ([x, y]) => createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(x, "hex").toString("base64url"), y: Buffer.from(y, "hex").toString("base64url") }, format: "jwk" });

// The gate (tools/gate.mjs) first, every time: no signature for firmware that hasn't passed it. No flag
// skips it (Austin, 2026-10-03: no more memory errors reaching a wedgie).
{
  console.log("running the release gate (tools/gate.mjs, ~10 min); nothing is signed unless it passes");
  const g = spawnSync("node", [join(root, "tools/gate.mjs")], { cwd: root, stdio: "inherit" });
  if (g.status !== 0) { console.error("not signed: the gate failed"); process.exit(1); }
}
const text = releaseText(signedSerial() + 1);     // one more every signing: wedgies refuse a lower one (job.py)
const k = yk ? 1 : 0;
const run = yk ? spawnSync("uv", ["run", "-q", "--with", "yubikey-manager", "python3", join(root, "tools/yksign.py")], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] })
  : (console.log("Touch ID to sign"), spawnSync(join(se, "sekey"), ["sign", seKey], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }));
const [r, s] = (run.stdout || "").trim().split(" ");
if (run.status !== 0 || !r || !s || !verify("sha256", Buffer.from(text), { key: pubOf(keys[k]), dsaEncoding: "ieee-p1363" }, Buffer.from(r + s, "hex"))) {
  console.error("not signed: the key didn't sign, or its signature doesn't match firmware/wedgie.py"); process.exit(1);
}
writeFileSync(join(root, "release/firmware.txt"), text);
writeFileSync(join(root, "release/firmware.sig"), `${r} ${s}${k ? " " + k : ""}\n`);
console.log(`signed ${text.split("\n").length - 2} files, ${text.split("\n")[1]}`);
// the virtual wedgie's starting flash, from what was just signed (tools/emuimage.mjs)
spawnSync("node", [join(root, "tools/emuimage.mjs")], { cwd: root, stdio: "inherit" });
