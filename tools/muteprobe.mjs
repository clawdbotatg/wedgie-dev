// A wedgie that stops answering never turns a checked job into the red FULL CONTROL question (audit 11-13,
// INST-18). An app that keeps quiet looked like "old firmware": Update then sent Ctrl-C, and a locked wedgie
// answers Ctrl-C with FULL CONTROL, right after its person clicked Update. Now: no answer = an error, no Ctrl-C.
// A bare MicroPython board (its REPL already open, nothing to lock) still gets its firmware.
// Serve dist first (npx vite preview), then: node tools/muteprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + (process.platform === "darwin" ? "/Library/Caches/ms-playwright" : "/.cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const man = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8"));
let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const open = async (spec, path) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(fakeWedgies, [spec]);
  if (!man.signed) await ctx.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  await page.goto(base + path);
  await page.waitForFunction(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, { timeout: 40000 });
  return page;
};
const st = (page) => page.evaluate(() => { const s = window.__ports[0]._st; return { ctrlc: s.sealedBytes || 0, asks: s.asks || 0, stops: s.interrupts || 0, files: [...s.files.keys()] }; });
const text = (page) => page.evaluate(() => (document.querySelector("#d-status")?.textContent || document.querySelector("main").textContent).replace(/\s+/g, " "));

// 1. a locked wedgie on older firmware whose app goes quiet as Update is clicked
const old = { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico 2 W with RP2350", chip: "none", person: { say: "yes", ms: 300 },
  files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.64"', "apps.json": JSON.stringify([{ mod: "buttons", name: "Buttons" }]), "buttons.py": 1 } };
let page = await open(old, "/connect/3D9F01");
await page.evaluate(() => { window.__ports[0]._st.mute = true; });
await page.click("[data-fw]");
const failed = await page.waitForFunction(() => /Update failed/.test(document.querySelector("main").textContent), null, { timeout: 60000 }).then(() => true, () => false);
let s = await st(page);
check(failed, `a quiet wedgie: Update fails with a message (${(await text(page)).match(/Update failed[^.]*\.[^.]*\./)?.[0] || "none"})`);
check(s.ctrlc === 0, `it was sent no Ctrl-C: no FULL CONTROL question (${s.ctrlc} sent)`);
check(s.asks === 0 && s.stops === 0, "nothing asked on its screen, its app not stopped");
check(s.files.includes("buttons.py") && !s.files.some((n) => /^slot\.mpy$/.test(n)), "no file written");
// it answers again: the same button updates it, through its checked question
await page.evaluate(() => { window.__ports[0]._st.mute = false; });
await page.waitForFunction(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, { timeout: 40000 }).catch(() => {});
await page.click("[data-fw]");
const done = await page.waitForFunction(() => /Up to date/.test(document.querySelector("#d-fw")?.textContent || ""), null, { timeout: 120000 }).then(() => true, () => false);
s = await st(page);
check(done && s.ctrlc === 0, `answering again: updated by a checked job, still no Ctrl-C (${s.ctrlc}${done ? "" : "; " + (await text(page)).slice(0, 300)})`);
await page.context().close();

// 2. a bare MicroPython board: nothing to lock, it still gets firmware
page = await open({ uid: "de6474e3a3152a2f", machine: "Raspberry Pi Pico with RP2040", files: {}, chip: "none" }, "/connect/152A2F");
await page.click("[data-fw]");
const bare = await page.waitForFunction(() => /Up to date/.test(document.querySelector("#d-fw")?.textContent || ""), null, { timeout: 120000 }).then(() => true, () => false);
check(bare, `a bare MicroPython board still gets its firmware (${bare ? "installed" : (await text(page)).slice(0, 120)})`);

await browser.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
