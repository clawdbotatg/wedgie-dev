// Scrolls the site like a person and screenshots each section, so the 3D wedgies (which load as they
// come near) actually render. node tools/scrollshots.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const url = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const [name, vp] of [["desktop", { width: 1360, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: name === "phone", hasTouch: name === "phone" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(url);
  await p.waitForFunction(() => !document.getElementById("wl"));
  for (const sec of ["#get", "#build .parts", "#build .case", "#agents"]) {
    await p.locator(sec).scrollIntoViewIfNeeded();
    await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center" }), sec);
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${out}/${name}-${sec.replace(/[#. ]+/g, "-").replace(/^-/, "")}.png` });
  }
  const n3d = await p.evaluate(() => document.querySelectorAll("canvas.w3d").length);
  await ctx.close();          // a page left open keeps its WebGL scenes rendering and starves the next
  console.log(name, "3D canvases:", n3d, errs.length ? "ERRORS: " + errs.join(" | ") : "no errors");
}
await b.close();
