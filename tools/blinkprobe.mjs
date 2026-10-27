// A firmware update whose wedgie's USB blinks again right after the page found it (the drive re-enumerating ~1 s
// after the restart): the install's open fails once. 10-27, a real board: the page gave up on that one failure
// ("Failed to open serial port"), said nothing, and the wedgie waited 30 s for it and went back to its app. The
// page must look again and go on (install.ts).
// Serve dist first (npx vite preview), then: node tools/blinkprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + (process.platform === "darwin" ? "/Library/Caches/ms-playwright" : "/.cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.50"', "apps.json": "[]" }, blink: true },
]);
// the fakes don't check signatures: an unsigned tree is served as signed (fakeserial.mjs does the same)
const man = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8"));
if (!man.signed) {
  await ctx.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));
  await ctx.route("**/fw/release.txt", (r) => r.fulfill({ contentType: "text/plain", body: `wedgie-release 1\nversion ${man.version}\n` + [...man.files].sort((a, b) => a.name < b.name ? -1 : 1).map((f) => `${f.sha256}  ${f.name}\n`).join("") }));
}

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(base + "/connect/3D9F01");
await page.waitForSelector("[data-fw]:not([disabled])", { timeout: 30000 });
const t0 = Date.now();
await page.click("[data-fw]");
const done = await page.waitForFunction(() => /Restarting it on the new firmware|Update failed[^\n]*/.exec(document.querySelector("main").innerText)?.[0], null, { timeout: 120000 })
  .then((h) => h.jsonValue(), () => "nothing after 2 minutes");
check(await page.evaluate(() => !!window.__ports[0]._st.blinked), "its USB blinked as the install opened it");
check(/Restarting/.test(done), `the update went through anyway (${((Date.now() - t0) / 1000).toFixed(0)} s): ${done}`);
// one whose USB never lets it open after the restart: the page must say so, not show a plain Update button
await ctx.close();
const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx2.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.50"', "apps.json": "[]" }, blink: "always" },
]);
if (!man.signed) {
  await ctx2.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));
  await ctx2.route("**/fw/release.txt", (r) => r.fulfill({ contentType: "text/plain", body: `wedgie-release 1\nversion ${man.version}\n` + [...man.files].sort((a, b) => a.name < b.name ? -1 : 1).map((f) => `${f.sha256}  ${f.name}\n`).join("") }));
}
const p2 = await ctx2.newPage();
p2.on("pageerror", (e) => errs.push(e.message));
await p2.goto(base + "/connect/3D9F01");
await p2.waitForSelector("[data-fw]:not([disabled])", { timeout: 30000 });
await p2.click("[data-fw]");
const SAID = /The update failed[^\n]*|didn't come back[^\n]*/;
const said = await p2.waitForFunction((re) => new RegExp(re).exec(document.querySelector("main").innerText)?.[0], SAID.source, { timeout: 120000 })
  .then((h) => h.jsonValue(), () => "nothing in 2 minutes");
check(SAID.test(said), `a USB that never lets it open: the page says so: ${said}`);
await p2.waitForTimeout(8000);
check(SAID.test(await p2.evaluate(() => document.querySelector("main").innerText)), "still says so 8 s later");
check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
console.log(bad ? `${bad} FAILED` : "all ok");
await browser.close();
process.exit(bad ? 1 : 0);
