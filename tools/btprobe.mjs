// A new visitor on a Mac must never trigger the macOS Bluetooth prompt by just looking: no page may
// touch navigator.serial until they tap Connect, and that tap explains the prompt before the picker.
// A returning browser (armed) sees its wedgies at load, no note. Real taps, not element.click().
// Serve dist first (npx vite preview), then: node tools/btprobe.mjs [url]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] || "http://localhost:4173/").replace(/\/$/, "");
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let fail = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) fail++; };

async function visit(path, { armed = false, mac = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(({ armed, mac }) => {
    if (armed) localStorage.setItem("wedgie.serial", "1");
    Object.defineProperty(navigator, "platform", { get: () => (mac ? "MacIntel" : "Linux x86_64") });
    const log = (window.__serial = []);
    const port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), connected: true, async open() { throw new Error("probe: not opened"); }, async close() {} };
    const t = new EventTarget();
    const add = t.addEventListener.bind(t);
    const api = {
      getPorts: async () => { log.push("getPorts"); return armed ? [port] : []; },
      requestPort: async () => { log.push("requestPort"); throw new DOMException("none", "NotFoundError"); },
      addEventListener: (...a) => { log.push("listen"); add(...a); },
    };
    Object.defineProperty(navigator, "serial", { value: api });
  }, { armed, mac });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + path);
  await page.waitForTimeout(1500);
  return { ctx, page, errs, log: () => page.evaluate(() => window.__serial.slice()) };
}

for (const path of ["/", "/connect", "/assemble"]) {
  const v = await visit(path);
  check((await v.log()).length === 0, `${path}: new visitor, no serial touched at load (${JSON.stringify(await v.log())})`);
  check(/Allow/.test(await v.page.textContent("#connect-btn")), `${path}: header is the red Allow button`);
  check(!v.errs.length, `${path}: no page errors ${v.errs.join("; ")}`);
  await v.ctx.close();
}

// Tap the header: the note first, still nothing touched; Not now leaves it untouched.
{
  const v = await visit("/");
  await v.page.locator("#connect-btn").click();
  await v.page.waitForSelector(".bt-ask");
  check((await v.log()).length === 0, "tap: note shown before any serial call");
  await v.page.locator("#bt-no").click();
  await v.page.waitForTimeout(300);
  check(!(await v.page.$(".bt-ask")) && (await v.log()).length === 0, "Not now: note gone, still nothing touched");
  check(new URL(v.page.url()).pathname === "/", "Not now: stays on the page");
  await v.page.locator("#connect-btn").click();
  await v.page.locator("#bt-go").click();
  await v.page.waitForTimeout(800);
  const l = await v.log();
  check(l[0] === "requestPort", `OK: the picker opens first (${JSON.stringify(l)})`);
  check(await v.page.evaluate(() => localStorage.getItem("wedgie.serial")) === "1", "OK: remembered, the next visit looks by itself");
  await v.ctx.close();
}

// /connect's own button goes through the same note.
{
  const v = await visit("/connect");
  await v.page.locator("#connect").click();
  await v.page.waitForSelector(".bt-ask");
  check((await v.log()).length === 0, "/connect button: note before any serial call");
  await v.ctx.close();
}

// Not a Mac: no note, the picker straight away.
{
  const v = await visit("/", { mac: false });
  await v.page.locator("#connect-btn").click();
  await v.page.waitForTimeout(500);
  check(!(await v.page.$(".bt-ask")) && (await v.log())[0] === "requestPort", "not a Mac: picker directly, no note");
  await v.ctx.close();
}

// Returning browser: looks at load, shows the wedgie, no note.
{
  const v = await visit("/", { armed: true });
  check((await v.log()).includes("getPorts"), "armed: counts ports at load");
  check(/Connected/.test(await v.page.textContent("#connect-btn")), "armed: header shows Connected");
  await v.ctx.close();
}

await browser.close();
console.log(fail ? `${fail} FAILED` : "all ok");
process.exit(fail ? 1 : 0);
