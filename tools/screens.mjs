// Captures real wedgie screens from the virtual wedgie (the actual firmware) into public/screens/*.png,
// for the 3D wedgies around the site to show. Serve the build (npx vite preview), then:
//   node tools/screens.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] || "http://localhost:4173/";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
await p.goto(url);
await p.waitForFunction(() => !document.getElementById("wl"));
await p.locator("#virtual-card").scrollIntoViewIfNeeded();
await p.click("#virtual-go");
await p.waitForFunction(() => window.__wedgieVirtual, null, { timeout: 30000 });
const press = (k, ms = 200) => p.evaluate(([k, ms]) => window.__wedgieVirtual.press(k, ms), [k, ms]);
const wait = (ms) => p.waitForTimeout(ms);
mkdirSync("public/screens", { recursive: true });
const shot = async (name) => {
  const d = await p.evaluate(() => window.__wedgieVirtual.screenshotPNG());
  writeFileSync(`public/screens/${name}.png`, Buffer.from(d.split(",")[1], "base64"));
  console.log(name);
};
// home through the launcher itself: scripted taps can race two apps' timers in the emulator
const home = async () => { await p.evaluate(() => window.__wedgieVirtual.exec("import menu\nmenu.home()")); await wait(1000); };
// the launcher keeps its cursor between apps, so put it on app i, then press A like a person
const open = async (i) => { await p.evaluate((i) => window.__wedgieVirtual.exec(`import menu\nmenu.sel = ${i}\nmenu.dirty = True`), i); await wait(300); await press("A"); };

await wait(1500); await shot("launcher");
await open(0); await wait(1600); await shot("hello"); await home();
await open(1); await wait(900); for (const k of ["A", "up", "right"]) await press(k); await wait(400); await shot("buttons"); await home();
await open(3); await wait(1200); await shot("wallet-home");
for (const n of ["chart", "send", "receive"]) { await press("right"); await wait(700); await shot("wallet-" + n); }
await press("right"); await press("right"); await press("right"); await press("right"); await wait(900); await shot("wallet-signing");
await home();
await open(4); await wait(2500); await shot("clear-sign"); await home();
await open(2); await wait(3000); await shot("demo"); await press("A"); await wait(2500); await shot("demo-2");
await b.close();
