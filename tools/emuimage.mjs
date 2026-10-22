// The flash a new virtual wedgie (wedgie.dev/emu) starts with: the littlefs part of a wedgie as the bench
// leaves it (this tree's firmware + Welcome), gzipped, at public/emu/wedgie-fs.img.gz. Without it a new
// one installs over its slow virtual USB (~10 min). Run by tools/sign.mjs after a release; an older image
// is fine (it's then a wedgie on older firmware, and wedgie.dev updates it like any other).
// Needs uv (littlefs-python).   node tools/emuimage.mjs
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { firmware, image } from "./rp2040/image.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public/emu/wedgie-fs.img.gz");
const F = firmware();
const version = (F.file("wedgie.py").toString().match(/VERSION = "([^"]+)"/) || [])[1];
const gz = gzipSync(image(F, "welcome"), { level: 9 });
writeFileSync(out, gz);
console.log(`emu image: wedgie ${version} + Welcome, ${Math.round(gz.length / 1024)} KB -> public/emu/wedgie-fs.img.gz`);
