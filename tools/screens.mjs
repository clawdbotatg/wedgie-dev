// The front page's pretend wedgie (src/ui/demo.ts) shows real screens of the shelf's apps (community/).
// This takes them into public/screens/: Safe signer and Frog in the browser's virtual wedgie (emu.html on
// the vite dev server; it can stop at the Safe signer's question), Demon Bunker on the virtual RP2040
// (tools/rp2040; the browser one can't load its .mpy files), through the slot's shot answer.
//   node tools/screens.mjs [outdir]        (needs uv, like chipprobe)
import { chromium } from "playwright-core";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as E from "../src/safe/eth.ts";
import { firmware, image } from "./rp2040/image.mjs";
import { host } from "./rp2040/chip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || join(root, "public", "screens");
mkdirSync(out, { recursive: true });
const shelf = (dir) => join(root, "community/clawdbotatg", dir);

{ // the browser's virtual wedgie
  const port = 4181;
  const server = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start")), 20000);
    server.stdout.on("data", (d) => { if (String(d).includes(String(port))) { clearTimeout(t); res(); } });
  });
  const cache = homedir() + "/Library/Caches/ms-playwright";
  const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
  const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
  const page = await (await browser.newContext({ viewport: { width: 760, height: 900 } })).newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`http://localhost:${port}/emu.html?app=`);
  await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 60000 });
  const shot = async (name) => {
    writeFileSync(join(out, name + ".png"), Buffer.from((await page.evaluate(() => window.vw.screenshotPNG())).split(",")[1], "base64"));
    console.log("wrote", name);
  };
  const wait = (ms) => page.waitForTimeout(ms);
  const press = async (k) => { await page.evaluate((k) => window.vw.press(k, 120), k); await wait(150); };
  async function boot(dir, over = {}) {
    const a = JSON.parse(readFileSync(join(shelf(dir), "wedgie.json"), "utf8")).apps[0];
    const files = Object.fromEntries(a.files.map((n) => [n, [...readFileSync(join(shelf(dir), n))]]));
    for (const [k, v] of Object.entries(over)) files[k] = [...Buffer.from(v)];
    await page.evaluate(([a, files]) => window.vw.reboot(a.mod, { app: a, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)])) }), [a, files]);
  }
  try {
    // Safe signer: its home screen (its owner address), then a USDC send waiting for A
    await boot("wedgie-safe", { "saves/safe/key.json": JSON.stringify({ x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32) }) });
    await wait(6000);
    await shot("safe-home");
    const Z = "0x" + "0".repeat(40);
    const tx = { chainId: 8453, safe: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: "0",
      data: E.transferData("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 250000000n), operation: 0,
      safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce: 7 };
    await page.evaluate((l) => window.vw.write(l), JSON.stringify({ id: 1, type: "safe_sign", tx }) + "\n");
    await wait(4000);
    await shot("safe-sign");

    // Frog: a grown frog; feed him his favorite
    await boot("wedgie-frog", { "saves/frog/frog.json": JSON.stringify({ name: "PEPE", food: 80, joy: 85, xp: 150, fav: 1 }) });
    await wait(3000); await shot("frog");
    await press("A"); await wait(1200); await press("right"); await wait(1200); await shot("frog-feed");
    await press("A"); await wait(1200); await shot("frog-eat");
  } finally {
    await browser.close();
    server.kill();
  }
}

{ // Demon Bunker on the virtual RP2040
  const KEYS = { A: 15, B: 17, X: 19, Y: 21, up: 2, down: 18, left: 16, right: 20, press: 3 };
  const h = host({ fs: image(firmware(), "bunker"), onData: () => {} });
  for (const p of Object.values(KEYS)) h.chip.mcu.gpio[p].setInputValue(true);
  if (!h.until((b) => b.includes('"ready"'), 60000, 20)) throw new Error("bunker: no ready line");
  const press = (k, ms = 150) => { const p = h.chip.mcu.gpio[KEYS[k]]; p.setInputValue(false); h.chip.run(ms); p.setInputValue(true); h.chip.run(250); };
  let id = 100;
  const shot = (name) => {               // the slot's shot answer: rgb565, big-endian, in pieces
    const rid = ++id;
    h.take();
    h.chip.write(JSON.stringify({ id: rid, type: "shot" }) + "\n");
    const lines = () => h.out.split("\n").filter((l) => l.includes(`"id": ${rid}`) && l.trim().endsWith("}"));
    h.until(() => { const L = lines(); return L.length && JSON.parse(L[0]).n === L.length; }, 20000, 20);
    const parts = lines().map((l) => JSON.parse(l)).sort((a, b) => a.i - b.i);
    writeFileSync(join(out, name + ".png"), png(Buffer.concat(parts.map((p) => Buffer.from(p.data, "base64"))), parts[0].w, parts[0].h));
    console.log("wrote", name);
  };
  h.chip.run(8000); shot("bunker-title");
  press("A"); h.chip.run(3000); press("A"); h.chip.run(3000);
  press("right", 600); shot("bunker");
  press("up", 600); shot("bunker-2");
}
process.exit(0);

function png(px, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px.readUInt16BE(2 * (y * W + x)), o = y * (W * 3 + 1) + 1 + 3 * x;
    raw[o] = (v >> 11) << 3; raw[o + 1] = ((v >> 5) & 63) << 2; raw[o + 2] = (v & 31) << 3;
  }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
