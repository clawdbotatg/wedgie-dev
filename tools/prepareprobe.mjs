// /prepare with fake wedgies (tools/fakewedgies.mjs). Their chip is an ATECC608, so the last step fails
// ("not a Trust M"): this checks the software half. 0: wedgie 0.3.20 with Buttons: its firmware update
// (the old kind: its app comes along), then "Install Welcome", back on the latest with Welcome only.
// 1: no MicroPython: told to use /test. 2: 0.3.53 with old firmware files and Buttons: the firmware through
// full access (before 0.3.55 it knows only the old release key), then "Install Welcome" (replaces Buttons).
// Every job sent is written to shots/sitejobs-prepare.json for tools/test_sitejobs.py (the real rules).
// Serve dist first (npx vite preview), then: node tools/prepareprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.20"',
    "apps.json": JSON.stringify([{ mod: "buttons", name: "Buttons" }]), "buttons.py": 1 } },
  { uid: "0badc0de00deadff", machine: "?", noMp: true },
  { uid: "cafe0053cafe0053", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.53"',
    "apps.json": JSON.stringify([{ mod: "buttons", name: "Buttons" }]), "buttons.py": 1 } },
]);
let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const card = (id) => page.evaluate((id) => { const c = [...document.querySelectorAll(".upd-card")].find((c) => c.querySelector(".idtag").textContent === id); return c ? c.className + " | " + c.textContent.replace(/\s+/g, " ").trim() : "(no card)"; }, id);
await page.goto(base + "/prepare");
await page.click("#p-go");
await page.waitForFunction(() => document.querySelectorAll(".upd-card").length === 3 && ![...document.querySelectorAll(".upd-card")].some((c) => /checking|installing|restarting/.test(c.className)), null, { timeout: 120000 }).catch(() => {});
const a = await card("3D9F01"), b = await card("no ID");
console.log("·", a); console.log("·", b);
const f = await page.evaluate(() => { const s = window.__ports[0]._st; return { asks: s.asks, apps: JSON.parse(new TextDecoder().decode(s.files.get("apps.json"))).map((x) => x.mod), buttons: s.files.has("buttons.py"), welcome: s.files.has("welcome.py"), chips: s.chips }; });
console.log("·", JSON.stringify(f));
check(f.asks === 2 && f.welcome && !f.buttons && JSON.stringify(f.apps) === '["welcome"]', "0.3.20 + Buttons: its update, then Install Welcome: now Welcome only");
check(/ fail/.test(a) && /not a Trust M/.test(a) && /every file checked/.test(a), "after the update every file checked; its ATECC608 fails the Trust M step");
check(/ fail/.test(b) && /\/test|MicroPython/i.test(b), "no MicroPython: not ready");
const c = await card("FE0053");
console.log("·", c);
const g = await page.evaluate(() => { const s = window.__ports[2]._st; return { asks: s.asks, apps: JSON.parse(new TextDecoder().decode(s.files.get("apps.json"))).map((x) => x.mod), buttons: s.files.has("buttons.py"), welcome: s.files.has("welcome.py"),
  jobs: s.jobLog.map((j) => j.msg.job + " w" + j.msg.write.length + " d" + j.msg.delete.length) }; });
console.log("·", JSON.stringify(g));
check(g.asks === 2 && JSON.stringify(g.jobs) === '["Install Welcome w1 d1"]' && g.welcome && !g.buttons && JSON.stringify(g.apps) === '["welcome"]',
  "0.3.53: two questions, the firmware through full access (it can't check the new release keys), then Welcome (Buttons off)");
check(/ fail/.test(c) && /not a Trust M/.test(c), "0.3.53: then the chip step (an ATECC608 here)");
writeFileSync(new URL("../shots/sitejobs-prepare.json", import.meta.url), JSON.stringify(await page.evaluate(() => window.__ports.flatMap((p) => p._st.jobLog || []))));
check(!errs.length, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
