// The virtual wedgie end to end in headless Chromium: builds the site with its test page
// (WEDGIE_EMU_TEST=1, into node_modules/.cache/emutest), serves it with `vite preview` (which sends
// COOP/COEP), mounts the device and checks it boots straight into its one app (Buttons, a loop that owns
// the worker) and that X is the app's own button; then Hello (tools/fixtures/hello.py, booted as a repo
// app: a Timer app, so the REPL stays free) for the rest: saves (save.py) round-trip in the app's own
// folder; the USB hello says the slot runs it; then no app (the "no software yet" screen), and the
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
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
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
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
  // Buttons: white, its N box green (the first one to push).
  const isButtons = async () => near(await px(70, 104), [34, 196, 82]);
  // hello.py (tools/fixtures): black screen, a DARK title bar, "hello pico" in yellow.
  const HELLO = (await import("node:fs")).readFileSync(join(root, "tools/fixtures/hello.py"), "utf8");
  const bootHello = () => page.evaluate((src) => window.vw.reboot("hello", { app: { mod: "hello", name: "Hello" }, files: { "hello.py": new TextEncoder().encode(src) } }), HELLO);
  const isHello = async () => near(await px(120, 100), [0, 0, 0], 8) || near(await px(3, 60), [0, 0, 0], 8);

  check(await waitFor(isButtons, 15000), `boots straight into Buttons, no menu (${Date.now() - t0} ms after navigation)`);
  const f0 = await page.evaluate(() => new Promise((res) => { let n = 0; const off = window.vw.onFrame(() => n++); setTimeout(() => { off(); res(n); }, 2000); }));
  console.log(`     fps while Buttons runs: ${(f0 / 2).toFixed(1)} (frames drawn on the page per second)`);
  await page.locator(".vw").screenshot({ path: `${out}/emu-buttons-device.png` });
  // keyboard path: focus the device, press B (the K key) with the real keyboard; Buttons flashes B red
  await page.locator(".vw").focus();
  await page.keyboard.down("k"); await page.waitForTimeout(100); await page.keyboard.up("k");
  await page.waitForTimeout(200);
  await page.locator(".vw").screenshot({ path: `${out}/emu-buttons-keyB.png` });
  // pointer path: click the drawn X button. X is the app's own button: it keeps running.
  const box = await page.locator('.vw [data-k="X"] .cap').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(600);
  check(await waitFor(isButtons, 3000), "X doesn't leave the app");
  const fb0 = await page.evaluate(() => new Promise((res) => { let k = 0; const off = window.vw.onFrame(() => k++); setTimeout(() => { off(); res(k); }, 1000); }));
  check(fb0 > 2, `Buttons (a loop that owns the worker) keeps drawing (${fb0} frames in 1 s)`);

  await bootHello();
  check(await waitFor(isHello, 15000), "Hello (a repo app) boots");
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
  await page.evaluate(() => window.vw.reboot("", null));
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

  // the lock (main.py seals a real board; here it's switched on by hand): "let this computer in?" is on
  // the screen at once (nothing is saved first: 0.3.5 wrote the 115 KB screen to flash, seconds on a real
  // board), and Y says no
  const asked = page.evaluate(() => window.vw.exec("import wedgie, slot, ui, time\nwedgie.SEALED = True\nslot.stop()\n_t0 = time.ticks_ms()\n_ask = ui.ask\ndef _timed(*a, **k):\n    print('asked after', time.ticks_diff(time.ticks_ms(), _t0), 'ms')\n    return _ask(*a, **k)\nui.ask = _timed\nok = slot.let_in()\nui.ask = _ask\nprint('let in:', ok)\nwedgie.SEALED = False"));
  await page.waitForTimeout(2500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-ask.png` });
  await page.evaluate(() => window.vw.press("Y", 150));
  const al = await asked;
  const askMs = +(al.match(/asked after (\d+)/) || [])[1];
  check(/let in: False/.test(al) && askMs < 30, `lock: the question is up at once (${askMs} ms), Y says no (${al.trim().replace(/\n/g, " | ")})`);

  // a no over USB answers "refused", then the wedgie starts again from the top (the question drew over
  // the app's screen and nothing kept it)
  await page.evaluate(() => window.vw.exec("import wedgie\nwedgie.SEALED = True"));
  const no = page.evaluate(() => new Promise((res) => { const got = []; const off = window.vw.onOutput((l) => { if (/"refused"|"ready"/.test(l)) got.push(l.includes("refused") ? "refused" : "ready"); if (got.length >= 2) { off(); res(got); } }); window.vw.write(JSON.stringify({ id: 60, type: "open", for: "Install Buttons" }) + "\n"); setTimeout(() => { off(); res(got); }, 12000); }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.vw.press("Y", 150));
  const nog = await no;
  check(nog.join(" ") === "refused ready", `USB open + Y: refused, then it restarts (${nog.join(" ")})`);
  await page.waitForTimeout(3000);

  // a yes to "let this computer in" (docs/STYLE.md, busy = the boot loader): the boot screen, titled with
  // the job as doing ("Installing Buttons"), the bar drawn empty, and no bar kept (its 9 KB) while the app
  // is still loaded; the computer's own code fills it once it has freed the app (files.ts busy)
  const bb = (await import("node:fs")).readFileSync(join(root, "firmware/bar.bin"));
  const [BX, BY, BW, BH, , , , , BL] = Array.from({ length: 12 }, (_, i) => bb.readUInt16BE(i * 2));
  const m565 = bb.readUInt16BE(24 + BH * BL * 2 + (BH >> 1) * 2);
  const track = [(m565 >> 11) * 255 / 31, ((m565 >> 5) & 63) * 255 / 63, (m565 & 31) * 255 / 31].map(Math.round);
  await page.evaluate(() => window.vw.exec("import wedgie\nwedgie.SEALED = True\nwedgie._open = False"));
  const yes = page.evaluate(() => new Promise((res) => { const off = window.vw.onOutput((l) => { if (/"id": ?62/.test(l)) { off(); res(l); } }); window.vw.write(JSON.stringify({ id: 62, type: "open", for: "Install Buttons" }) + "\n"); setTimeout(() => { off(); res(""); }, 12000); }));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.vw.press("A", 150));
  const yl = await yes;
  await page.waitForTimeout(500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-let-in.png` });
  const mid = await px(BX + (BW >> 1), BY + (BH >> 1));
  await page.evaluate(() => window.vw.exec("import wedgie\nwedgie._open = False\nwedgie.SEALED = False"));
  check(/"type": ?"open"/.test(yl) && near(mid, track), `USB open + A: the boot screen, the bar drawn empty (${mid} ~ ${track}; its RAM: chipprobe, the emulator can't measure it)`);
  await bootHello();
  await page.waitForTimeout(3000);

  // the escape hatch ({"type":"open","full":true}): the white-on-red question, and A gives full control
  // (Ctrl-C on: the same yes as any other)
  // (the yes stops the app as Ctrl-C would: slot._drop. The emulator's slot runs on a Timer, not main.py's
  // loop, so that raise is held while this runs: slot.step is wrapped.)
  await page.evaluate(() => window.vw.exec("import wedgie, slot\nwedgie.SEALED = True\nwedgie._open = False\n_step0 = slot.step\ndef _held0(b=True):\n    if not slot._kbd:\n        _step0(b)\nslot.step = _held0"));
  const full = page.evaluate(() => new Promise((res) => { const off = window.vw.onOutput((l) => { if (/"id": ?61/.test(l)) { off(); res(l); } }); window.vw.write(JSON.stringify({ id: 61, type: "open", full: true }) + "\n"); setTimeout(() => { off(); res(""); }, 12000); }));
  await page.waitForTimeout(1500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-full.png` });
  const red = await px(3, 120);
  await page.evaluate(() => window.vw.press("A", 150));
  const fy = await full;
  await page.waitForTimeout(500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-full-yes.png` });
  const fo = await page.evaluate(() => window.vw.exec("import wedgie, slot\nprint('open:', wedgie.is_open(), 'stops:', slot._kbd)\nslot._kbd = False\nslot.step = _step0\nwedgie._open = False\nwedgie.SEALED = False"));
  check(near(red, [227, 49, 44]), `full control: the question is red (${red})`);
  check(/"type": ?"open"/.test(fy) && /open: True stops: True/.test(fo), `full control + A: open, the app stops (${fy.trim()} | ${fo.trim()})`);

  // Ctrl-C on a locked wedgie (a plain byte there: main.py turns it off) asks the same red question
  // (hatch.py): A lets it in and the app stops as Ctrl-C would. One right after the slot starts is a
  // host's leftover and asks nothing. (The emulator's slot runs on a Timer, not main.py's loop, so the
  // raise that would stop the app there is held while this runs: slot.step is wrapped.)
  await page.evaluate(() => window.vw.exec("import slot\n_step = slot.step\ndef _held(b=True):\n    if not slot._kbd:\n        _step(b)\nslot.step = _held"));
  const cc = (early) => page.evaluate((early) => window.vw.exec("import micropython, wedgie, slot, time\nmicropython.kbd_intr(-1)\nwedgie.SEALED = True\nwedgie._open = False\nslot._kbd = False\nslot._started = time.ticks_ms() - (0 if " + (early ? "True" : "False") + " else 5000)\nprint('armed')"), early);
  await cc(true);
  await page.evaluate(() => window.vw.write("\r\x03\x03"));
  await page.waitForTimeout(1200);
  const early = await px(3, 120);
  await cc(false);
  await page.evaluate(() => window.vw.write("\r\x03\x03"));
  await page.waitForTimeout(1500);
  const ccRed = await px(3, 120);
  await page.locator(".vw").screenshot({ path: `${out}/emu-ctrlc.png` });
  await page.evaluate(() => window.vw.press("A", 150));
  await page.waitForTimeout(800);
  const cco = await page.evaluate(() => window.vw.exec("import wedgie, slot, micropython\nprint('open:', wedgie.is_open(), 'kbd:', slot._kbd)\nslot._kbd = False\nslot.step = _step\nwedgie._open = False\nwedgie.SEALED = False\nmicropython.kbd_intr(3)"));
  check(!near(early, [227, 49, 44]), `Ctrl-C right after the slot starts asks nothing (${early})`);
  check(near(ccRed, [227, 49, 44]), `Ctrl-C on a locked wedgie: the red question (${ccRed})`);
  check(/open: True kbd: True/.test(cco), `Ctrl-C + A: let in, the app stops as Ctrl-C would (${cco.trim()})`);
  await page.waitForTimeout(500);

  // locked, no yes: live get / rm reach saves only (deleting main.py, the file that locks it, would make the
  // next boot an open REPL; reading any file could read a key)
  await page.evaluate(() => window.vw.exec("import wedgie\nwedgie.SEALED = True\nwedgie._open = False"));
  const lget = await ask({ id: 62, type: "get", path: "/main.py" });
  const lrm = await ask({ id: 63, type: "rm", path: "main.py" });
  const ldot = await ask({ id: 64, type: "rm", path: "/saves/../main.py" });
  const lsv = await ask({ id: 65, type: "ls", path: "/" });
  await page.evaluate(() => window.vw.exec("import wedgie\nwedgie.SEALED = False"));
  check([lget, lrm, ldot].every((v) => v[0]?.type === "error") && lsv[0]?.files.some(([p]) => p === "/main.py"), `locked: get / rm outside /saves/ refused, main.py still there (${[lget, lrm, ldot].map((v) => v[0]?.type).join(" ")})`);

  // a request that blows up while it's decoded (too deep: MemoryError / RecursionError on a board) is
  // dropped; the slot goes on answering
  await page.evaluate(() => window.vw.write('{"id": 66, "a": ' + "[".repeat(2900) + "]".repeat(2900) + "}\n"));
  await page.waitForTimeout(500);
  const deepHello = await ask({ id: 67, type: "hello" });
  check(deepHello[0]?.type === "hello", `a request too deep to decode is dropped, hello still answers (${deepHello[0]?.type})`);

  // the look-and-feel kit (firmware/ui.py): a page, for code.md's pictures
  const pg = await page.evaluate(() => window.vw.exec("import slot, lcd, ui\nslot.stop()\nd = lcd.LCD()\nui.page(d, 'Game over', [('score 120', ui.INK), ('best 340', ui.MUTED)], 'A  play again')\nprint('page ok')"));
  await page.waitForTimeout(500);
  await page.locator(".vw").screenshot({ path: `${out}/emu-ui-page.png` });
  check(/page ok/.test(pg), "ui.page draws");

  // an install's screen is the boot screen with the boot bar (loader.screen), not a bar of its own
  const pr = await page.evaluate(() => window.vw.exec("import slot, job\nslot.stop()\njob._prog = None\njob.progress('Installing Hello...', 'hello.py', 0.1)\njob.progress('Installing Hello...', 'hello.py', 0.6)\nprint('bar:', bool(job._prog[1]))"));
  await page.waitForTimeout(600);
  await page.locator(".vw").screenshot({ path: `${out}/emu-installing.png` });
  check(/bar: True/.test(pr), `install screen uses the boot bar (${pr.trim()})`);

  // a checked install through the real firmware (job.py, 0.3.10+): the job carries no release, so the
  // question is up at once; after A: the signed list (real signature), sums, the file, commit, restart
  await bootHello();
  await page.waitForTimeout(3000);
  const req = (msg, ms = 10000) => page.evaluate(([msg, ms]) => new Promise((res) => { const off = window.vw.onOutput((l) => { if (l.includes(`"id": ${msg.id},`) || l.includes(`"id": ${msg.id}}`)) { off(); res(JSON.parse(l)); } }); window.vw.write(JSON.stringify(msg) + "\n"); setTimeout(() => { off(); res(null); }, ms); }), [msg, ms]);
  // the update question: few words, big (the job, its version, a green check; Austin, 2026-10-09)
  const upd = page.evaluate(() => window.vw.exec("import slot; slot.ask('Update firmware to 0.3.30', True, '0.3.30')"));
  await page.waitForTimeout(800);
  await page.locator(".vw").screenshot({ path: `${out}/emu-update-ask.png` });
  await page.evaluate(() => window.vw.press("Y", 150));
  check((await upd).trim() === "False", "the update question: Y says no");
  await page.evaluate(() => window.vw.exec("import slot, sys\n_a = slot.ask\ndef _ask2(*a, **k):\n    print('@asked', 'job' in sys.modules)\n    return _a(*a, **k)\nslot.ask = _ask2"));
  const exi = await req({ id: 69, type: "sums", names: [], exists: ["hello.py", "buttons.py", "nope.py"] });
  check(exi?.sums?.["hello.py"] === 1 && exi.sums["nope.py"] === null && exi.apps?.[0]?.mod === "hello", `sums (exists only) before the question: ${JSON.stringify(exi?.sums)}`);
  const rel = await page.evaluate(() => Promise.all(["release.txt", "release.sig", "buttons.py"].map((n) => fetch("/fw/" + n).then((r) => r.text()))));
  const ver = rel[0].split("\n")[1].slice(8);
  const asking = page.evaluate(() => new Promise((res) => { const t0 = performance.now(); const off = window.vw.onOutput((l) => { if (l.includes("@asked")) { off(); res([performance.now() - t0, l]); } }); setTimeout(() => { off(); res([-1, ""]); }, 10000); }));
  // the title is the signed app's name (job.py check); a list from before 0.3.12 names no apps, so no apps then
  const go = req({ id: 70, type: "job", job: "Install Buttons", version: ver, write: ["buttons.py"], delete: ["hello.py"], apps: /^@app {2}/m.test(rel[0]) ? JSON.stringify([{ mod: "buttons", v: "x" }]) : null }, 30000);
  const [askedMs, askedLine] = await asking;
  await page.waitForTimeout(800);
  await page.locator(".vw").screenshot({ path: `${out}/emu-job-ask.png` });
  await page.evaluate(() => window.vw.press("A", 150));
  const g = await go;
  check(askedMs >= 0 && askedMs < 300 && g?.type === "go", `job: the question is up ${Math.round(askedMs)} ms after the job arrives, A says go (${JSON.stringify(g)})`);
  check(typeof g?.asked_ms === "number" && g.asked_ms < 200, `job: the wedgie says how long its question took (${g?.asked_ms} ms)`);
  check(/@asked False/.test(askedLine), `job: asked before job.py was even loaded (${askedLine.trim()})`);
  const rok = await req({ id: 71, type: "release", release: rel[0], sig: rel[1].trim() }, 120000);
  check(rok?.type === "ok" && rok.version === ver, `job: the signed list checks out after the yes (${JSON.stringify(rok)})`);
  const sm = await req({ id: 72, type: "sums", names: ["buttons.py"] });
  check(sm?.type === "sums" && "buttons.py" in sm.sums, `job: sums after the yes (${JSON.stringify(sm?.sums)})`);
  const bytes = new TextEncoder().encode(rel[2]);
  let put = null;
  for (let o = 0, i = 0; o < bytes.length; o += 1024, i++) {
    put = await req({ id: 73 + i, type: "put", name: "buttons.py", data: Buffer.from(bytes.subarray(o, o + 1024)).toString("base64"), end: o + 1024 >= bytes.length });
    if (put?.type !== "ok") break;
  }
  check(put?.type === "ok", `job: buttons.py sent (${JSON.stringify(put)})`);
  const back = page.evaluate(() => new Promise((res) => { const all = []; const off = window.vw.onOutput((l) => { all.push(l); if (l.includes('"ready"')) { off(); res(l); } }); setTimeout(() => { off(); res("no ready: " + all.join(" / ").slice(0, 600)); }, 20000); }));
  const done = await req({ id: 90, type: "commit" });
  const ready = await back;
  check(done?.type === "done" && /"type": "ready"/.test(ready), `job: commit, then it restarts (the emulator boots fresh files) (${JSON.stringify(done)})`);

  // a no to a job: refused, then it starts again from the top
  await page.waitForTimeout(2000);
  const nob = page.evaluate(() => new Promise((res) => { const got = []; const off = window.vw.onOutput((l) => { if (/"refused"|"ready"/.test(l)) got.push(l.includes("refused") ? "refused" : "ready"); if (got.length >= 2) { off(); res(got); } }); setTimeout(() => { off(); res(got); }, 15000); }));
  await page.evaluate(() => window.vw.write(JSON.stringify({ id: 91, type: "job", job: "Install Hello", version: "x", write: ["hello.py"], delete: [], apps: null }) + "\n"));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.vw.press("Y", 150));
  const nj = await nob;
  check(nj.join(" ") === "refused ready", `job + Y: refused, then it restarts (${nj.join(" ")})`);
  await page.waitForTimeout(2000);

  // installs free the RAM an app left behind first (install.ts FREE_PY): only lcd stays, and code after it
  // imports what it needs
  const freePy = (await import("node:fs")).readFileSync(join(root, "src/serial/install.ts"), "utf8").match(/const FREE_PY = `([\s\S]*?)`;/)[1];
  const fr = await page.evaluate((code) => window.vw.exec(code + "\nimport sys, gc\nprint(sorted(k for k in sys.modules if k[0] != '_' and k != 'micropython'), len([k for k in globals() if not k.startswith('__')]))\nimport wedgie\nprint(wedgie.VERSION)"), freePy);
  check(/\['lcd', 'splash'\] 2\s+0\.[2-9]/.test(fr), `freeing RAM before an install: ${fr.trim().replace(/\n/g, " | ")}`);

  // Buttons: an entry (buttons.run) that owns the CPU. Frames must still reach the page, and X is its
  // own button, not a way out.
  await page.evaluate(() => window.vw.reboot("buttons", null));
  await page.waitForTimeout(2500);
  const fd = await page.evaluate(() => new Promise((res) => { let k = 0; const off = window.vw.onFrame(() => k++); setTimeout(() => { off(); res(k); }, 2000); }));
  console.log(`     fps while Buttons (busy loop) runs: ${(fd / 2).toFixed(1)}`);
  check(fd > 4, "Buttons (busy loop) keeps drawing");
  await page.evaluate(() => window.vw.press("X", 150));
  await page.waitForTimeout(800);
  check(await waitFor(isButtons, 3000), "X in Buttons: still Buttons");
  await page.locator(".vw").screenshot({ path: `${out}/emu-buttons.png` });

  await bootHello();
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
  const H2 = HELLO;
  await p2.evaluate((src) => window.vw.reboot("hello", { app: { mod: "hello", name: "Hello" }, files: { "hello.py": new TextEncoder().encode(src) } }), H2);
  await p2.waitForTimeout(1500);
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
