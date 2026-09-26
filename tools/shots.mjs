// Screenshots of the built site in headless Chromium: the loader mid-fill, then the page at desktop and
// phone widths. Serve dist first (npm run preview), then: node tools/shots.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const exe = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath: exe });

for (const [name, vp, mobile] of [["desktop", { width: 1360, height: 860 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  // slow the assets so the loader is visible mid-fill
  await page.route("**/assets/**", async (r) => { await new Promise((s) => setTimeout(s, 900)); r.continue(); });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/${name}-loader.png` });
  await page.waitForFunction(() => !document.getElementById("wl"), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}-top.png` });
  await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });
  console.log(name, errs.length ? "ERRORS: " + errs.join(" | ") : "no errors");
  await ctx.close();
}
await browser.close();
