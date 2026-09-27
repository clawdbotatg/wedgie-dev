// Drives /test with a fake WebSerial board, one scenario per page. Serve dist first
// (npx vite preview), then: node tools/testprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const url = (process.argv[2] || "http://localhost:4173/") + "test";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });

const ATECC = { type: "ATECC608", serial: "0123abcd4455667788", configLocked: true, dataLocked: true };
const TM = { type: "OPTIGA Trust M", state: "08800000", uid: "cd16336601001c000100000000000000000000000000000000000000" };
const TM_MUTE = { type: "OPTIGA Trust M", uidError: "Trust M no response" };
const ALL = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];

// found: chip() result; stuck: keys held from the start; answer: the operator's screen answer
const scenarios = [
  { name: "atecc-pass", found: [ATECC], stuck: [], answer: "1", want: { status: "PASS", cards: ["pass", "pass", "pass"] } },
  { name: "trustm-pass", found: [TM], stuck: [], answer: "1", want: { status: "PASS", cards: ["pass", "pass", "pass"] } },
  { name: "trustm-mute", found: [TM_MUTE], stuck: [], answer: "1", want: { status: "FAIL", cards: ["fail", "pass", "pass"] } },
  { name: "no-chip", found: [], lines: { sda: 0, scl: 0 }, stuck: [], answer: "1", want: { status: "FAIL", cards: ["fail", "pass", "pass"] } },
  { name: "screen-no", found: [ATECC], stuck: [], answer: "0", want: { status: "FAIL", cards: ["pass", "fail", "pass"] } },
  { name: "stuck-key", found: [ATECC], stuck: ["A"], answer: "1", want: { status: "FAIL", cards: ["pass", "pass", "fail"] } },
];

let bad = 0;
for (const sc of scenarios) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(({ sc, ALL }) => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    const st = { execs: [], leaves: 0 };
    let push = () => {}, raw = false, code = "", keysPending = null;
    const answer = (stdout, err = "") => push("OK" + stdout + "\x04" + err + "\x04>");
    function execRaw(c) {
      st.execs.push(c.slice(0, 40));
      if (c === "") return push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>");
      if (c.includes('"@id"')) return answer('@id {"uid":"e66138935f5a2c29","machine":"Raspberry Pi Pico 2 W with RP2350","mp":"1.26.1","files":["boot.py"],"wifi":true}\r\n');
      if (c.startsWith("chip()")) return answer("@chip " + JSON.stringify({ lines: sc.lines || { sda: 1, scl: 1 }, found: sc.found, scan: [] }) + "\r\n");
      if (c.startsWith("keys(")) {
        if (sc.stuck.length) { push("OK@stuck " + JSON.stringify(sc.stuck) + "\r\n"); keysPending = true; return; }
        let o = "@stuck []\r\n";
        for (const k of ALL) o += `@key {"key":"${k}","down":true}\r\n@key {"key":"${k}","down":false}\r\n`;
        setTimeout(() => answer(o + "@keysDone " + JSON.stringify(ALL) + "\r\n"), 300);
        return;
      }
      answer("");
    }
    const streams = () => ({
      readable: new ReadableStream({ start(c) { push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; } }),
      writable: new WritableStream({ write(chunk) {
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") {
            if (keysPending) { keysPending = null; push("\x04Traceback\r\nKeyboardInterrupt: \r\n\x04>"); }
            else raw = false;
            continue;
          }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; st.leaves++; continue; }
          if (!raw) continue;
          if (ch !== "\x04") { code += ch; continue; }
          const c = code; code = ""; execRaw(c);
        }
      } }),
    });
    let cur = streams();
    const port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), async open() { cur = streams(); }, async close() {},
      get readable() { return cur.readable; }, get writable() { return cur.writable; } };
    window.__st = st; window.__port = port;
    Object.defineProperty(navigator, "serial", { value: Object.assign(new EventTarget(), { getPorts: async () => [port], requestPort: async () => port }) });
  }, { sc, ALL });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(url);
  await page.waitForSelector("#t-ask:not([hidden])", { timeout: 20000 });
  await page.screenshot({ path: `${out}/test-${sc.name}-ask.png` });
  await page.click(`[data-ans="${sc.answer}"]`);
  await page.waitForFunction(() => /PASS|FAIL/.test(document.getElementById("t-text").textContent), null, { timeout: 20000 });
  await page.screenshot({ path: `${out}/test-${sc.name}.png` });
  const got = await page.evaluate(() => ({
    status: document.getElementById("t-text").textContent,
    detail: document.getElementById("t-detail").textContent,
    cards: [...document.querySelectorAll(".test-card")].map((c) => c.className.replace("test-card ", "")),
    details: [...document.querySelectorAll(".test-detail")].map((d) => d.textContent),
    leaves: window.__st.leaves,
  }));
  // unplug: the result stays up. Plug the next one in: it tests by itself.
  let replug = true;
  if (sc.name === "atecc-pass") {
    await page.evaluate(() => { const p = window.__port; navigator.serial.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })); });
    await page.waitForTimeout(500);
    const still = await page.textContent("#t-text");
    await page.evaluate(() => { const p = window.__port; navigator.serial.dispatchEvent(Object.assign(new Event("connect"), { port: p })); });
    replug = still === "PASS" && await page.waitForSelector("#t-ask:not([hidden])", { timeout: 20000 }).then(() => true, () => false);
  }
  const ok = got.status === sc.want.status && JSON.stringify(got.cards) === JSON.stringify(sc.want.cards) && got.leaves >= 1 && replug && !errs.length;
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", sc.name.padEnd(12), got.status, got.cards.join(","), "|", got.details.join(" | "), errs.length ? "ERRORS " + errs.join("; ") : "", replug ? "" : "REPLUG FAILED");
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
