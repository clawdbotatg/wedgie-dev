// The flash wedgie.dev/sandbox starts from: this tree's firmware + Safe Signer (the shelf's copy), with the
// stand-in secure chip tools/safechip.mjs uses (it shows every screen; it can't sign), gzipped, at
// public/sandbox/safe-fs.img.gz. Run by tools/sign.mjs after a release. An older image still works: its app
// asks for its own data (public/clear/<tag>), which stays on the site.
// Needs uv (littlefs-python).   node tools/sandboximage.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { firmware, image } from "./rp2040/image.mjs";
import { ATECC } from "./rp2040/atecc.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public/sandbox");
mkdirSync(dir, { recursive: true });
const F = firmware();
const gz = gzipSync(image(F, "safe", { "atecc.py": Buffer.from(ATECC) }, ["atecc.mpy"]), { level: 9 });
writeFileSync(join(dir, "safe-fs.img.gz"), gz);
console.log(`sandbox image: Safe Signer, ${Math.round(gz.length / 1024)} KB -> public/sandbox/safe-fs.img.gz`);
