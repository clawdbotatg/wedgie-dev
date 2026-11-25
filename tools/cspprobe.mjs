// The built site under its script policy (vite.config.ts csp), on a desktop with time to start things: every
// page, the virtual wedgie (WebAssembly, workers), /safe. Fails on anything the policy refused, and checks the
// policy is really on: an inline handler and an injected inline script must not run.
//   node tools/cspprobe.mjs            (after npx vite build; serves dist)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const PAGES = ["/", "/connect", "/safe", "/safe/8453/0xcf589969582dd70544978114c9e5521f61fbe8e5", "/order", "/orders", "/signin", "/virtual", "/sandbox", "/code", "/build",
  "/assemble", "/assemble/3d", "/test", "/update", "/prepare", "/reset", "/debug", "/terms", "/privacy", "/pq", "/claim", "/clear"];
const server = spawn("npx", ["vite", "preview", "--port", "4197", "--strictPort"], { stdio: "ignore" });
const base = "http://localhost:4197";
for (let i = 0; i < 80 && !(await fetch(base).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const bad = [];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
await Promise.all(PAGES.map(async (path) => {
  const p = await ctx.newPage();
  await p.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.log(`CSPV ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile || ""}:${e.lineNumber || ""}`)));
  p.on("pageerror", (e) => bad.push(`${path}: page error: ${e.message.slice(0, 200)}`));
  p.on("console", (m) => { if (/^CSPV|Content Security Policy/.test(m.text())) bad.push(`${path}: ${m.text().slice(0, 300)}`); });
  await p.goto(base + path, { waitUntil: "domcontentloaded" }).catch((e) => bad.push(`${path}: ${e.message}`));
  await p.waitForTimeout(path === "/virtual" || path === "/sandbox" || path === "/code" ? 25000 : 8000);
  if ((await p.innerText("body").catch(() => "")).includes("did not load")) bad.push(`${path}: "Something did not load"`);
  await p.close();
}));
check(!bad.length, `${PAGES.length} pages, nothing refused${bad.length ? ":\n     " + [...new Set(bad)].join("\n     ") : ""}`);
// the policy is on: what an XSS would do doesn't run
const p = await ctx.newPage();
await p.goto(base + "/terms", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
const ran = await p.evaluate(async () => {
  const d = document.createElement("div");
  d.innerHTML = `<img src="data:image/png;base64,AAAA" onerror="window.__x1 = 1">`;
  document.body.appendChild(d);
  const s = document.createElement("script"); s.textContent = "window.__x2 = 1"; document.body.appendChild(s);
  await new Promise((r) => setTimeout(r, 800));
  return [window.__x1, window.__x2];
});
check(ran[0] === undefined, "an inline onerror from drawn HTML doesn't run");
check(ran[1] === undefined, "an injected inline <script> doesn't run");
await browser.close();
server.kill();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
