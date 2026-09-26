// Screenshots the "Put it together" scroll animation at a few points. node tools/assemblyshots.mjs [url] [w] [h]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const url = process.argv[2] || "http://localhost:4173/";
const vp = { width: +(process.argv[3] || 1360), height: +(process.argv[4] || 860) };
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ viewport: vp, deviceScaleFactor: 1.5, isMobile: vp.width < 600 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await p.goto(url); await p.waitForFunction(() => !document.getElementById("wl"));
for (const f of [0.04, 0.16, 0.4, 0.66, 0.97]) {
  await p.evaluate((f) => { const a = document.getElementById("assembly"); const top = a.getBoundingClientRect().top + scrollY; scrollTo(0, top + f * (a.offsetHeight - innerHeight)); }, f);
  await p.waitForTimeout(f === 0.04 ? 3000 : 1300);
  await p.screenshot({ path: `shots/asm-${vp.width}-${String(f).slice(2)}.png` });
}
console.log(errs.length ? "ERRORS " + errs.join(" | ") : "no errors"); await b.close();
