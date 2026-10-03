// Signs a firmware release: every file wedgie.dev publishes from firmware/ (the same ones tools/fw.mjs
// puts in the manifest), as "sha256  name" lines, signed with the release key (P-256). A wedgie checks
// the signature with RELEASE_KEY in firmware/wedgie.py (wedgie.release_ok) before it trusts a file list,
// so a computer can't pass off other files as "Buttons" or "firmware 0.2.9" (docs/SECURITY-ROADMAP.md).
//   node tools/sign.mjs        writes release/firmware.txt + release/firmware.sig; run before every push
//                              that changes firmware/ (fw.mjs marks the manifest unsigned otherwise)
// The key is ~/.wedgie/release-key.pem, made on first run. It never goes in git, Vercel or a skill.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { releaseText, root } from "./release.mjs";

const keyPath = join(homedir(), ".wedgie", "release-key.pem");
if (!existsSync(keyPath) && !/^RELEASE_KEY = \(""/m.test(readFileSync(join(root, "firmware/wedgie.py"), "utf8"))) {
  // every wedgie out there trusts the key already in wedgie.py: a new one here would lock them all out
  console.error(`sign: no ${keyPath} on this machine, and firmware/wedgie.py already has a release key. Sign on the machine that has the key.`);
  process.exit(1);
}
if (!existsSync(keyPath)) {
  mkdirSync(join(homedir(), ".wedgie"), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  console.log("made a new release key:", keyPath, "(back it up somewhere safe)");
}
const priv = createPrivateKey(readFileSync(keyPath));
const jwk = createPublicKey(priv).export({ format: "jwk" });
const hex = (b64u) => Buffer.from(b64u, "base64url").toString("hex");
const qx = hex(jwk.x), qy = hex(jwk.y);

// The public key lives in the firmware; it's signed like everything else.
const wp = join(root, "firmware/wedgie.py");
const w = readFileSync(wp, "utf8");
const line = `RELEASE_KEY = ("${qx}", "${qy}")`;
if (!w.includes(line)) {
  writeFileSync(wp, w.replace(/^RELEASE_KEY = .*$/m, line));
  console.log("wrote RELEASE_KEY into firmware/wedgie.py");
}
const text = releaseText();
const sig = sign("sha256", Buffer.from(text), { key: priv, dsaEncoding: "ieee-p1363" }).toString("hex");
writeFileSync(join(root, "release/firmware.txt"), text);
writeFileSync(join(root, "release/firmware.sig"), sig.slice(0, 64) + " " + sig.slice(64) + "\n");
console.log(`signed ${text.split("\n").length - 2} files, ${text.split("\n")[1]}`);
