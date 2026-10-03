// The wedgie's screen while a computer works on it (docs/STYLE.md, "Busy"): every full-access job on
// /connect shows the boot screen and the boot bar, titled with what it's doing, the step under it, the bar
// filling to the end. Fake wedgies (tools/fakewedgies.mjs) keep every _ins(title, what, p) the page draws.
//  0 wedgie 0.1.3 (no checked installs): Update firmware, the case that showed "working..." (2026-10-03)
//  1 wedgie 0.3.11, sealed, the last version a site installs on through full access (checked installs need
//    0.3.12+; Buttons needs 0.3.5+): install Buttons, upload a file, put saves back
// Serve dist first (npx vite preview), then: node tools/busyprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(fakeWedgies, [
  { uid: "de6474e3a3152a2f", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "menu.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.1.3"',
    "apps.json": JSON.stringify([{ mod: "buttons", name: "Buttons" }]), "buttons.py": 1 }, chip: "none" },
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.11"',
    "apps.json": "[]" }, chip: "none", person: { say: "yes", ms: 300 } },
]);
const man = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8"));
if (!man.signed) await ctx.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
page.setDefaultTimeout(90000);          // software 3D on a busy box: a tap can wait for the page
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const wait = (fn, arg, ms, what) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => { console.log("STUCK:", what, "|", (await page.textContent("main").catch(() => "")).replace(/\s+/g, " ").slice(0, 400)); bad++; return false; });
const screens = (i) => page.evaluate((i) => window.__ports[i]._st.screens || [], i);
const fills = (s) => s.length >= 2 && s.some((x) => x.p === 1) && s.every((x, i) => !i || x.p >= s[i - 1].p);
const says = (s) => [...new Set(s.map((x) => x.title))].join(", ");

// 0: the firmware update over full access, the case that showed "working..."
await page.goto(base + "/connect/152A2F");
await wait(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, 30000, "0.1.3: Update enabled");
await page.click("[data-fw]");
await wait(() => /Up to date/.test(document.querySelector("#d-fw")?.textContent || ""), null, 120000, "0.1.3 updated");
let s = await screens(0);
check(s.length >= 5 && s.every((x) => x.title === "Updating firmware") && fills(s) && s.some((x) => x.what === "slot.mpy"),
  `update: the boot bar the whole time, 'Updating firmware', each file under it, filled (${s.length} draws: ${says(s)})`);

// 1: an app, a file, saves, each over full access (0.3.11 gets no checked installs: install.ts checkedHave)
await page.goto(base + "/connect/3D9F01");
await wait(() => document.querySelector('#d-shelf .cart-slot[data-mod="buttons"] .cart:not(:disabled)'), null, 30000, "0.3.11: the shelf");
await page.click('#d-shelf .cart-slot[data-mod="buttons"] .cart');
await wait(() => window.__ports[1]._st.files.has("buttons.py") && /buttons/.test(new TextDecoder().decode(window.__ports[1]._st.files.get("apps.json"))), null, 60000, "Buttons on it");
s = (await screens(1)).filter((x) => x.title === "Installing Buttons");
check(fills(s) && s.some((x) => x.what === "buttons.py"), `install: 'Installing Buttons', buttons.py under it, filled (${s.length} draws)`);
// its restart into Buttons: wait until the page has it again and is idle (a Refresh tapped while its port is
// down lists nothing)
await wait(() => document.querySelector('#d-shelf .cart-slot[data-mod="buttons"] .cart.playing:not(:disabled)') && document.querySelector("#d-missing")?.hidden, null, 60000, "Buttons running, the page has it again");

await page.click("details.dev > summary");     // the folded Developer section
await wait(() => !document.querySelector('[data-fs="refresh"]')?.disabled, null, 30000, "Developer files ready");
await page.click('[data-fs="refresh"]');
await wait(() => document.querySelector('[data-fs-open="/main.py"]'), null, 30000, "file list");
await page.setInputFiles("#d-fs-in", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi from the page") });
await wait(() => window.__ports[1]._st.files.has("/notes.txt"), null, 30000, "a file uploaded");
s = (await screens(1)).filter((x) => x.title === "Uploading");
check(fills(s) && s.some((x) => x.what === "notes.txt"), `upload: 'Uploading', notes.txt under it, filled (${s.length} draws)`);

const dir = mkdtempSync(join(tmpdir(), "busyprobe-")), bundle = join(dir, "saves.json");
writeFileSync(bundle, JSON.stringify({ "wedgie-saves": 1, files: { "/saves/buttons/best.json": Buffer.from('{"score": 120}').toString("base64") } }));
// The page can lose a wedgie after its port drops (a fake shows "isn't plugged in" after the install's
// reset, on main before this probe too): open its page fresh, as a person would.
await page.goto(base + "/connect/3D9F01");
await wait(() => document.querySelector("#d-missing")?.hidden && document.querySelector("#d-saves-in"), null, 60000, "its page again");
await page.setInputFiles("#d-saves-in", bundle);
await wait(() => window.__ports[1]._st.files.has("/saves/buttons/best.json"), null, 60000, "saves put back");
s = (await screens(1)).filter((x) => x.title === "Putting saves back");
check(fills(s) && s.some((x) => x.what === "saves/buttons/best.json"), `saves: 'Putting saves back', the file under it, filled (${s.length} draws)`);

const all = [...await screens(0), ...await screens(1)];
const loud = all.filter((x) => /\bworking\b|\bloading\b|\.\.\./i.test(x.title + " " + x.what));
check(!loud.length, "never 'working', 'loading' or '...' on its screen");
check(errs.length === 0, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
