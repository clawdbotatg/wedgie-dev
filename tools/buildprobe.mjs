// /build: every choice lands in the URL, and opening that URL shows the same wedgie. Real taps.
// Serve dist first (npx vite preview), then: node tools/buildprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const out = process.argv[3];
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let fail = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) fail++; };

for (const vp of [{ width: 1360, height: 900, name: "desktop" }, { width: 390, height: 844, name: "phone", hasTouch: true, isMobile: true }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const tap = async (sel) => { const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); vp.hasTouch ? await el.tap() : await el.click(); await page.waitForTimeout(150); };
  const q = () => Object.fromEntries(new URL(page.url()).searchParams);

  await page.goto(base + "/build?app=hello&lid=mint");
  await page.waitForSelector("[data-app]");
  check(q().lid === "white", `${vp.name}: a link with a PLA-only lid falls back to the default`);
  await page.goto(base + "/build?app=usbwallet&chip=none&lid=pink");
  await page.waitForSelector("[data-app]");
  check(q().app === "usbwallet" && q().chip === "atecc" && q().lid === "pink" && q().base === "black", `${vp.name}: link read, wallet forces the chip, defaults filled in (${new URL(page.url()).search})`);
  check(await page.locator('#bld-chip [data-chip="none"]').isDisabled() && await page.locator('#bld-chip [data-chip="trustm"]').isDisabled(), `${vp.name}: "No chip" and Trust M off for the wallet (it needs the ATECC608)`);
  check((await page.locator("#bld-steps").innerText()).includes("ATECC608"), `${vp.name}: build list has the chip`);

  await tap('[data-app="demo"]');
  await tap('#bld-chip [data-chip="trustm"]');
  check(q().chip === "trustm" && (await page.locator("#bld-steps").innerText()).includes("Trust M"), `${vp.name}: Trust M picked, on the build list`);
  await tap('#bld-chip [data-chip="none"]');
  await tap('.sw[data-part="a"][data-color="blue"]');
  await tap('.sw[data-part="base"][data-color="orange"]');
  check(q().app === "demo" && q().chip === "none" && q().a === "blue" && q().base === "orange", `${vp.name}: taps land in the URL`);
  const steps = await page.locator("#bld-steps").innerText();
  check(!steps.includes("ATECC608") && steps.includes("base in orange") && steps.includes("A blue"), `${vp.name}: build list follows`);

  check(await page.locator('.sw[data-part="lid"][data-color="mint"]').count() === 0, `${vp.name}: a PLA-only color isn't offered for the case`);
  await tap('.sw[data-part="y"][data-color="mint"]');
  const buy = await page.locator("#bld-steps").innerText();
  check(q().y === "mint" && buy.includes("Mint PLA") && buy.includes("Orange PETG") && buy.includes("Pink PETG"), `${vp.name}: buttons take PLA; spools listed PETG/PLA`);

  const url = page.url();
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.waitForSelector("[data-app]");
  check(p2.url() === url, `${vp.name}: the same link opens the same wedgie`);
  // (evaluate, not locators: with two WebGL tabs open, a locator on the second one can stall)
  const picked = await p2.evaluate(() => [...document.querySelectorAll('[aria-pressed="true"]')].map((e) => e.dataset.app || e.dataset.part + "=" + e.dataset.color));
  check(["demo", "base=orange", "a=blue", "lid=pink"].every((x) => picked.includes(x)), `${vp.name}: its choices show as picked`);
  await p2.close();

  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(wide <= 0, `${vp.name}: no sideways scroll (${wide}px)`);
  await page.waitForTimeout(1500);
  if (out) { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `${out}/build-${vp.name}.png`, fullPage: true }); }
  check(!errs.length, `${vp.name}: no page errors ${errs.join(" | ")}`);
  await ctx.close();
}

// The front page links here.
{
  const page = await browser.newPage();
  await page.goto(base + "/");
  await page.waitForSelector("#custom", { state: "attached" });
  check(await page.locator('#custom a[href="/build"]').count() === 1, "front page: Customize one → /build");
}
await browser.close();
process.exit(fail ? 1 : 0);
