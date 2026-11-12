// /connect with one working wedgie goes straight to its page (the list is a wasted tap). "All wedgies" and Back
// show the list, the header's Connect from there jumps again, and two wedgies get the list.
// Serve dist first (npx vite preview), then: node tools/skipprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + (process.platform === "darwin" ? "/Library/Caches/ms-playwright" : "/.cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const files = { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.55"', "apps.json": "[]" };
const A = { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico with RP2040", files };
const B = { uid: "aa11bb22cc152a2f", machine: "Raspberry Pi Pico with RP2040", files };
let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const open = async (list) => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(fakeWedgies, list);
  const page = await ctx.newPage();
  await page.goto(base + "/connect");
  return page;
};
const at = (page, path, ms = 20000) => page.waitForFunction((p) => location.pathname === p, path, { timeout: ms }).then(() => true, () => false);

const one = await open([A]);
check(await at(one, "/connect/3D9F01"), "one wedgie: /connect goes straight to its page");
await one.waitForSelector("[data-fw]:not([disabled])", { timeout: 30000 });
await one.click(".back");
await one.waitForSelector(".wrow[data-id]", { timeout: 15000 }).catch(() => {});
await one.waitForTimeout(1500);
check(new URL(one.url()).pathname === "/connect" && await one.locator(".wrow[data-id]").count() === 1, "All wedgies: the list, and it stays");
await one.click(".wrow[data-id]");
check(await at(one, "/connect/3D9F01"), "its row opens its page");
check(await one.locator("#d-another").count() === 1 && await one.locator('.wd-more a[href="/reset"]').count() === 1, "its page has Connect another and Reset a wedgie");
await one.goBack();
await one.waitForSelector(".wrow[data-id]", { timeout: 15000 }).catch(() => {});
await one.waitForTimeout(1500);
check(new URL(one.url()).pathname === "/connect", "Back: the list, no jump");
await one.click("#connect-btn");
check(await at(one, "/connect/3D9F01"), "the header's Connect on the list: its page again");

const two = await open([A, B]);
await two.waitForFunction(() => document.querySelectorAll(".wrow[data-id]").length === 2, null, { timeout: 25000 }).catch(() => {});
await two.waitForTimeout(1500);
check(new URL(two.url()).pathname === "/connect" && await two.locator(".wrow[data-id]").count() === 2, "two wedgies: the list");

await browser.close();
process.exit(bad ? 1 : 0);
