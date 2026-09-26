// Drives the site with fake WebSerial wedgies that answer like MicroPython's raw REPL, so the USB
// path (identify, tray, panel, button test) runs without hardware. Serve dist first (npm run preview).
//   node tools/fakeserial.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  function fakePort(uid, machine) {
    let push;
    const readable = new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
    let raw = false, code = "";
    const answer = (stdout) => push("OK" + stdout + "\x04\x04>");
    const writable = new WritableStream({ write(chunk) {
      const s = dec.decode(chunk);
      for (const ch of s) {
        if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
        if (ch === "\x02") { raw = false; continue; }
        if (!raw) continue;
        if (ch !== "\x04") { code += ch; continue; }
        const c = code; code = "";
        if (c === "") { push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"); continue; }
        if (c.includes('"@id"')) answer('@id {"uid":"' + uid + '","machine":"' + machine + '","mp":"1.26.1","files":["boot.py","main.py"],"wifi":' + machine.includes("W") + "}\r\n");
        else if (c.startsWith("chip()")) answer('@chip {"lines":{"sda":1,"scl":1},"found":[{"type":"ATECC608","serial":"0123abcd4455667788","configLocked":true,"dataLocked":true}],"scan":["0x60"]}\r\n');
        else if (c.startsWith("keys(")) {
          const ks = ["up","down","left","right","press","A","B","X","Y"];
          let o = "@stuck []\r\n"; for (const k of ks) o += `@key {"key":"${k}","down":true}\r\n@key {"key":"${k}","down":false}\r\n`;
          setTimeout(() => answer(o + '@keysDone ' + JSON.stringify(ks) + "\r\n"), 400);
        } else answer("");
      }
    } });
    return { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), open: async () => {}, close: async () => {}, readable, writable,
      _fresh() { /* one stream pair per open is enough for this probe */ } };
  }
  // A fresh pair of streams per open(), like a real port.
  function port(uid, machine) {
    let cur = fakePort(uid, machine);
    return { getInfo: () => cur.getInfo(), async open() { cur = fakePort(uid, machine); }, async close() {},
      get readable() { return cur.readable; }, get writable() { return cur.writable; } };
  }
  const ports = [port("e66138935f5a2c29", "Raspberry Pi Pico 2 W with RP2350"), port("de6474e3a3152a2f", "Raspberry Pi Pico with RP2040")];
  const t = new EventTarget();
  Object.defineProperty(navigator, "serial", { value: Object.assign(t, { getPorts: async () => ports, requestPort: async () => ports[0] }) });
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("wl"));
await page.waitForFunction(() => document.querySelectorAll(".slot .idtag").length === 2 && ![...document.querySelectorAll(".slot .idtag")].some((e) => e.textContent.includes("finding")), null, { timeout: 10000 });
const tags = await page.$$eval(".slot .idtag", (els) => els.map((e) => e.textContent));
const metas = await page.$$eval(".slot .meta", (els) => els.map((e) => e.textContent));
console.log("tray:", tags, metas);
await page.locator("#plug").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/fake-tray.png` });
await page.click(".slot >> nth=0");
await page.click('[data-act="chip"]');
await page.waitForFunction(() => document.querySelector("#p-status").textContent.includes("Found"), null, { timeout: 8000 });
console.log("chip:", await page.textContent("#p-chip"));
await page.click('[data-act="keys"]');
await page.waitForFunction(() => document.querySelector("#p-status").textContent.includes("All nine"), null, { timeout: 8000 });
console.log("keys:", await page.textContent("#p-status"));
await page.screenshot({ path: `${out}/fake-panel.png` });
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no page errors");
await browser.close();
