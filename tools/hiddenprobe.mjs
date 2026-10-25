// A firmware update from a background tab. Chrome slows a hidden tab's timers to one tick a second, and the
// site once paused 5 ms between each 256 bytes it wrote: in a background tab a 4 KB put took 16 s, past its
// 15 s, and every update failed with "did not answer (put drive.bin)" when the person switched tabs while it
// ran (a real board, 2026-10-24). Here every timer under a second runs as a second, like a hidden tab, and a
// fake wedgie on an older firmware (tools/fakewedgies.mjs) takes the whole update in raw 4 KB puts.
// Serve dist first (npx vite preview), then: node tools/hiddenprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + (process.platform === "darwin" ? "/Library/Caches/ms-playwright" : "/.cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
// a hidden tab: no timer fires sooner than a second
await ctx.addInitScript(() => {
  const st = window.setTimeout, si = window.setInterval;
  window.setTimeout = (f, ms, ...a) => st(f, Math.max(1000, ms || 0), ...a);
  window.setInterval = (f, ms, ...a) => si(f, Math.max(1000, ms || 0), ...a);
});
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.50"', "apps.json": "[]" } },
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
check((await page.evaluate(() => { const t = performance.now(); return new Promise((r) => setTimeout(() => r(performance.now() - t), 5)); })) >= 900, "timers run like a hidden tab's (a 5 ms sleep takes a second)");
const t0 = Date.now();
await page.click("[data-fw]");
const done = await page.waitForFunction(() => /Restarting it on the new firmware|Update failed[^\n]*/.exec(document.querySelector("main").innerText)?.[0], null, { timeout: 300000 })
  .then((h) => h.jsonValue(), () => "nothing after 5 minutes");
check(/Restarting/.test(done), `the update went through in a background tab (${((Date.now() - t0) / 1000).toFixed(0)} s): ${done}`);
const puts = await page.evaluate(() => window.__ports[0]._st.rawPuts || 0);
check(puts > 30, `it was sent in raw 4 KB puts (${puts})`);
check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
console.log(bad ? `${bad} FAILED` : "all ok");
await browser.close();
process.exit(bad ? 1 : 0);
