// Drives /test end to end with fakes: a blank Pico in BOOTSEL (WebUSB PICOBOOT, strict about the
// protocol and about flash only clearing bits), which reboots into a bare MicroPython serial port
// (raw REPL, real little filesystem for the firmware install), which reboots into wedgie firmware and
// re-plugs its USB like the WEDGIE drive does. Serve dist first (npx vite preview), then:
//   node tools/testprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const base = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });

// What the flash must hold after MicroPython goes on: every UF2 block for the chip's family, nothing else.
function expected(file, family) {
  const d = readFileSync(file), bytes = new Map();
  for (let o = 0; o < d.length; o += 512) {
    const fl = d.readUInt32LE(o + 8), addr = d.readUInt32LE(o + 12), n = d.readUInt32LE(o + 16), fam = d.readUInt32LE(o + 28);
    if (fl & 0x2000 && fam !== family) continue;
    for (let i = 0; i < n; i++) bytes.set(addr + i, d[o + 32 + i]);
  }
  return bytes;
}

const ATECC = { type: "ATECC608", serial: "0123abcd4455667788", configLocked: true, dataLocked: true };
const TM = { type: "OPTIGA Trust M", state: "08800000", uid: "cd16336601001c000100000000000000000000000000000000000000" };
const TM_MUTE = { type: "OPTIGA Trust M", uidError: "Trust M no response" };
const PASS5 = ["pass", "pass", "pass", "pass", "pass"];

// boot: a blank Pico of that chip in BOOTSEL. used: a wedgie on 0.1.1, already granted, files and all.
const scenarios = [
  { name: "blank-rp2040", boot: 0x0003, found: [ATECC], stuck: [], answer: "1", want: ["PASS", PASS5] },
  { name: "blank-rp2350", boot: 0x000f, found: [TM], stuck: [], answer: "1", want: ["PASS", PASS5] },
  { name: "used-wedgie", used: true, boot: 0x0003, found: [ATECC], stuck: [], answer: "1", want: ["PASS", PASS5] },
  { name: "trustm-mute", boot: 0x0003, found: [TM_MUTE], stuck: [], answer: "1", want: ["FAIL", ["pass", "fail", "pass", "pass", "skip"]] },
  { name: "no-chip", boot: 0x0003, found: [], lines: { sda: 0, scl: 0 }, stuck: [], answer: "1", want: ["FAIL", ["pass", "fail", "pass", "pass", "skip"]] },
  { name: "screen-no", boot: 0x0003, found: [ATECC], stuck: [], answer: "0", want: ["FAIL", ["pass", "pass", "fail", "pass", "skip"]] },
  { name: "stuck-key", boot: 0x0003, found: [ATECC], stuck: ["A"], answer: "1", want: ["FAIL", ["pass", "pass", "pass", "fail", "skip"]] },
];

let bad = 0;
for (const sc of scenarios) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(({ sc }) => {
    const ALL = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
    const enc = new TextEncoder(), dec = new TextDecoder();
    const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const sha = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));
    const st = { execs: 0, leaves: 0, usbErrors: [], flash: new Map(), rebooted: null, installed: false };
    window.__st = st;
    const uid = "e66138935f5a2c29";
    const serialT = new EventTarget(), usbT = new EventTarget();
    const granted = [];

    // ---- bare MicroPython on serial, becomes a wedgie once main.py + menu.py are on it ----
    const files = new Map([["boot.py", new Uint8Array([1])]]);
    if (sc.used) for (const n of ["main.py", "menu.py", "wedgiedrive.py", "apps.json"]) files.set(n, new Uint8Array([7]));
    const wedgie = () => files.has("menu.py") && files.has("main.py");
    let push = () => {}, raw = false, code = "", line = "", keysPending = false, cur = null, curName = "";
    const answer = (stdout, err = "") => push("OK" + stdout + "\x04" + err + "\x04>");
    async function execRaw(c) {
      st.execs++; (st.log = st.log || []).push(c.slice(0, 40));
      if (c === "") return push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>");
      if (c.includes("machine.bootloader()")) {
        st.bootloader = true;
        granted.splice(granted.indexOf(port), 1);
        serialT.dispatchEvent(Object.assign(new Event("disconnect"), { port }));
        setTimeout(() => { devs.push(makeBoot(sc.boot)); }, 500);
        return;
      }
      if (c.includes('"@id"')) return answer('@id {"uid":"' + uid + '","machine":"Raspberry Pi Pico with RP2040","mp":"1.29.0","files":' + JSON.stringify([...files.keys()]) + ',"wifi":false}\r\n');
      if (c.startsWith("chip()")) return answer("@chip " + JSON.stringify({ lines: sc.lines || { sda: 1, scl: 1 }, found: sc.found, scan: [] }) + "\r\n");
      if (c.startsWith("keys(")) {
        if (sc.stuck.length) { push("OK@stuck " + JSON.stringify(sc.stuck) + "\r\n"); keysPending = true; return; }
        let o = "@stuck []\r\n";
        for (const k of ALL) o += `@key {"key":"${k}","down":true}\r\n@key {"key":"${k}","down":false}\r\n`;
        setTimeout(() => answer(o + "@keysDone " + JSON.stringify(ALL) + "\r\n"), 300);
        return;
      }
      if (c.includes("@hashes")) {
        const names = JSON.parse(c.match(/for n in (\[.*?\])\}/)[1]), h = {};
        for (const n of names) h[n] = files.has(n) ? await sha(files.get(n)) : null;
        return answer("@hashes " + JSON.stringify({ hashes: h, files: [...files.keys()] }) + "\r\n");
      }
      let m;
      if ((m = c.match(/_f = open\("([^"]+)", "wb"\)/))) { cur = []; curName = m[1]; return answer(""); }
      if ((m = c.match(/_f\.write\(binascii\.a2b_base64\("([^"]*)"\)\)/))) { cur.push(Uint8Array.from(atob(m[1]), (x) => x.charCodeAt(0))); return answer(""); }
      if (c === "_f.close()") { const u = new Uint8Array(cur.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of cur) { u.set(b, o); o += b.length; } files.set(curName, u); return answer(""); }
      if ((m = c.match(/@sha", json\.dumps\(_h\("([^"]+)"\)\)/))) return answer("@sha " + JSON.stringify(await sha(files.get(m[1]))) + "\r\n");
      if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { files.set(m[2], files.get(m[1])); files.delete(m[1]); if (wedgie()) st.installed = true; return answer(""); }
      answer("");
    }
    const hello = (id) => JSON.stringify({ id, type: "hello", name: "wedgie", fw: "wedgie-0.1.1", version: "0.1.1", uid, board: "RP2040 Pico", cpu: "RP2040", micropython: "1.29.0", apps: [] });
    const streams = () => ({
      readable: new ReadableStream({ start(c) { push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; } }),
      writable: new WritableStream({ write(chunk) {
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") { line = ""; if (keysPending) { keysPending = false; push("\x04Traceback\r\nKeyboardInterrupt: \r\n\x04>"); } else raw = false; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; st.leaves++; continue; }
          if (!raw) {
            // soft reset into wedgie firmware: the WEDGIE drive re-plugs USB
            if (ch === "\x04") { if (wedgie()) setTimeout(replug, 200); continue; }
            if (ch === "\r") { line = ""; continue; }
            if (ch === "\n") { const l = line; line = ""; if (l.startsWith("{") && wedgie()) { try { const j = JSON.parse(l); if (j.type === "hello") push(hello(j.id) + "\r\n"); } catch {} } }
            else line += ch;
            continue;
          }
          if (ch !== "\x04") { code += ch; continue; }
          const c = code; code = ""; execRaw(c);
        }
      } }),
    });
    let sio = streams();
    const port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), async open() { sio = streams(); }, async close() {},
      get readable() { return sio.readable; }, get writable() { return sio.writable; } };
    function replug() {
      serialT.dispatchEvent(Object.assign(new Event("disconnect"), { port }));
      setTimeout(() => serialT.dispatchEvent(Object.assign(new Event("connect"), { port })), 400);
    }
    if (sc.used) granted.push(port);
    Object.defineProperty(navigator, "serial", { value: Object.assign(serialT, {
      getPorts: async () => granted.slice(),
      requestPort: async () => { if (!st.rebooted) throw new DOMException("none", "NotFoundError"); if (!granted.includes(port)) granted.push(port); return port; },
    }) });

    // ---- a blank Pico in BOOTSEL: PICOBOOT, strictly ----
    const devs = [];
    function makeBoot(pid) {
      const rp2040 = pid === 0x0003;
      let token = 0, pending = null, exclusive = false, xipOff = false, claimed = false;
      const err = (s) => { st.usbErrors.push(s); return { status: "stall" }; };
      const dev = {
        vendorId: 0x2e8a, productId: pid, serialNumber: "E0C9125B0D9B", configuration: null, opened: false,
        async open() { this.opened = true; }, async close() { this.opened = false; },
        async selectConfiguration() {
          this.configuration = { interfaces: [
            { interfaceNumber: 0, alternates: [{ interfaceClass: 8, endpoints: [] }] },
            { interfaceNumber: 1, alternates: [{ interfaceClass: 0xff, endpoints: [{ endpointNumber: 3, direction: "out", type: "bulk" }, { endpointNumber: 4, direction: "in", type: "bulk" }] }] }] };
        },
        async claimInterface(n) { if (n !== 1) throw new Error("can't claim " + n); claimed = true; },
        async controlTransferOut(s) { if (s.request !== 0x41 || s.index !== 1) err("bad control " + JSON.stringify(s)); pending = null; return { status: "ok" }; },
        async controlTransferIn() { return { status: "ok", data: new DataView(new ArrayBuffer(16)) }; },
        async transferOut(ep, data) {
          const u = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
          if (ep !== 3 || !claimed) return err("out on ep " + ep);
          if (pending?.phase === "data") {
            if (u.length !== pending.len) return err("data length " + u.length);
            const a = pending.addr;
            for (let i = 0; i < u.length; i++) { const s = st.flash.get(a + i); if (s === undefined) return err("write to unerased " + (a + i).toString(16)); st.flash.set(a + i, s & u[i]); }
            pending.phase = "ack"; return { status: "ok", bytesWritten: u.length };
          }
          if (pending) return err("command while " + pending.phase);
          const dv = new DataView(u.buffer);
          if (u.length !== 32 || dv.getUint32(0, true) !== 0x431fd10b) return err("bad command block");
          const tok = dv.getUint32(4, true), id = dv.getUint8(8), size = dv.getUint8(9), len = dv.getUint32(12, true);
          if (tok <= token) return err("token not increasing"); token = tok;
          const want = { 1: 1, 2: 12, 3: 8, 5: 8, 6: 0, 0x0a: 16 }[id];
          if (want === undefined || want !== size) return err(`cmd 0x${id.toString(16)} size ${size}`);
          if (id === 0x02 && !rp2040) return err("REBOOT on RP2350 (needs REBOOT2)");
          if (id === 0x0a && rp2040) return err("REBOOT2 on RP2040");
          const addr = dv.getUint32(16, true), n = dv.getUint32(20, true);
          if (id === 1) exclusive = dv.getUint8(16) > 0;
          if (id === 6) xipOff = true;
          if ((id === 3 || id === 5) && (!exclusive || (rp2040 && !xipOff))) return err("flash op before exclusive/exit_xip");
          if (id === 3) {
            if (addr % 4096 || n % 4096 || addr < 0x10000000 || addr + n > 0x10000000 + (rp2040 ? 2 : 4) * 1048576) return err("erase range " + addr.toString(16));
            for (let i = 0; i < n; i++) st.flash.set(addr + i, 0xff);
            if (addr + n === 0x10000000 + (rp2040 ? 2 : 4) * 1048576) { st.wiped = true; files.clear(); files.set("boot.py", new Uint8Array([1])); }
          }
          if (id === 5 && (addr % 256 || len !== n)) return err("write alignment/length");
          if (id === 2 || id === 0x0a) { st.rebooted = id; setTimeout(() => { usbT.dispatchEvent(Object.assign(new Event("disconnect"), { device: dev })); devs.length = 0; }, 100); }
          pending = id === 5 ? { phase: "data", addr, len } : { phase: "ack" };
          if (len && id !== 5) return err("unexpected transfer length");
          return { status: "ok", bytesWritten: 32 };
        },
        async transferIn(ep) {
          if (ep !== 4 || pending?.phase !== "ack") return err("in on ep " + ep + " while " + pending?.phase);
          pending = null; return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
        },
      };
      return dev;
    }
    if (!sc.used) devs.push(makeBoot(sc.boot));
    // like Chrome's chooser: lists the device once it's there
    const requestDevice = async () => { for (let i = 0; i < 50 && !devs.length; i++) await new Promise((r) => setTimeout(r, 100)); if (!devs.length) throw new DOMException("none", "NotFoundError"); return devs[0]; };
    Object.defineProperty(navigator, "usb", { value: Object.assign(usbT, { getDevices: async () => devs.slice(), requestDevice }) });
  }, { sc });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "test");
  const notes = [];
  if (sc.used) {
    await page.waitForSelector("#t-wipe", { timeout: 20000 });
    await page.screenshot({ path: `${out}/test-${sc.name}-wipe.png` });
    await page.click("#t-wipe");
  }
  {
    await page.waitForSelector("#t-serial", { timeout: 60000 });
    await page.screenshot({ path: `${out}/test-${sc.name}-pick.png` });
    await page.click("#t-serial");
  }
  await page.waitForSelector("#t-ask:not([hidden])", { timeout: 20000 });
  await page.screenshot({ path: `${out}/test-${sc.name}-ask.png` });
  await page.click(`[data-ans="${sc.answer}"]`);
  await page.waitForFunction(() => /PASS|FAIL/.test(document.getElementById("t-text").textContent), null, { timeout: 60000 });
  // the finished wedgie re-plugs its USB: that must not start another run
  const execs = await page.evaluate(() => window.__st.execs);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/test-${sc.name}.png` });
  const got = await page.evaluate(() => ({
    status: document.getElementById("t-text").textContent,
    cards: [...document.querySelectorAll(".test-card")].map((c) => c.className.replace("test-card ", "")),
    details: [...document.querySelectorAll(".test-detail")].map((d) => d.textContent),
    st: { wiped: window.__st.wiped, execs: window.__st.execs, leaves: window.__st.leaves, usbErrors: window.__st.usbErrors, rebooted: window.__st.rebooted, installed: window.__st.installed },
    flash: [...window.__st.flash].filter(([, v]) => v !== 0xff),
  }));
  let ok = got.status === sc.want[0] && JSON.stringify(got.cards) === JSON.stringify(sc.want[1]) && !errs.length;
  if (got.st.execs !== execs) { ok = false; notes.push("RAN AGAIN after re-plug: " + JSON.stringify((await page.evaluate(() => window.__st.log)).slice(execs - 2))); }
  if (got.st.installed !== (sc.want[0] === "PASS")) { ok = false; notes.push("install " + got.st.installed); }
  if (sc.boot) {
    const want = expected(sc.boot === 3 ? "public/mp/RPI_PICO.uf2" : "public/mp/RPI_PICO2.uf2", sc.boot === 3 ? 0xe48bff56 : 0xe48bff59);
    const have = new Map(got.flash);
    let wrong = 0;
    for (const [a, v] of want) if ((have.get(a) ?? 0xff) !== v) wrong++;
    for (const [a] of have) if (!want.has(a) && a < 0x10100000) wrong++;   // (the wiped area reads 0xFF)
    if (wrong || got.st.usbErrors.length || !got.st.rebooted || !got.st.wiped) { ok = false; notes.push(`flash wrong bytes ${wrong}, usb errors ${JSON.stringify(got.st.usbErrors.slice(0, 3))}, reboot ${got.st.rebooted}`); }
    else notes.push(`flash ok: ${want.size} bytes, reboot 0x${got.st.rebooted.toString(16)}`);
  }
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", sc.name.padEnd(13), got.status, got.cards.join(","), "|", got.details.join(" | "), "|", notes.join("; "), errs.length ? "ERRORS " + errs.join("; ") : "");
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
