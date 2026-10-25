// Does every page load on a phone? Builds, serves dist, opens each page as an iPhone with no wedgie (no
// navigator.serial, like a phone or incognito) and fails on any page error or "Something did not load".
// Run before every push that touches src/ (~10 s). The 2026-10-22 outage: a top-bar function called before
// it was defined crashed wedgie.dev on phones for 40 minutes; this would have caught it.
// Locally it then runs tools/hiddenprobe.mjs (~16 s): a firmware update from a background tab, and
// tools/oldappprobe.mjs (~10 s): a firmware update on a wedgie running an older Safe Signer.
//   node tools/loadprobe.mjs            build + check localhost
//   node tools/loadprobe.mjs <url>      check a live site (no build)
import { chromium, devices } from "playwright-core";
import { execSync, spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const PAGES = ["/", "/connect", "/safe", "/order", "/orders", "/signin", "/virtual", "/code", "/build", "/assemble",
  "/test", "/update", "/prepare", "/reset", "/debug", "/terms", "/privacy"];
let base = process.argv[2]?.replace(/\/$/, ""), server;
setTimeout(() => { console.log("FAIL: timed out"); server?.kill(); process.exit(1); }, 180000);
if (!base) {
  execSync("npx vite build", { stdio: "ignore" });
  server = spawn("npx", ["vite", "preview", "--port", "4198", "--strictPort"], { stdio: "ignore" });
  base = "http://localhost:4198";
  for (let i = 0; i < 50 && !(await fetch(base).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
}
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
await ctx.addInitScript(() => { delete Navigator.prototype.serial; });
const bad = [];
await Promise.all(PAGES.map(async (path) => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => bad.push(`${path}: ${e.message}`));
  await p.goto(base + path, { waitUntil: "domcontentloaded" }).catch((e) => bad.push(`${path}: ${e.message}`));
  await p.waitForTimeout(2500);
  if ((await p.innerText("body").catch(() => "")).includes("did not load")) bad.push(`${path}: "Something did not load"`);
}));
await browser.close();
console.log(bad.length ? "FAIL\n" + bad.join("\n") : `OK: ${PAGES.length} pages load on a phone`);
let hidden = 0;
if (server) {
  const h = spawnSync("node", [new URL("./hiddenprobe.mjs", import.meta.url).pathname, base], { encoding: "utf8" });
  hidden = h.status;
  console.log(hidden ? "FAIL: an update from a background tab (tools/hiddenprobe.mjs)\n" + (h.stdout + h.stderr).trim() : "OK: an update from a background tab goes through");
  const o = spawnSync("node", [new URL("./oldappprobe.mjs", import.meta.url).pathname, base], { encoding: "utf8" });
  hidden ||= o.status;
  console.log(o.status ? "FAIL: an update with an older Safe Signer on it (tools/oldappprobe.mjs)\n" + (o.stdout + o.stderr).trim() : "OK: an update with an older Safe Signer on it goes through");
}
server?.kill();
process.exit(bad.length || hidden ? 1 : 0);
