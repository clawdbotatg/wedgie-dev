// Screenshots every step of the /assemble/3d playground (end of each step, and its middle with "mid").
//   node tools/pgshots.mjs [url] [w] [h] [steps e.g. 1,4,13] [mid]     -> shots/pg-<w>-<step>.png
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
const url = process.argv[2] || "http://localhost:5173/assemble/3d";
const vp = { width: +(process.argv[3] || 1360), height: +(process.argv[4] || 860) };
const only = process.argv[5] ? process.argv[5].split(",").map(Number) : null;
const mid = process.argv[6] === "mid";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: vp.width < 600, hasTouch: vp.width < 600 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
mkdirSync("shots", { recursive: true });
await p.goto(url); await p.waitForFunction(() => !document.getElementById("wl"));
await p.waitForSelector(".pg-stage.live", { timeout: 30000 });
const n = await p.$$eval("#pg-list button", (b) => b.length);
for (let i = 1; i <= n; i++) {
  if (only && !only.includes(i)) continue;
  await p.click(`#pg-list button[data-i="${i - 1}"]`);
  await p.evaluate((v) => { const s = document.getElementById("pg-scrub"); s.value = String(v); s.dispatchEvent(new Event("input")); }, mid ? 500 : 1000);
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(mid ? 4000 : 2500);
  await p.screenshot({ path: `shots/pg-${vp.width}-${String(i).padStart(2, "0")}${mid ? "m" : ""}.png` });
}
console.log(errs.length ? "ERRORS " + errs.join(" | ") : "no errors"); await b.close();
