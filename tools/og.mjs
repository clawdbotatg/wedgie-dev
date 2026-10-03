// Renders the social card: tools/og/index.html (the 3D wedgie showing the wallet) -> public/img/og.png.
// `cover` renders the X header instead: tools/cover/index.html -> public/img/cover.png (1500x500, at 2x).
// Run the dev server first (npx vite), then: node tools/og.mjs [cover] [url]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const cover = process.argv[2] === "cover";
const url = process.argv[cover ? 3 : 2] || `http://localhost:5173/tools/${cover ? "cover" : "og"}/`;
const out = `public/img/${cover ? "cover" : "og"}.png`;
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=metal"] });
const page = await browser.newPage({ viewport: cover ? { width: 1500, height: 500 } : { width: 1200, height: 630 }, deviceScaleFactor: cover ? 2 : 1 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto(url);
await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
await page.screenshot({ path: out });
await browser.close();
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : out);
