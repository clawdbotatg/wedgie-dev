// /prepare with fake wedgies (tools/fakewedgies.mjs). Their chip is an ATECC608, so the last step fails
// ("not a Trust M"): this checks the software half. 0: wedgie 0.3.20 with Buttons: one update (one
// question), back on the latest with Welcome only, then the chip. 1: no MicroPython: told to use /test.
// Serve dist first (npx vite preview), then: node tools/prepareprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
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
]);
let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const card = (id) => page.evaluate((id) => { const c = [...document.querySelectorAll(".upd-card")].find((c) => c.querySelector(".idtag").textContent === id); return c ? c.className + " | " + c.textContent.replace(/\s+/g, " ").trim() : "(no card)"; }, id);
await page.goto(base + "/prepare");
await page.waitForFunction(() => document.querySelectorAll(".upd-card").length === 2 && ![...document.querySelectorAll(".upd-card")].some((c) => /checking|installing|restarting/.test(c.className)), null, { timeout: 120000 }).catch(() => {});
const a = await card("3D9F01"), b = await card("no ID");
console.log("·", a); console.log("·", b);
const f = await page.evaluate(() => { const s = window.__ports[0]._st; return { asks: s.asks, apps: JSON.parse(new TextDecoder().decode(s.files.get("apps.json"))).map((x) => x.mod), buttons: s.files.has("buttons.py"), welcome: s.files.has("welcome.py"), chips: s.chips }; });
console.log("·", JSON.stringify(f));
check(f.asks === 1 && f.welcome && !f.buttons && JSON.stringify(f.apps) === '["welcome"]', "0.3.20 + Buttons: one question, now Welcome only");
check(/ fail/.test(a) && /not a Trust M/.test(a) && /every file checked/.test(a), "after the update every file checked; its ATECC608 fails the Trust M step");
check(/ fail/.test(b) && /\/test|MicroPython/i.test(b), "no MicroPython: not ready");
check(!errs.length, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
