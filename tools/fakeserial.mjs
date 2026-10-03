// Drives /connect with fake WebSerial boards so the USB paths run without hardware. Real clicks.
//  - a bare MicroPython board (raw REPL; a little filesystem, so the installer's hash / write / verify /
//    rename steps really run), which becomes a wedgie 0.2 after a firmware install;
//  - a wedgie on 0.1.3 (the menu, two apps); its update takes both apps and the menu off: no app yet;
//  - a wedgie on 0.2 with no app yet and a save: picks an app, switches, takes it off; its saves are
//    listed, downloaded, deleted and put back; the Developer file list shows, opens, deletes, uploads.
//    It is sealed (0.2.5+): every job that needs its REPL asks its pretend person (the page says to
//    press A; a yes is for that job only), and a no changes nothing.
// Soft resets drop the port only where boot.py would add the WEDGIE drive (st.mark below): the bare board's
// first boot on the new firmware does, the others don't. The page must find it again either way.
// Serve dist first (npx vite preview), then: node tools/fakeserial.mjs [url] [outdir] [phone]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";
const CUR = readFileSync(new URL("../firmware/wedgie.py", import.meta.url), "utf8").match(/VERSION = "([^"]+)"/)[1];   // the fake that is up to date

const base = (process.argv[2] || "http://localhost:4173").replace(/\/connect\/?$/, "").replace(/\/$/, "");
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
// "phone" as a third argument: the same run at iPhone width (the screenshots are what to look at)
const phone = process.argv[4] === "phone";
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(fakeWedgies, [
  { uid: "e66138935f5a2c29", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "boot.py": 1 } },
  { uid: "de6474e3a3152a2f", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "menu.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.1.3"',
    "apps.json": JSON.stringify([{ mod: "hello", name: "Hello" }, { mod: "keytest", name: "Buttons" }]), "hello.py": 1, "keytest.py": 1 }, chip: "none" },
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico 2 W with RP2350", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": `VERSION = "${CUR}"`,
    "apps.json": "[]", "/saves/hello/best.json": '{"score": 120}', "junk.txt": "delete me" }, person: { say: "yes", ms: 5000 } },
]);

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
// Unsigned firmware (a release not signed yet: tools/sign.mjs, on Austin's Mac): the site would skip the
// checked install. The fakes don't check signatures, so serve it as signed to test the release's own flow.
const man = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8"));
if (!man.signed) {
  console.log("· the manifest is unsigned: serving it as signed (the fakes don't check the signature)");
  await ctx.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));
  await ctx.route("**/fw/release.txt", (r) => r.fulfill({ contentType: "text/plain", body: `wedgie-release 1\nversion ${man.version}\n` + [...man.files].sort((a, b) => a.name < b.name ? -1 : 1).map((f) => `${f.sha256}  ${f.name}\n`).join("") }));
}
const WALLET = man.carts.find((c) => c.mod === "usbwallet").files.find((n) => n.startsWith("usbwallet."));   // .mpy when compiled (tools/mpy.py)
const KECCAK = man.carts.find((c) => c.mod === "usbwallet").files.find((n) => n.startsWith("keccak."));
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const st = (i, k) => page.evaluate(([i, k]) => window.__ports[i]._st[k], [i, k]);
const files = (i) => page.evaluate((i) => [...window.__ports[i]._st.files.keys()].sort(), i);
const appsOn = (i) => page.evaluate((i) => { try { return JSON.parse(new TextDecoder().decode(window.__ports[i]._st.files.get("apps.json"))); } catch { return null; } }, i);
const rowText = (id) => page.evaluate((id) => document.querySelector(`.wrow[data-id="${id}"]`)?.textContent.replace(/\s+/g, " ").trim() || "", id);
const waitFor = (fn, arg, ms = 20000, what = "") => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => { console.log("STUCK:", what, "|", (await page.textContent("main").catch(() => "")).replace(/\s+/g, " ").slice(0, 500)); return false; });
const wait = (fn, arg, ms, what) => waitFor(fn, arg, ms, what).then((ok) => { if (!ok) { bad++; } return ok; });

await page.goto(base + "/connect");
await page.waitForFunction(() => !document.getElementById("wl"));

// ---- the list: every wedgie, its hardware / firmware / what it runs, in plain words ---------------------
await wait(() => document.querySelectorAll(".wrow[data-id]").length === 3 && !document.querySelector(".light.wait"), null, 25000, "three rows, settled");
const [BARE, OLD, NEW] = ["5A2C29", "152A2F", "3D9F01"];
for (const id of [BARE, OLD, NEW]) console.log("·", id, "→", await rowText(id));
check(/Hardware.*ATECC608 ✓ working/.test(await rowText(NEW)), "0.2: chip proven working on the list");
check(await st(2, "chips") === 1 && await st(2, "interrupts") === 0, "0.2: the chip proof ran once, over JSON, with nothing stopped");
const FW = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8")).version;
check((await rowText(OLD)).includes("update ready: " + FW), "0.1.3: update ready on the list");
check(/Firmware\s*none yet install/.test(await rowText(BARE)), "bare board: no firmware, install on the list");
check(/Software\s*nothing yet pick one/.test(await rowText(NEW)), "0.2 with no app: nothing yet, pick one");
await page.screenshot({ path: `${out}/connect-list${phone ? "-phone" : ""}.png` });

// ---- one wedgie: tap its row, its page at /connect/<ID> -------------------------------------------------
await page.click(`.wrow[data-id="${NEW}"]`);
const nCarts = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8")).carts.length;
await wait(([id, n]) => location.pathname === `/connect/${id}` && document.querySelectorAll("#d-shelf .cart-slot").length === n, [NEW, nCarts], 10000, `detail page with every app (${nCarts}) to pick`);
await page.waitForTimeout(2500);
check((await st(2, "shots")) === 0, "the page doesn't watch its screen unless asked");
await page.click(".dev summary");
await page.click('[data-act="mirror"]');
await wait(() => window.__ports[2]._st.shots >= 2, null, 10000, "Show its screen here: mirrored");
check(/ATECC608 working/.test(await page.textContent("#d-hw")), "detail: hardware says the chip works");
check(/Up to date/.test(await page.textContent("#d-fw")), "detail: firmware up to date");
await wait(() => /Hello/.test(document.querySelector("#d-saves")?.textContent || ""), null, 10000, "its saves listed");
check(/1 file · 1 KB/.test(await page.textContent("#d-saves")) && (await st(2, "interrupts")) === 0, "saves: Hello's, read live (nothing stopped)");
await page.screenshot({ path: `${out}/connect-wedgie${phone ? "-phone" : ""}.png`, fullPage: true });

// pick one: it goes on (the wedgie's screen says so), the wedgie restarts into it, the page finds it again
const shelfOn = (mod) => `document.querySelector('#d-shelf .cart-slot[data-mod="${mod}"] .cart.playing') && /on it|running/.test(document.querySelector('#d-shelf .cart-slot[data-mod="${mod}"] .cart-state').textContent) && document.querySelector('#d-shelf .cart-slot:not([data-mod="${mod}"]) .cart:not(:disabled)')`;
const pickApp = async (mod, what) => { await page.click(`#d-shelf .cart-slot[data-mod="${mod}"] .cart`); return wait(new Function(`return ${shelfOn(mod)}`), null, 30000, what); };
const hashed0 = (await st(2, "hashed")) || 0;
await page.click(`#d-shelf .cart-slot[data-mod="hello"] .cart`);
await wait(() => /Press A on the wedgie/.test(document.querySelector("#d-status")?.textContent || ""), null, 5000, "sealed: the page says to press A on the wedgie");
await wait(() => document.querySelector(".ask-a .ask-3d"), null, 5000, "sealed: the Press A modal is up");
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/connect-ask${phone ? "-phone" : ""}.png` });
await wait(new Function(`return ${shelfOn("hello")}`), null, 30000, "Hello on, running");
check((await st(2, "asks")) === 1, "sealed: it asked its person once");
check(!(await page.$(".ask-a")), "the Press A modal is gone once it answered");
check((await files(2)).includes("hello.py"), "hello.py is on it");
const a1 = await appsOn(2);
check(a1?.length === 1 && a1[0].mod === "hello" && /^[0-9a-f]{12}$/.test(a1[0].v), "apps.json: just hello, with its version: " + JSON.stringify(a1));
check((await st(2, "jobs")) >= 1 && (await st(2, "interrupts")) === 0, "a checked install (0.3.0+): the wedgie did it itself, no Ctrl-C, no REPL");
check(/Question on its screen in \d+ ms \(site \d+, wedgie 42\)/.test(await page.getAttribute("#d-status", "data-ask") || ""), "0.3.11+: the status says how long the question took (site + wedgie): " + (await page.getAttribute("#d-status", "data-ask")));
check(/Memory<\/dt><dd>51 KB free/.test(await page.innerHTML("#d-hw")), "0.3.11+: Hardware shows its free memory");
check((await st(2, "lateJobs")) >= 1 && (await st(2, "hashAtAsk")) === hashed0 && (await st(2, "hashed")) > hashed0, "0.3.10+: the job asked before any file was hashed (the signed list and the sums come after the yes)");
const im = CUR.split(".").map(Number).reduce((a, x) => a * 100 + x, 0) >= 312;    // 0.3.12+: install mode (a restart at the yes)
if (im) check((await st(2, "lostGo")) === 1, "0.3.12+: install mode's restart dropped the port (the first soft reset since the plug-in), and the page found the job again");
check((await st(2, "resets")) === (im ? 2 : 1) && (await st(2, "drops")) === 1, `${im ? "two soft resets (install mode, then into it)" : "one soft reset into it"}; the first one since the plug-in dropped the port, and the page found it again (resets ${await st(2, "resets")}, drops ${await st(2, "drops")})`);

// switch: the old app's files come off; a shared file stays only while something needs it
await pickApp("wire_demo", "Clear sign on");
let f = await files(2);
check(!f.includes("hello.py") && f.includes("wire_demo.py") && f.includes("cbor.py"), "switched: hello.py gone, wire_demo on");
await pickApp("usbwallet", "Wallet on");
f = await files(2);
check(!f.includes("wire_demo.py") && !f.includes("cbor.py") && f.includes(WALLET), "switched again: its own files gone");
check(JSON.stringify((await appsOn(2)).map((a) => [a.mod, a.usb])) === '[["usbwallet",true]]', "apps.json: the Wallet, which has USB to itself");
check((await files(2)).includes("/saves/hello/best.json"), "switching apps never touched the saves");

// take it off
await page.click('#d-shelf .cart-slot[data-mod="usbwallet"] .cart-out');
check(/Take Wallet off\?/.test(await page.textContent('#d-shelf .cart-slot[data-mod="usbwallet"] .cart-out')), "Take it off asks once");
await page.click('#d-shelf .cart-slot[data-mod="usbwallet"] .cart-out');
await wait(() => JSON.parse(new TextDecoder().decode(window.__ports[2]._st.files.get("apps.json"))).length === 0, null, 15000, "Wallet off");
f = await files(2);
check(!f.includes(WALLET) && !f.includes(KECCAK) && f.includes("slot.py"), "its files gone, the core stays");
await wait(() => /Nothing on it yet/.test(document.querySelector("#d-carts-note").textContent), null, 10000, "the page: nothing on it");

const asks = await st(2, "asks");
check(asks === 4 && !(await st(2, "open")), `sealed: every job asked (hello, Clear sign, Wallet, taking it off: ${asks}), locked again after each`);

// a no changes nothing
await page.evaluate(() => { window.__ports[2]._st.person = { say: "no", ms: 300 }; });
await wait(() => document.querySelector('#d-shelf .cart-slot[data-mod="hello"] .cart:not(:disabled)') && document.querySelector("#d-missing").hidden, null, 15000, "back after taking it off");
const beforeNo = JSON.stringify(await files(2));
await page.click(`#d-shelf .cart-slot[data-mod="hello"] .cart`);
await wait(() => /said no/.test(document.querySelector("main")?.textContent || ""), null, 10000, "a no: the page says the wedgie said no");
check((await st(2, "asks")) === asks + 1 && JSON.stringify(await files(2)) === beforeNo, "a no changes nothing");
await page.evaluate(() => { window.__ports[2]._st.person = { say: "yes", ms: 300 }; });

// an app from a GitHub repo (faked from the local starter folder): on the shelf as not reviewed; on it, its
// files named in apps.json; switching away takes them off by that list
const starter = join(homedir(), "clawd/wedgie-starter");
const cors = { "access-control-allow-origin": "*" };
await ctx.route("https://api.github.com/**", (r) => r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ sha: "0123456789abcdef0123456789abcdef01234567" }) }));
await ctx.route("https://raw.githubusercontent.com/**", (r) => {
  const p = join(starter, r.request().url().replace(/^.*?githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ""));
  return existsSync(p) ? r.fulfill({ status: 200, headers: cors, body: readFileSync(p) }) : r.fulfill({ status: 404, headers: cors, body: "" });
});
await page.click("#d-repo-box summary");
await page.fill("#d-repo", "clawdbotatg/wedgie-starter");
await page.click("#d-repo-form button");
await wait(() => document.querySelector('#d-shelf .cart-slot[data-mod="dodge"] .cart-from.unreviewed'), null, 15000, "Dodge on the shelf, not reviewed");
await pickApp("dodge", "Dodge on");
const aD = await appsOn(2);
check((await files(2)).includes("dodge.py") && aD?.[0]?.repo === "clawdbotatg/wedgie-starter" && JSON.stringify(aD[0].files) === '["dodge.py"]', "a repo's app goes on; apps.json names its repo and files: " + JSON.stringify(aD));
await pickApp("hello", "Hello on after Dodge");
check(!(await files(2)).includes("dodge.py"), "switching away takes the repo app's files off");
await page.click('#d-shelf .cart-slot[data-mod="hello"] .cart-out');
await page.click('#d-shelf .cart-slot[data-mod="hello"] .cart-out');
await wait(() => JSON.parse(new TextDecoder().decode(window.__ports[2]._st.files.get("apps.json"))).length === 0, null, 15000, "Hello off again");
await wait(() => /Nothing on it yet/.test(document.querySelector("#d-carts-note").textContent) && document.querySelector('[data-sv-dl="hello"]:not(:disabled)'), null, 15000, "the page: nothing on it, saves ready");

// saves: download, delete, put back
const dl = page.waitForEvent("download");
await page.click('[data-sv-dl="hello"]');
const bundlePath = `${out}/saves-bundle.json`;
await (await dl).saveAs(bundlePath);
const bundle = JSON.parse((await import("node:fs")).readFileSync(bundlePath, "utf8"));
check(bundle["wedgie-saves"] === 1 && atob(bundle.files["/saves/hello/best.json"]) === '{"score": 120}', "saves download: a bundle with Hello's save");
await page.click('[data-sv-rm="hello"]');
check(/Delete them\?/.test(await page.textContent('[data-sv-rm="hello"]')), "Delete saves asks once");
await page.click('[data-sv-rm="hello"]');
await wait(() => ![...window.__ports[2]._st.files.keys()].some((k) => k.startsWith("/saves/hello")), null, 10000, "saves deleted");
await wait(() => /No saves yet/.test(document.querySelector("#d-saves-note").textContent), null, 10000, "the page: no saves yet");
await page.setInputFiles("#d-saves-in", bundlePath);
await wait(() => window.__ports[2]._st.files.has("/saves/hello/best.json") && new TextDecoder().decode(window.__ports[2]._st.files.get("/saves/hello/best.json")) === '{"score": 120}', null, 15000, "saves put back");
await wait(() => /1 save file put back/.test(document.querySelector("#d-saves-note").textContent), null, 10000, "the page says it put them back");

// Developer: the files
await page.click('[data-fs="refresh"]');
await wait(() => document.querySelector('[data-fs-open="/junk.txt"]') && document.querySelector('[data-fs-open="/saves/hello/best.json"]'), null, 10000, "file list, saves folder included");
await page.click('[data-fs-open="/junk.txt"]');
await wait(() => /delete me/.test(document.querySelector("#d-fs-view")?.textContent || ""), null, 10000, "a text file opens");
await page.click('[data-fs-rm="/junk.txt"]');
await page.click('[data-fs-rm="/junk.txt"]');
await wait(() => !window.__ports[2]._st.files.has("junk.txt") && !document.querySelector('[data-fs-open="/junk.txt"]'), null, 10000, "a file deleted");
await page.setInputFiles("#d-fs-in", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi from the page") });
await wait(() => window.__ports[2]._st.files.has("/notes.txt") && document.querySelector('[data-fs-open="/notes.txt"]'), null, 15000, "a file uploaded");
await page.focus(".wd-3d canvas.w3d").catch(() => {});
await page.keyboard.press("a");
await wait(() => window.__ports[2]._st.presses.includes("A"), null, 5000, "A on the 3D wedgie pressed the real A");
await page.screenshot({ path: `${out}/connect-carts${phone ? "-phone" : ""}.png`, fullPage: true })
  .catch(async (e) => console.log(`     (screenshot skipped: ${e.message.split("\n")[0]}; page ${await page.evaluate(() => document.documentElement.scrollHeight)} px tall)`));

// ---- back to the list (no reload), then the 0.1.3 wedgie: its update keeps its first app ---------------
await page.click(".back");
await wait(() => location.pathname === "/connect" && document.querySelectorAll(".wrow[data-id]").length === 3, null, 15000, "back on the list");
await page.click(`.wrow[data-id="${OLD}"]`);
await wait(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, 10000, "0.1.3 page, Update enabled");
check(/Update the firmware/.test(await page.textContent("#d-carts-note")), "0.1.3: Software asks for the update");
await page.click("[data-fw]");
await wait((id) => /Up to date/.test(document.querySelector("#d-fw")?.textContent || "") && location.pathname === `/connect/${id}`, OLD, 120000, `0.1.3 → ${CUR}, came back by its ID`);
check((await st(1, "resets")) === 1 && (await st(1, "drops")) === 1, "one soft reset, at the end; its port dropped and it came back by its ID");
const a3 = await appsOn(1), f3 = await files(1);
check(JSON.stringify(a3) === "[]", "no app yet (nobody picked one): " + JSON.stringify(a3));
check(!f3.includes("hello.py") && !f3.includes("keytest.py") && !f3.includes("menu.py") && f3.includes("slot.py"), "its old apps and the menu gone, the slot on");
await wait(() => /Nothing on it yet/.test(document.querySelector("#d-carts-note")?.textContent || ""), null, 10000, "the page: nothing on it yet");
check(await st(1, "chips") >= 1, "after the update the chip is checked too");

// an app for a chip it hasn't got: faded, says why, the first tap only warns, a second puts it on anyway
const wl = '#d-shelf .cart-slot[data-mod="usbwallet"]';
await wait((s) => document.querySelector(s)?.classList.contains("nochip"), wl, 10000, "no chip: the Wallet is faded");
check(/Wallet needs an ATECC608 chip\. This wedgie has no chip\./.test(await page.textContent(`${wl} .cart-needs`)), "it says why");
check(!(await page.evaluate(() => document.querySelector('#d-shelf .cart-slot[data-mod="hello"]').classList.contains("nochip"))), "an app with no chip needs isn't faded");
await page.click(`${wl} .cart`);
await page.waitForTimeout(800);
check(/Tap it again to put it on anyway/.test(await page.textContent(`${wl} .cart-needs`)) && !(await files(1)).includes(WALLET), "first tap: a warning, nothing installed");
await page.click(`${wl} .cart`);
await wait((WALLET) => window.__ports[1]._st.files.has(WALLET) && JSON.parse(new TextDecoder().decode(window.__ports[1]._st.files.get("apps.json")))[0]?.mod === "usbwallet", WALLET, 30000, "second tap: on anyway");

// ---- the bare board: install the core, it comes back a wedgie with no app yet ---------------------------
await page.click(".back");
await page.click(`.wrow[data-id="${BARE}"]`);
await wait(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, 10000, "bare page, Install enabled");
await page.click("[data-fw]");
await wait(() => /Up to date/.test(document.querySelector("#d-fw")?.textContent || ""), null, 120000, "bare board installed");
const f0 = await files(0);
check(f0.includes("slot.py") && f0.includes("save.py") && !f0.includes("menu.py") && !f0.includes("hello.py"), "the core only, no apps: " + f0.length + " files");
check(JSON.stringify(await appsOn(0)) === "[]", "no app yet");
check((await st(0, "drops")) === 1, "its first boot added the WEDGIE drive (port dropped, came back, found by its ID)");
check(errs.length === 0, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
