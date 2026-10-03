// /code end to end in headless Chromium, with GitHub faked: api.github.com and raw.githubusercontent.com
// are answered from local folders (a repo = a folder with wedgie.json). Checks: the starter repo loads
// and its app runs in the emulator; the real keyboard (D) moves it; its save reaches the page, an
// edited save runs it again; a folder opens; a broken wedgie.json says why; Buttons (the shelf's app) runs and answers a key. Screenshots go to <outdir>/code-*.png.
//   node tools/codeprobe.mjs <site url, e.g. http://localhost:4173> <outdir> [starter repo folder]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [site = "http://localhost:4173", out = "shots", starter = join(homedir(), "clawd/wedgie-starter")] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const repos = {
  "clawdbotatg/wedgie-starter": starter,
  "someone/broken": { "wedgie.json": JSON.stringify({ apps: [{ mod: "lcd", name: "Bad", files: ["x.py"] }] }) },
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
  const cors = { "access-control-allow-origin": "*" };
  await ctx.route("https://api.github.com/**", (r) => {
    const m = r.request().url().match(/repos\/([^/]+\/[^/]+)\/commits/);
    return m && repos[m[1]] ? r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ sha: SHA }) }) : r.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  await ctx.route("https://raw.githubusercontent.com/**", (r) => {
    const m = r.request().url().match(/githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/);
    const src = m && repos[m[1]];
    if (!src) return r.fulfill({ status: 404, headers: cors, body: "" });
    const body = typeof src === "string" ? (existsSync(join(src, m[2])) ? readFileSync(join(src, m[2])) : null) : src[m[2]];
    return body == null ? r.fulfill({ status: 404, headers: cors, body: "" }) : r.fulfill({ status: 200, headers: cors, body });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(site + "/code", { waitUntil: "load" });
  await page.waitForSelector("#c-repo");
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wedgie.emu.")) localStorage.removeItem(k); });

  // A GitHub repo: the starter's one app starts by itself.
  await page.fill("#c-repo", "clawdbotatg/wedgie-starter");
  await page.click("#c-try button");
  await page.waitForSelector("#c-shelf button.cart", { timeout: 20000 });
  check(await page.locator("#c-shelf .cart-name").first().textContent() === "Dodge", "the starter repo's Dodge is on the shelf");
  await page.click('#c-shelf .cart-slot[data-mod="dodge"] button.cart');
  const vwUp = () => page.waitForFunction(() => window.__codeVw && window.__codeVw.fps > 5, null, { timeout: 30000 });
  await vwUp();
  check(true, `Dodge runs in the virtual wedgie (${await page.evaluate(() => window.__codeVw.fps)} fps)`);
  await page.screenshot({ path: `${out}/code-page.png`, fullPage: true });

  // The keyboard: D (joystick right) moves the ship; nothing is pressed from JS.
  await page.locator("#c-vw .vw").focus();
  const before = await page.evaluate(() => window.__codeVw.screenshotPNG());
  await page.keyboard.down("d"); await page.waitForTimeout(600); await page.keyboard.up("d");
  check(before !== await page.evaluate(() => window.__codeVw.screenshotPNG()), "D on the keyboard moves the ship (the screen changes)");

  // Saves: one kept from an earlier run (emuprobe covers save.store reaching the page) shows up, can be
  // edited, and the game runs again from it.
  await page.evaluate(() => localStorage.setItem("wedgie.emu.saves.dodge", JSON.stringify({ best: { ext: ".json", b64: btoa("2") } })));
  await page.click("#c-again");
  await page.waitForSelector('#c-save-list [data-sv="best"]', { timeout: 10000 });
  check(true, "a kept save is listed under Saves");
  await page.click('#c-save-list [data-sv="best"]');
  await page.fill("#c-save-edit", "4321");
  await page.click("#c-save-put");
  await vwUp();
  await page.waitForTimeout(1500);
  const shot = await page.evaluate(() => window.__codeVw.screenshotPNG());
  await page.locator("#c-vw").screenshot({ path: `${out}/code-dodge-best.png` });
  const b = JSON.parse(await page.evaluate(() => localStorage.getItem("wedgie.emu.saves.dodge"))).best;
  check(atob(b.b64) === "4321", "an edited save is kept and the game runs again with it (see code-dodge-best.png: best 4321)");

  // Hi-Lo: its deck is shuffled by wedgie.rand; the emulator has no chip, so the Pico's own generator.
  await page.click('#c-shelf .cart-slot[data-mod="hilo"] button.cart');
  await page.waitForTimeout(4000);
  const src = await page.textContent("#c-out");        // an entry app owns the emulator: no exec, read what it printed
  check(/shuffled by os\.urandom \(no chip\)/.test(src), `Hi-Lo: no chip in the emulator, and it says so: ${src.trim().slice(0, 80)}`);
  const h1 = await page.evaluate(() => window.__codeVw.screenshotPNG());
  await page.locator("#c-vw .vw").focus();
  await page.keyboard.down("w"); await page.waitForTimeout(150); await page.keyboard.up("w");
  await page.waitForTimeout(800);
  check(h1 !== await page.evaluate(() => window.__codeVw.screenshotPNG()), "Hi-Lo: W (up: higher) turns the next card");
  await page.locator("#c-vw").screenshot({ path: `${out}/code-hilo.png` });
  check(!/Traceback/.test(await page.textContent("#c-out")), "Hi-Lo: no traceback in Output");

  // A folder from this computer (the fallback input; Chrome's picker can't be driven headless).
  await page.evaluate(() => { document.querySelector("#c-dirin").closest("label").hidden = false; });
  await page.setInputFiles("#c-dirin", starter);
  await page.waitForFunction(() => /wedgie-starter: 2 apps/.test(document.querySelector("#c-note")?.textContent || ""), null, { timeout: 10000 });
  check(true, `a folder opens: ${await page.textContent("#c-note")}`);

  await page.fill("#c-repo", "someone/broken");
  await page.click("#c-try button");
  await page.waitForFunction(() => /Couldn't load/.test(document.querySelector("#c-note")?.textContent || ""), null, { timeout: 10000 });
  const why = await page.textContent("#c-note");
  check(/firmware module/.test(why), `a broken wedgie.json says why: ${why.slice(0, 110)}`);
  await page.fill("#c-repo", "nobody/nothing");
  await page.click("#c-try button");
  await page.waitForFunction(() => /no public repo/.test(document.querySelector("#c-note")?.textContent || ""), null, { timeout: 10000 });
  check(true, "a repo GitHub doesn't have says so");

  // Buttons (the shelf's app: in the manifest, not a repo) on the virtual wedgie: it starts, draws, and
  // its first check (N: joystick up, W on the keyboard) moves on when pressed.
  const lines = await page.evaluate(() => new Promise((res) => {
    const got = [];
    const off = window.__codeVw.onOutput((l) => got.push(l));
    window.__codeVw.reboot("buttons", null).then(() => setTimeout(() => { off(); res(got); }, 3000), (e) => { off(); res([...got, "reboot failed: " + e.message]); });
  }));
  await page.waitForFunction(() => window.__codeVw.fps > 5, null, { timeout: 30000 }).then(() => true, () => false);
  const ready = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.type === "ready");
  check(ready?.running === "buttons" && !lines.some((l) => /Traceback|failed/.test(l)), `Buttons, the shelf's app, starts on the virtual wedgie: ${ready ? "running " + ready.running : lines.slice(-4).join(" | ")}`);
  await page.locator("#c-vw .vw").focus();
  const k0 = await page.evaluate(() => window.__codeVw.screenshotPNG());
  await page.waitForTimeout(800);
  const k1 = await page.evaluate(() => window.__codeVw.screenshotPNG());
  check(k0 === k1, "Buttons: it waits for its first button (the screen holds still)");
  await page.keyboard.down("w"); await page.waitForTimeout(150); await page.keyboard.up("w");
  await page.waitForTimeout(800);
  check(k1 !== await page.evaluate(() => window.__codeVw.screenshotPNG()), "Buttons: W (up, its first check) moves it on");
  await page.locator("#c-vw").screenshot({ path: `${out}/code-buttons.png` });
  check(!errs.length, `no page errors${errs.length ? ": " + errs.join("; ") : ""}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
