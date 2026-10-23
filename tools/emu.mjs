// A virtual wedgie for any session, no hardware and no one's browser: headless Chromium with /virtual (the
// real firmware on a virtual RP2040 + a software Trust M, src/chip/) in one tab, and wedgie.dev in others,
// which see it plugged in. Drive it over a small HTTP API on localhost. docs/EMU.md says how to test with it.
//   node tools/emu.mjs [--local] [--port 4190]      --local: this tree (builds it, serves it with vite preview)
// Then:
//   curl -s localhost:4190/status                              {id, status, tabs}
//   curl -s localhost:4190/screen > s.png                      the wedgie's screen, exact pixels (240x240)
//   curl -s localhost:4190/history?n=10                        the last n screens [{t, png(data URL)}]
//   curl -s localhost:4190/press -d '{"k":"A"}'                 A B X Y up down left right press; "ms" optional
//   curl -s localhost:4190/hold -d '{"k":"up","down":true}'     hold / let go (diagonals: hold two)
//   curl -s localhost:4190/open -d '{"url":"/connect"}'         a wedgie.dev tab -> {tab}
//   curl -s localhost:4190/eval -d '{"tab":1,"js":"document.title"}'      run JS in a tab (0 = /virtual)
//   curl -s localhost:4190/click -d '{"tab":1,"js":"document.querySelector(\"...\")"}'   a real click
//   curl -s localhost:4190/shot?tab=1 > page.png                a tab's screenshot
//   curl -s localhost:4190/text?tab=1                          a tab's visible text
//   curl -s localhost:4190/wipe -d '{}'                         its flash back to new (ID and chip keys stay)
// Its flash and chip live in the browser profile (node_modules/.cache/emu-profile): it's the same wedgie
// next time, with what you installed. The firmware's questions time out after 60 s of the chip's time.
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = +arg("--port", 4190);
let base = "https://wedgie.dev";
if (args.includes("--local")) {
  const out = join(root, "node_modules/.cache/emu-dist"), pp = port + 1;
  execSync(`npx vite build --outDir ${out} --emptyOutDir`, { cwd: root, stdio: "inherit" });
  const srv = spawn("npx", ["vite", "preview", "--outDir", out, "--port", String(pp), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res) => srv.stdout.on("data", (d) => String(d).includes(String(pp)) && res()));
  process.on("exit", () => srv.kill());
  base = `http://localhost:${pp}`;
}

const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const exe = `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`;
const profile = join(root, "node_modules/.cache/emu-profile");
mkdirSync(profile, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, viewport: { width: 1200, height: 1000 } });
const tabs = [ctx.pages()[0] || (await ctx.newPage())];
const emu = tabs[0];
emu.on("pageerror", (e) => console.log("emu error:", e.message));
await emu.goto(base + "/virtual?no3d");
await emu.waitForFunction(() => /% of real/.test(document.getElementById("emu-status")?.textContent || ""), null, { timeout: 120000 });
const status = () => emu.evaluate(() => document.getElementById("emu-status").textContent);

const body = (req) => new Promise((res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
const png = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");
createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), q = await body(req), tab = tabs[+(q.tab ?? u.searchParams.get("tab") ?? 0)];
  const json = (v) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
  try {
    switch (u.pathname) {
      case "/status": return json({ status: await status(), id: await emu.evaluate(() => window.wedgie?.id), tabs: tabs.map((t, i) => ({ tab: i, url: t.url() })) });
      case "/screen": res.setHeader("content-type", "image/png"); return res.end(png(await emu.evaluate(() => window.wedgie.screen())));
      case "/history": return json(await emu.evaluate((n) => window.wedgie.history(n), +(u.searchParams.get("n") || 10)));
      case "/press": await emu.evaluate(([k, ms]) => window.wedgie.press(k, ms), [q.k, q.ms ?? 250]); return json({ ok: true });
      case "/hold": await emu.evaluate(([k, d]) => window.wedgie.hold(k, d), [q.k, !!q.down]); return json({ ok: true });
      case "/open": { const p = await ctx.newPage(); await p.goto(q.url.startsWith("http") ? q.url : base + q.url); tabs.push(p); return json({ tab: tabs.length - 1 }); }
      case "/eval": return json({ value: await tab.evaluate(q.js) });
      case "/click": { const h = await tab.evaluateHandle(q.js); await h.asElement().click(); return json({ ok: true }); }
      case "/shot": res.setHeader("content-type", "image/png"); return res.end(await tab.screenshot());
      case "/text": return json({ text: await tab.evaluate(() => document.body.innerText) });
      case "/wipe": {
        emu.once("dialog", (d) => d.accept());
        await emu.click("#emu-wipe");
        await emu.waitForFunction(() => /% of real/.test(document.getElementById("emu-status").textContent), null, { timeout: 120000 });
        return json({ status: await status() });
      }
    }
    res.statusCode = 404; json({ error: "no such command: " + u.pathname });
  } catch (e) { res.statusCode = 500; json({ error: String(e?.message || e) }); }
}).listen(port, "127.0.0.1", async () => console.log(`virtual wedgie ${await emu.evaluate(() => window.wedgie?.id)} on ${base}: http://localhost:${port}  (${await status()})`));
