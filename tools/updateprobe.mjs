// /update, the update bench, with four fake wedgies plugged in at once (tools/fakewedgies.mjs):
//  0 bare MicroPython: gets the core; its first boot adds the WEDGIE drive (the port drops, comes back)
//  1 wedgie 0.1.3 with an old Hello cart first: core updated; coming from the menu it starts with no
//    app, so the carts' files go (the person's own mine.py stays on the flash), and the menu; its port stays
//  2 wedgie 0.1.4 whose core files differ: updated
//  3 no MicroPython: told to go through /format
// Then 2 is unplugged and plugged back in: already up to date, nothing copied, no restart.
// Serve dist first (npx vite preview), then: node tools/updateprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(fakeWedgies, [
  { uid: "e66138935f5a2c29", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "boot.py": 1 } },
  { uid: "de6474e3a3152a2f", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "menu.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.1.3"',
    "apps.json": JSON.stringify([{ mod: "hello", name: "Hello" }, { mod: "keytest", name: "Buttons" }, { mod: "mine", name: "Mine", about: "yours" }]), "hello.py": 1, "keytest.py": 1, "mine.py": 1 } },
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "main.py": 1, "menu.py": 1, "wedgie.py": 'VERSION = "0.1.4"' } },
  { uid: "0badc0de00deadff", machine: "?", noMp: true },
]);

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const st = (i, k) => page.evaluate(([i, k]) => window.__ports[i]._st[k], [i, k]);
const card = (id) => page.evaluate((id) => { const c = [...document.querySelectorAll(".upd-card")].find((c) => c.querySelector(".idtag").textContent === id); return c ? c.className + " | " + c.textContent.replace(/\s+/g, " ").trim() : "(no card)"; }, id);
const wait = (fn, arg, ms, what) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => { console.log("STUCK:", what, "|", (await page.textContent("main")).replace(/\s+/g, " ").slice(0, 600)); bad++; return false; });

await page.goto(base + "/update");
await page.waitForFunction(() => !document.getElementById("wl"));
const settled = () => [...document.querySelectorAll(".upd-card")].length === 4 && ![...document.querySelectorAll(".upd-card")].some((c) => /updating|restarting|waiting/.test(c.className));
await wait(settled, null, 180000, "four cards, all settled");
for (const id of ["5A2C29", "152A2F", "3D9F01", "no ID"]) console.log("·", await card(id));
await page.screenshot({ path: `${out}/update-bench.png` });

check(/ done/.test(await card("5A2C29")) && /Updated ✓/.test(await card("5A2C29")), "bare board: updated, green");
check((await st(0, "drops")) === 1, "bare board: its port dropped at its first boot and it was found again by its ID");
check(/ done/.test(await card("152A2F")) && (await st(1, "drops")) === 1 && (await st(1, "resets")) === 1, "0.1.3: updated with one soft reset; its port dropped (the drive came off) and it was found again");
const f1 = await page.evaluate(() => { const f = window.__ports[1]._st.files; return { hello: f.has("hello.py"), keytest: f.has("keytest.py"), mine: f.has("mine.py"), menu: f.has("menu.py"), slot: f.has("slot.mpy"), apps: JSON.parse(new TextDecoder().decode(f.get("apps.json"))).map((a) => a.mod) }; });
check(JSON.stringify(f1.apps) === "[]" && !f1.hello && !f1.keytest && f1.mine && !f1.menu && f1.slot, "0.1.3 → 0.2: no app yet; the carts and the menu gone, the person's own file kept: " + JSON.stringify(f1));
check((await st(1, "inserting")) >= 2, "its own screen showed the update");
check(/ done/.test(await card("3D9F01")), "0.1.4 with different files: updated");
check(/ fail/.test(await card("no ID")) && /wedgie\.dev\/connect/.test(await card("no ID")), "no MicroPython: failed, pointed at /connect (its Set up card)");
check(/3 updated · 1 failed/.test(await page.textContent("#u-text")), "the headline: 3 updated · 1 failed");

// unplug the 0.1.4 one and plug it back in: already up to date, no copy, no restart
const resets = await st(2, "resets");
await page.evaluate(() => window.__plug(2, false));
await wait(() => document.querySelector('.upd-card[data-uid$="3d9f01"]')?.classList.contains("gone"), null, 5000, "card shows unplugged");
await page.evaluate(() => window.__plug(2, true));
await wait(() => document.querySelector('.upd-card[data-uid$="3d9f01"]')?.classList.contains("fresh"), null, 30000, "replugged: already up to date");
check((await st(2, "resets")) === resets, "replugged: no restart");
check(errs.length === 0, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await page.screenshot({ path: `${out}/update-bench-2.png` });
await browser.close();
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
