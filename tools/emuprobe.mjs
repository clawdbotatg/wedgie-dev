// The virtual wedgie end to end in headless Chromium: builds the site with its test page
// (WEDGIE_EMU_TEST=1, into node_modules/.cache/emutest), serves it with `vite preview` (which sends
// COOP/COEP), mounts the device, waits for the launcher, opens Hello with down + A, quits with X,
// and checks the launcher is back; then the Wallet, Demo (a busy loop), exec, reboot, and the
// postMessage fallback without cross-origin isolation. Screenshots go to shots/emu-*.png.
//   node tools/emuprobe.mjs [--no-build | --dev] [outdir]      (--dev: the `vite` dev server instead)
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) || join(root, "shots");
const outDir = "node_modules/.cache/emutest";
const port = 4179;
mkdirSync(out, { recursive: true });

const dev = args.includes("--dev");
if (!dev && !args.includes("--no-build")) {
  execSync(`npx tsc --noEmit && npx vite build --outDir ${outDir} --emptyOutDir`, { cwd: root, stdio: "inherit", env: { ...process.env, WEDGIE_EMU_TEST: "1" } });
}
const server = spawn("npx", dev ? ["vite", "--port", String(port), "--strictPort"] : ["vite", "preview", "--outDir", outDir, "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes(String(port))) { clearTimeout(t); res(); } });
});

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

try {
  const page = await (await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/emu.html`);
  check(await page.evaluate(() => self.crossOriginIsolated), "page is cross-origin isolated (SharedArrayBuffer keys)");
  await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });

  // Sample the 240x240 screen through the public API: a pixel's RGB.
  const px = (x, y) => page.evaluate(([x, y]) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 240; const g = c.getContext("2d"); g.drawImage(im, 0, 0); res([...g.getImageData(x, y, 1, 1).data.slice(0, 3)]); };
    im.src = window.vw.screenshotPNG();
  }), [x, y]);
  const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  // The launcher: white, the green/grey/red stripes at y 10/19/28 (menu.py).
  const isLauncher = async () => near(await px(120, 12), [34, 196, 82]) && near(await px(120, 30), [227, 49, 44]) && near(await px(3, 120), [254, 254, 254]);
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };

  check(await waitFor(isLauncher, 15000), `launcher drawn (${Date.now() - t0} ms after navigation)`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/emu-launcher.png` });
  await page.locator(".vw").screenshot({ path: `${out}/emu-launcher-device.png` });
  // Hello is the first app; move down to Buttons and back up so the joystick path is exercised,
  // then open with A.
  await page.evaluate(async () => { await window.vw.press("down"); await window.vw.press("up"); await window.vw.press("A"); });
  // hello.py: black screen, a DARK title bar, "hello pico" in yellow.
  const isHello = async () => near(await px(120, 100), [0, 0, 0], 8) || near(await px(3, 60), [0, 0, 0], 8);
  check(await waitFor(isHello), "Hello app opened (down, up, A)");
  // fps while Hello bounces
  const f0 = await page.evaluate(() => new Promise((res) => { let n = 0; const off = window.vw.onFrame(() => n++); setTimeout(() => { off(); res(n); }, 2000); }));
  console.log(`     fps while Hello runs: ${(f0 / 2).toFixed(1)} (frames drawn on the page per second)`);
  await page.locator(".vw").screenshot({ path: `${out}/emu-hello-device.png` });
  // keyboard path: focus the device, press B with the real keyboard; Hello shows "key: B"
  await page.locator(".vw").focus();
  await page.keyboard.down("b"); await page.waitForTimeout(100); await page.keyboard.up("b");
  await page.waitForTimeout(200);
  await page.locator(".vw").screenshot({ path: `${out}/emu-hello-keyB.png` });
  // pointer path: click the drawn X button
  const box = await page.locator('.vw [data-k="X"] .cap').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  check(await waitFor(isLauncher), "X (clicked on the drawn button) returned to the launcher");
  await page.locator(".vw").screenshot({ path: `${out}/emu-back.png` });

  // exec + the Wallet app (no chip: software key) must not crash
  const ex = await page.evaluate(() => window.vw.exec("1 + 1"));
  check(ex.trim() === "2", `exec("1 + 1") -> ${JSON.stringify(ex)}`);
  const hello = await page.evaluate(() => window.vw.exec("import wedgie; wedgie.hello()['fw']"));
  check(/wedgie-/.test(hello), `wedgie.hello() -> ${hello.trim()}`);
  const apps = await page.evaluate(() => window.vw.exec("import menu; [a['mod'] for a in menu.apps]"));
  const n = JSON.parse(apps.replace(/'/g, '"')).indexOf("usbwallet");
  await page.evaluate(async (n) => { for (let i = 0; i < n; i++) await window.vw.press("down"); await window.vw.press("A"); }, n);
  await page.waitForTimeout(2500);
  const running = await page.evaluate(() => window.vw.exec("menu.running and menu.running[0]['mod']"));
  check(/usbwallet/.test(running), `Wallet app running (${running.trim()})`);
  await page.locator(".vw").screenshot({ path: `${out}/emu-wallet.png` });
  await page.evaluate(() => window.vw.press("X"));
  check(await waitFor(isLauncher), "X returned from the Wallet app");

  // Demo: an app whose entry (demo.run) owns the CPU until X. Frames must still reach the page, and
  // X (read straight from the pin inside its loop) must come back.
  const di = JSON.parse(apps.replace(/'/g, '"')).indexOf("demo");
  // Back to back, no pause: press() waits until the firmware has read each press, so the A cannot
  // overtake the last up while the launcher is busy redrawing. (exec waits while Demo owns the CPU,
  // so the launcher position is checked after X.)
  await page.evaluate(async (n) => { for (let i = 0; i < n; i++) await window.vw.press("up"); await window.vw.press("A"); }, n - di);
  await page.waitForTimeout(1500);
  const fd = await page.evaluate(() => new Promise((res) => { let k = 0; const off = window.vw.onFrame(() => k++); setTimeout(() => { off(); res(k); }, 2000); }));
  console.log(`     fps while Demo (busy loop) runs: ${(fd / 2).toFixed(1)}`);
  check(fd > 4, "Demo (busy loop) keeps drawing");
  await page.locator(".vw").screenshot({ path: `${out}/emu-demo.png` });
  await page.evaluate(() => window.vw.press("X", 150));
  check(await waitFor(isLauncher), "X returned from Demo");
  const dm = await page.evaluate(() => window.vw.exec("menu.sel"));
  check(+dm === di, `${n - di} x up then A, back to back, opened Demo (launcher at ${dm.trim()}, Demo is ${di})`);

  // reboot comes back to the launcher
  await page.evaluate(() => window.vw.reboot());
  check(await waitFor(isLauncher, 15000), "reboot() comes back to the launcher");
  const log = await page.locator("#log").textContent();
  check(!/Traceback/.test(log), "no Python tracebacks on the console" + (/Traceback/.test(log) ? ":\n" + log : ""));
  check(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));

  // Without cross-origin isolation (no SharedArrayBuffer) keys fall back to postMessage.
  const ctx2 = await browser.newContext({ viewport: { width: 760, height: 900 } });
  await ctx2.route(() => true, async (route) => {
    const r = await route.fetch();
    const headers = { ...r.headers() };
    delete headers["cross-origin-opener-policy"]; delete headers["cross-origin-embedder-policy"];
    await route.fulfill({ response: r, headers });
  });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://localhost:${port}/emu.html`);
  check(!(await p2.evaluate(() => self.crossOriginIsolated)), "fallback page is not isolated");
  await p2.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  await p2.waitForTimeout(500);
  await p2.evaluate(async () => { await window.vw.press("A", 150); });
  await p2.waitForTimeout(800);
  const fb = await p2.evaluate(() => window.vw.exec("import menu; menu.running and menu.running[0]['mod']"));
  check(/hello/.test(fb), `fallback (postMessage keys): A opened Hello (${fb.trim()})`);
  await ctx2.close();
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
