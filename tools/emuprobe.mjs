// The virtual wedgie end to end in headless Chromium: builds the site with its test page
// (WEDGIE_EMU_TEST=1, into node_modules/.cache/emutest), serves it with `vite preview` (which sends
// COOP/COEP), mounts the device and checks it boots straight into its one app (Hello) and that X is
// the app's own button; saves (save.py) round-trip in the app's own folder; the USB hello says the
// slot runs it; then no app (the "no software yet" screen), the Wallet, Demo (a busy loop), and the
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
  // The slot's own screens (no software yet, ended): white, the green/grey/red stripes at y 10/19/28.
  const isBand = async () => near(await px(120, 12), [34, 196, 82]) && near(await px(120, 30), [227, 49, 44]) && near(await px(3, 120), [254, 254, 254]);
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
  // hello.py: black screen, a DARK title bar, "hello pico" in yellow.
  const isHello = async () => near(await px(120, 100), [0, 0, 0], 8) || near(await px(3, 60), [0, 0, 0], 8);

  check(await waitFor(isHello, 15000), `boots straight into Hello, no menu (${Date.now() - t0} ms after navigation)`);
  const f0 = await page.evaluate(() => new Promise((res) => { let n = 0; const off = window.vw.onFrame(() => n++); setTimeout(() => { off(); res(n); }, 2000); }));
  console.log(`     fps while Hello runs: ${(f0 / 2).toFixed(1)} (frames drawn on the page per second)`);
  await page.locator(".vw").screenshot({ path: `${out}/emu-hello-device.png` });
  // keyboard path: focus the device, press B (the K key) with the real keyboard; Hello shows "key: B"
  await page.locator(".vw").focus();
  await page.keyboard.down("k"); await page.waitForTimeout(100); await page.keyboard.up("k");
  await page.waitForTimeout(200);
  await page.locator(".vw").screenshot({ path: `${out}/emu-hello-keyB.png` });
  // pointer path: click the drawn X button. X is Hello's own button now: it keeps running.
  const box = await page.locator('.vw [data-k="X"] .cap').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(600);
  check(await isHello() && !(await isBand()), "X doesn't leave the app");
  check((await page.evaluate(() => window.vw.exec("import slot; slot.state"))).trim() === "'running'", "the slot says Hello is running");

  const ex = await page.evaluate(() => window.vw.exec("1 + 1"));
  check(ex.trim() === "2", `exec("1 + 1") -> ${JSON.stringify(ex)}`);
  const fw = await page.evaluate(() => window.vw.exec("import wedgie; wedgie.hello()['fw'], wedgie.hello()['slot'], wedgie.active()['mod']"));
  check(/wedgie-0\.[2-9].*1, 'hello'/.test(fw), `wedgie.hello(): ${fw.trim()}`);

  // saves: the app's own folder, JSON and bytes, the last good one kept, names(), delete
  const sv = await page.evaluate(() => window.vw.exec([
    "import save, os",
    "save.store('best', {'score': 120}); save.store('map', b'\\x01\\x02')",
    "print(save.game, save.load('best'), save.load('map'), save.load('nope', 7), sorted(save.names()), sorted(os.listdir('/saves/hello')))",
    "save.delete('map'); print(sorted(save.names()))",
  ].join("\n")));
  const svOut = sv.split("\n").filter((l) => !l.startsWith("@emusave ")).join("\n");   // the page's copy of each save (src/emu/flash.ts)
  check(/hello \{'score': 120\} b'\\x01\\x02' 7 \['best', 'map'\] \['best.json', 'map.bin'\]\s+\['best'\]/.test(svOut), `saves round-trip in /saves/hello: ${svOut.trim().replace(/\n/g, " | ")}`);
  check((sv.match(/^@emusave /gm) || []).length === 3, "every store and delete tells the page (@emusave), for /code's saves");
  const fl = await page.evaluate(() => window.vw.exec("save.FLOOR = 1 << 40\ntry:\n    save.store('big', 1)\n    print('wrote')\nexcept OSError as e:\n    print('refused', e)\nsave.FLOOR = 32 * 1024"));
  check(/refused flash full/.test(fl), `a save that would eat the floor is refused (${fl.trim()})`);
  const bad = await page.evaluate(() => window.vw.exec("try:\n    save.store('../x', 1)\nexcept ValueError:\n    print('no')"));
  check(bad.trim() === "no", "a save name can't leave the game's folder");

  // USB: the slot answers JSON lines while the app runs
  const line = await page.evaluate(() => new Promise((res) => { const off = window.vw.onOutput((l) => { if (l.includes('"id": 42')) { off(); res(l); } }); window.vw.write('{"id":42,"type":"hello"}\n'); setTimeout(() => res(""), 4000); }));
  check(/"slot": 1/.test(line) && /"running": "hello"/.test(line), "USB hello while Hello runs: slot 1, running hello");

  // files over USB while the app runs: ls, get (base64 parts), rm
  const ask = (msg, n = 1) => page.evaluate(([msg, n]) => new Promise((res) => { const got = []; const off = window.vw.onOutput((l) => { if (l.includes(`"id": ${msg.id}`)) { got.push(JSON.parse(l)); if (got.length >= n || got[0].n === got.length) { off(); res(got); } } }); window.vw.write(JSON.stringify(msg) + "\n"); setTimeout(() => res(got), 4000); }), [msg, n]);
  const ls = await ask({ id: 51, type: "ls", path: "/saves" });
  check(JSON.stringify(ls[0]?.files) === '[["/saves/hello/",0],["/saves/hello/best.json",14]]' && ls[0].free > 0, `USB ls /saves: ${JSON.stringify(ls[0]?.files)}`);
  const got = await ask({ id: 52, type: "get", path: "/saves/hello/best.json" });
  check(got.length === 1 && atob(got[0].data) === '{"score": 120}', `USB get: ${got[0] && atob(got[0].data)}`);
  const rmv = await ask({ id: 53, type: "rm", path: "/saves/hello" });
  const after = await ask({ id: 54, type: "ls", path: "/saves" });
  check(rmv[0]?.type === "ok" && JSON.stringify(after[0]?.files) === "[]", "USB rm: the game's saves folder gone");

  // no app: the "no software yet" screen
  await page.evaluate(() => window.vw.reboot(""));
  // the wedgie's own home: the boot logo's background, its green ID, the title in ink
  const isHome = async () => near(await px(3, 120), [254, 254, 254], 12) && !near(await px(120, 30), [227, 49, 44]);
  await page.waitForTimeout(1500);
  check(await isHome(), "no app: the wedgie's home screen");
  await page.locator(".vw").screenshot({ path: `${out}/emu-empty-device.png` });

  // the board's app Timers (slot._Timer): an app runs on them as usual, a tick is skipped until USB has
  // had a turn, and a Ctrl-C inside a tick reaches the main loop. (Only a real board shows the
  // starving itself; this checks the wrapper's logic.)
  const wr = await page.evaluate(() => window.vw.exec([
    "import slot, sys, time",
    "slot._wrap_timers()",
    "from machine import Timer",
    "n = [0]",
    "def cb(t):\n    n[0] += 1",
    "t = Timer(period=20, mode=Timer.PERIODIC, callback=cb)",
    "print(type(t).__name__, sys.modules['machine'].Timer is slot._Timer)",
  ].join("\n")));
  await page.waitForTimeout(600);
  const logic = await page.evaluate(() => window.vw.exec([
    "g = slot._guard(cb, t)",
    "slot._breath = False; slot._last = time.ticks_ms(); a = n[0]; g(None); b = n[0]",
    "slot._breath = True; g(None); c = n[0]; br = slot._breath",
    "slot._breath = False; slot._last = time.ticks_add(time.ticks_ms(), -50); g(None); d = n[0] - c",
    "def boom(_):\n    raise KeyboardInterrupt",
    "k = slot._guard(boom, t); slot._breath = True; k(None); kb = slot._kbd; slot._kbd = False",
    "ticks = n[0]",
    "slot.stop()",
    "print(ticks, b - a, c - b, br, kb, d)",
  ].join("\n")));
  const [ticks, skipped, ran, br, kb, late] = logic.trim().split(" ");
  check(/_Timer True/.test(wr) && +ticks > 5, `app Timers are wrapped and tick (${wr.trim()}, ${ticks} ticks)`);
  check(skipped === "0" && ran === "1" && br === "False", `a back-to-back tick waits until USB has had a turn (${logic.trim()})`);
  check(late === "1", "a tick that isn't back to back runs even before USB's turn (no choppy apps)");
  check(kb === "True", "a Ctrl-C inside a tick reaches the main loop");

  // the lock (main.py seals a real board; here it's switched on by hand): "let this computer in?" asks
  // on the screen, Y says no, and the app's screen comes back as it was (an app that doesn't redraw by
  // itself must not sit under the question)
  const asked = page.evaluate(() => window.vw.exec("import wedgie, slot, lcd\nwedgie.SEALED = True\nslot.stop()\nlcd._BUF[0] = 0x12\nlcd._BUF[1] = 0x34\nok = slot.let_in()\nimport ui\nprint('let in:', ok, lcd._BUF[0], lcd._BUF[1], 'kept', ui.kept)\nwedgie.SEALED = False"));
  await page.waitForTimeout(2500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-ask.png` });
  await page.evaluate(() => window.vw.press("Y", 150));
  const al = await asked;
  check(/let in: False 18 52/.test(al), `lock: Y says no, the app's screen comes back (${al.trim()})`);
  // the question goes straight to the panel (ui.ask keep=True): the frame buffer keeps the app's screen,
  // so nothing is saved to flash first (that took seconds on a real board before every question)
  check(/kept True/.test(al), `the question leaves the frame buffer alone (${al.trim()})`);

  // the look-and-feel kit (firmware/ui.py): a page, for code.md's pictures
  const pg = await page.evaluate(() => window.vw.exec("import slot, lcd, ui\nslot.stop()\nd = lcd.LCD()\nui.page(d, 'Game over', [('score 120', ui.INK), ('best 340', ui.MUTED)], 'A  play again')\nprint('page ok')"));
  await page.waitForTimeout(500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-ui-page.png` });
  check(/page ok/.test(pg), "ui.page draws");

  // an install's screen is the boot screen with the boot bar (loader.screen), not a bar of its own
  const pr = await page.evaluate(() => window.vw.exec("import slot\nslot.stop()\nslot._prog = None\nslot.progress('Installing Hello...', 'hello.py', 0.1)\nslot.progress('Installing Hello...', 'hello.py', 0.6)\nprint('bar:', bool(slot._prog[1]))"));
  await page.waitForTimeout(600);
  await page.locator(".vw").screenshot({ path: `${out}/emu-installing.png` });
  check(/bar: True/.test(pr), `install screen uses the boot bar (${pr.trim()})`);

  // the Wallet (no chip: software key) must not crash; it has USB to itself
  await page.evaluate(() => window.vw.reboot("usbwallet"));
  await page.waitForTimeout(3000);
  const wl = await page.evaluate(() => window.vw.exec("import slot; slot.app['mod'], slot.state, slot._own_usb()"));
  check(/usbwallet', 'running', True/.test(wl), `Wallet runs, USB its own (${wl.trim()})`);
  await page.locator(".vw").screenshot({ path: `${out}/emu-wallet.png` });

  // installs free the RAM an app left behind first (install.ts FREE_PY): only lcd stays, and code after it
  // imports what it needs
  const freePy = (await import("node:fs")).readFileSync(join(root, "src/serial/install.ts"), "utf8").match(/const FREE_PY = `([\s\S]*?)`;/)[1];
  const fr = await page.evaluate((code) => window.vw.exec(code + "\nimport sys, gc\nprint(sorted(k for k in sys.modules if k[0] != '_' and k != 'micropython'), len([k for k in globals() if not k.startswith('__')]))\nimport wedgie\nprint(wedgie.VERSION)"), freePy);
  check(/\['lcd', 'splash'\] 2\s+0\.[2-9]/.test(fr), `freeing RAM before an install: ${fr.trim().replace(/\n/g, " | ")}`);

  // Demo: an entry (demo.run) that owns the CPU. Frames must still reach the page, and X is its own
  // (the scene before), not a way out.
  await page.evaluate(() => window.vw.reboot("demo"));
  await page.waitForTimeout(2500);
  const fd = await page.evaluate(() => new Promise((res) => { let k = 0; const off = window.vw.onFrame(() => k++); setTimeout(() => { off(); res(k); }, 2000); }));
  console.log(`     fps while Demo (busy loop) runs: ${(fd / 2).toFixed(1)}`);
  check(fd > 4, "Demo (busy loop) keeps drawing");
  await page.evaluate(() => window.vw.press("X", 150));
  await page.waitForTimeout(800);
  const fx = await page.evaluate(() => new Promise((res) => { let k = 0; const off = window.vw.onFrame(() => k++); setTimeout(() => { off(); res(k); }, 1000); }));
  check(fx > 2 && !(await isBand()), "X in Demo: still Demo");
  await page.locator(".vw").screenshot({ path: `${out}/emu-demo.png` });

  await page.evaluate(() => window.vw.reboot("hello"));
  check(await waitFor(isHello, 15000), "reboot back into Hello");
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
  const fb = await p2.evaluate(() => window.vw.exec("import hello; hello.last"));
  check(/'A'/.test(fb), `fallback (postMessage keys): Hello saw A (${fb.trim()})`);
  await ctx2.close();
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
