// Pictures of the atomic wedgie's pages, to look at: the front page's section and /atomic, wide and on a phone.
//   node tools/atomicshots.mjs [url] [outdir]      default http://localhost:5199, shots/
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] || "http://localhost:5199").replace(/\/$/, ""), out = process.argv[3] || "shots";
mkdirSync(out, { recursive: true });
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const errs = [];
for (const [name, w, h] of [["wide", 1280, 900], ["phone", 390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(`${name}: ${e.message}`));
  await p.goto(base + "/atomic", { waitUntil: "networkidle" });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${out}/atomic-${name}.png` });
  await p.screenshot({ path: `${out}/atomic-${name}-full.png`, fullPage: true });
  await p.goto(base + "/", { waitUntil: "networkidle" });
  await p.locator("#atomic").scrollIntoViewIfNeeded();
  await p.waitForTimeout(3500);
  await p.locator("#atomic").screenshot({ path: `${out}/home-atomic-${name}.png` });
  await p.goto(base + "/order?item=atomic", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  await p.locator("#o-cart").screenshot({ path: `${out}/order-${name}.png` });
  await ctx.close();
}
await b.close();
console.log(errs.length ? "errors:\n" + errs.join("\n") : "no page errors");
