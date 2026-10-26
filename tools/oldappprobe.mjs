// A firmware update on a wedgie that runs an older Safe Signer, one without some of today's Safe Signer files
// (safe_icons came in safe-26). The page read that as "no app" and sent the update apps [], which the wedgie
// refuses: "a firmware update keeps the app it runs" (Austin, 2026-10-25). The wedgie's rule (wedgie.active)
// is the app's own file; the page's is now the same. Then Safe Signer is out of date, its own question.
// Serve dist first (npx vite preview), then: node tools/oldappprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fakeWedgies } from "./fakewedgies.mjs";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, "");
const cache = homedir() + (process.platform === "darwin" ? "/Library/Caches/ms-playwright" : "/.cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc3d9f01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.64"', "apps.json": JSON.stringify([{ mod: "safe", name: "Safe Signer", entry: "run", usb: true }]), "safe.py": 1, "safe_read.py": 1, "safe_ur.py": 1, "safe_7730.py": 1, "safe_wire.py": 1, "safe_roots.py": 1, "safe_keccak.py": 1, "safe_addr.py": 1, "safe_blockie.py": 1, "safe_key.py": 1 } },
]);
// the fakes don't check signatures: an unsigned tree is served as signed (fakeserial.mjs does the same)
const man = JSON.parse(readFileSync(new URL("../public/fw/manifest.json", import.meta.url), "utf8"));
if (!man.signed) {
  await ctx.route("**/fw/manifest.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...man, signed: true }) }));
  await ctx.route("**/fw/release.txt", (r) => r.fulfill({ contentType: "text/plain", body: `wedgie-release 1\nversion ${man.version}\n` + [...man.files].sort((a, b) => a.name < b.name ? -1 : 1).map((f) => `${f.sha256}  ${f.name}\n`).join("") }));
}

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(base + "/connect/3D9F01");
await page.waitForSelector("[data-fw]:not([disabled])", { timeout: 30000 });
const t0 = Date.now();
await page.click("[data-fw]");
const done = await page.waitForFunction(() => /Restarting it on the new firmware|Update failed[^\n]*/.exec(document.querySelector("main").innerText)?.[0], null, { timeout: 300000 })
  .then((h) => h.jsonValue(), () => "nothing after 5 minutes");
check(/Restarting/.test(done), `the update went through with the old Safe Signer on it (${((Date.now() - t0) / 1000).toFixed(0)} s): ${done}`);
const puts = await page.evaluate(() => window.__ports[0]._st.rawPuts || 0);
check(puts > 30, `it was sent in raw 4 KB puts (${puts})`);
// apps null: it keeps its apps.json (firmware before 0.3.66 reads today's signed list as naming no apps, install.ts APP_LIST)
const sent = await page.evaluate(() => (window.__ports[0]._st.jobLog || []).map((j) => j.msg.job + ": " + (j.msg.apps == null ? "kept" : JSON.parse(j.msg.apps).map((a) => a.mod).join() || "none")));
check(sent[0] === "Update firmware: kept", `the update keeps Safe Signer (${sent.join(" | ")})`);
check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join(" | ") : ""));
console.log(bad ? `${bad} FAILED` : "all ok");
await browser.close();
process.exit(bad ? 1 : 0);
