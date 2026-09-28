// Drives the site with fake WebSerial boards so the USB paths run without hardware:
//  - a bare MicroPython board (raw REPL; keeps a little filesystem so the firmware installer's
//    hash / write / verify / rename steps really run), which becomes a wedgie after install;
//  - a board already on wedgie firmware (answers hello / shot / launch / press as JSON lines).
// Serve dist first (npx vite preview), then: node tools/fakeserial.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] || "http://localhost:4173/connect";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  localStorage.setItem("wedgie.serial", "1"); // this browser tapped Connect before (see btprobe.mjs for a new one)
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const sha = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));
  function board(uid, machine, files) {
    const st = { files, launched: null, presses: [], shots: 0, resets: 0, resetHook: null };
    let push = () => {};
    let raw = false, code = "", line = "", cur = null, curName = "";
    const wedgie = () => st.files.has("menu.py") && st.files.has("main.py");
    const hello = (id, type = "hello") => JSON.stringify({ id, type, name: "wedgie", fw: "wedgie-0.1.0", version: "0.1.0", uid, short: uid.slice(-6).toUpperCase(),
      board: machine.includes("RP2350") ? "Pico 2 W" : "RP2040 Pico", cpu: machine.includes("RP2350") ? "RP2350" : "RP2040", micropython: "1.26.1", apps: ["hello", "keytest"], running: st.launched });
    const answer = (stdout) => push("OK" + stdout + "\x04\x04>");
    async function execRaw(c) {
      if (c === "") { push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"); return; }
      if (c.includes('"@id"')) return answer('@id {"uid":"' + uid + '","machine":"' + machine + '","mp":"1.26.1","files":' + JSON.stringify([...st.files.keys()]) + ',"wifi":' + machine.includes("W") + "}\r\n");
      if (c.includes("@hashes")) {
        const names = JSON.parse(c.match(/for n in (\[.*?\])\}/)[1]);
        const h = {};
        for (const n of names) h[n] = st.files.has(n) ? await sha(st.files.get(n)) : null;
        return answer("@hashes " + JSON.stringify({ hashes: h, files: [...st.files.keys()] }) + "\r\n");
      }
      let m;
      if ((m = c.match(/_f = open\("([^"]+)", "wb"\)/))) { cur = []; curName = m[1]; return answer(""); }
      if ((m = c.match(/_f\.write\(binascii\.a2b_base64\("([^"]*)"\)\)/))) { cur.push(Uint8Array.from(atob(m[1]), (x) => x.charCodeAt(0))); return answer(""); }
      if (c === "_f.close()") { const n = cur.reduce((a, b) => a + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of cur) { u.set(b, o); o += b.length; } st.files.set(curName, u); return answer(""); }
      if ((m = c.match(/@sha", json\.dumps\(_h\("([^"]+)"\)\)/))) return answer("@sha " + JSON.stringify(await sha(st.files.get(m[1]))) + "\r\n");
      if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { st.files.set(m[2], st.files.get(m[1])); st.files.delete(m[1]); return answer(""); }
      if (c.startsWith("chip()")) return answer('@chip {"lines":{"sda":1,"scl":1},"found":[{"type":"ATECC608","serial":"0123abcd4455667788","configLocked":true,"dataLocked":true}],"scan":["0x60"]}\r\n');
      if (c.startsWith("keys(")) {
        const ks = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
        let o = "@stuck []\r\n"; for (const k of ks) o += `@key {"key":"${k}","down":true}\r\n@key {"key":"${k}","down":false}\r\n`;
        setTimeout(() => answer(o + "@keysDone " + JSON.stringify(ks) + "\r\n"), 300);
        return;
      }
      answer("");
    }
    function onJson(msg) {
      if (!wedgie()) return push(">>> " + JSON.stringify(msg) + "\r\n{'x': 1}\r\n>>> ");
      const id = msg.id;
      if (msg.type === "hello") return push(hello(id) + "\r\n");
      if (msg.type === "launch") { st.launched = msg.app; return push(JSON.stringify({ id, type: "ok" }) + "\r\n"); }
      if (msg.type === "home") { st.launched = null; return push(JSON.stringify({ id, type: "ok" }) + "\r\n"); }
      if (msg.type === "press") { st.presses.push(msg.key); return push(JSON.stringify({ id, type: "ok" }) + "\r\n"); }
      if (msg.type === "shot") {
        st.shots++;
        // white screen, waistband stripes, a green box where "the app" is
        const px = new Uint8Array(240 * 240 * 2);
        const c565 = (r, g, b) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
          let c = c565(254, 254, 254);
          if (y >= 10 && y < 15) c = c565(34, 196, 82); else if (y >= 19 && y < 24) c = c565(169, 170, 171); else if (y >= 28 && y < 33) c = c565(227, 49, 44);
          if (st.launched && x > 80 && x < 160 && y > 90 && y < 170) c = c565(34, 196, 82);
          if (!st.launched && y > 60 && y < 94 && x > 9 && x < 231) c = c565(34, 196, 82);
          px[(y * 240 + x) * 2] = c >> 8; px[(y * 240 + x) * 2 + 1] = c & 255;
        }
        const n = Math.ceil(px.length / 3072);
        let o = "";
        for (let i = 0; i < n; i++) { let s = ""; for (const b of px.subarray(i * 3072, (i + 1) * 3072)) s += String.fromCharCode(b); o += JSON.stringify({ id, type: "shot", i, n, w: 240, h: 240, fmt: "rgb565be", data: btoa(s) }) + "\r\n"; }
        return push(o);
      }
    }
    function streams() {
      const readable = new ReadableStream({ start(c) { push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; } });
      const writable = new WritableStream({ write(chunk) {
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") { raw = false; line = ""; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; continue; }
          if (!raw) {
            if (ch === "\x04") {
              st.resets++;
              // wedgie 0.1.1+: boot.py re-adds the USB drive, which drops the port and plugs it back in
              if (st.files.has("wedgiedrive.py") && st.resetHook) { st.resetHook(); continue; }
              if (wedgie()) setTimeout(() => push(hello(null, "ready") + "\r\n"), 300);
              continue;
            }
            if (ch === "\n") { const l = line; line = ""; if (l.startsWith("{")) { try { onJson(JSON.parse(l)); } catch {} } continue; }
            line += ch; continue;
          }
          if (ch !== "\x04") { code += ch; continue; }
          const c = code; code = ""; execRaw(c);
        }
      } });
      return { readable, writable };
    }
    let cur2 = streams();
    const port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), async open() { cur2 = streams(); }, async close() {},
      get readable() { return cur2.readable; }, get writable() { return cur2.writable; }, _st: st };
    return port;
  }
  const wedgieFiles = new Map([["main.py", new Uint8Array([1])], ["menu.py", new Uint8Array([1])]]);
  const ports = [board("e66138935f5a2c29", "Raspberry Pi Pico 2 W with RP2350", new Map([["boot.py", new Uint8Array([1])]])),
    board("de6474e3a3152a2f", "Raspberry Pi Pico with RP2040", wedgieFiles)];
  window.__ports = ports;
  const t = new EventTarget();
  for (const p of ports) p._st.resetHook = () => {
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })), 50);
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("connect"), { port: p })), 600);
  };
  Object.defineProperty(navigator, "serial", { value: Object.assign(t, { getPorts: async () => ports, requestPort: async () => ports[0] }) });
});

const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const step = (s) => console.log("·", s);
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("wl"));
await page.waitForFunction(() => document.querySelectorAll(".slot .idtag").length === 2 && ![...document.querySelectorAll(".slot .idtag")].some((e) => e.textContent.includes("finding")), null, { timeout: 25000 }).catch(async () => { console.log("TRAY STUCK:", await page.$$eval(".slot", (els) => els.map((e) => e.textContent))); process.exit(1); });
step("tray: " + JSON.stringify(await page.$$eval(".slot .meta", (els) => els.map((e) => e.textContent))));
await page.screenshot({ path: `${out}/fake-tray.png` });

// 1. the bare board: install firmware. The copy must not reset it (that would drop the port on a
// board with the drive); the one reset at the end does drop it, and it must come back on its own.
const slot = (re) => page.evaluate((re) => [...document.querySelectorAll(".slot")].findIndex((e) => new RegExp(re).test(e.textContent)), re);
await page.click(".slot >> nth=0");
await page.click('[data-fw]');
await page.waitForFunction(() => document.querySelector("#p-meter.done"), null, { timeout: 180000 }).catch(async () => {
  console.log("STUCK: meter", await page.textContent("#p-meter-t").catch(() => "?"), "| status", await page.textContent("#p-status").catch(() => "?"), "| fw", await page.textContent("#p-fw").catch(() => "?"));
  console.log("log tail:", JSON.stringify((await page.evaluate(() => document.querySelector("#p-log")?.textContent || "")).slice(-400)));
  process.exit(1);
});
step("install: " + (await page.textContent("#p-meter-t")) + ` (resets during the copy: ${await page.evaluate(() => window.__ports[0]._st.resets)})`);
await page.screenshot({ path: `${out}/fake-install.png` });
const nfiles = await page.evaluate(() => window.__ports[0]._st.files.size);
await page.waitForFunction(() => !document.querySelector(".panel"), null, { timeout: 20000 });
await page.waitForFunction(() => [...document.querySelectorAll(".slot .meta")].some((e) => /Pico 2 W · wedgie/.test(e.textContent)), null, { timeout: 15000 });
step(`board has ${nfiles} files; after its reboot the panel closed and it came back: ${await page.evaluate(() => [...document.querySelectorAll(".slot .meta")].map((e) => e.textContent).join(" | "))}`);
// installing again copies nothing
await page.click(`.slot >> nth=${await slot("Pico 2 W")}`);
await page.click('.tabs button[data-tab="fw"]');
await page.waitForFunction(() => document.querySelector(".tab[data-tab=fw] h4")?.textContent.startsWith("wedgie"), null, { timeout: 15000 });
step("fw tab: " + (await page.textContent(".tab[data-tab=fw] h4")));
await page.click('[data-fw]');
await page.waitForFunction(() => document.querySelector("#p-meter.done") && /up to date/.test(document.querySelector("#p-meter-t").textContent), null, { timeout: 30000 });
step("reinstall: " + (await page.textContent("#p-meter-t")));
await page.waitForFunction(() => !document.querySelector(".panel"), null, { timeout: 20000 });

// 2. the wedgie: live screen, open an app, press a drawn button
await page.click(`.slot >> nth=${await slot("RP2040")}`);
await page.waitForFunction(() => document.querySelector(".panel-dev canvas.w3d") && window.__ports[1]._st.shots >= 2, null, { timeout: 15000 });
step("3D panel up, live screen mirrored (" + (await page.evaluate(() => window.__ports[1]._st.shots)) + " shots)");
await page.click('[data-open="hello"]');
await page.waitForFunction(() => window.__ports[1]._st.launched === "hello", null, { timeout: 5000 });
step("launched hello over JSON");
await page.focus(".panel-dev canvas.w3d");
await page.keyboard.press("a");
await page.waitForFunction(() => window.__ports[1]._st.presses.includes("A"), null, { timeout: 5000 });
step("A on the 3D wedgie pressed the real A");
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/fake-panel.png` });
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no page errors");
await browser.close();
