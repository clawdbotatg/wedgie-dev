// Renders the social card: tools/og/index.html (the 3D wedgie showing the wallet) -> public/img/og.png.
// Run the dev server first (npx vite), then: node tools/og.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] || "http://localhost:5173/tools/og/";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=metal"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
await page.screenshot({ path: "public/img/og.png" });
await browser.close();
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "public/img/og.png");
