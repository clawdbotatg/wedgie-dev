// Drives /format end to end with fakes: Chrome as if the test-bench profile were installed
// (every Pico is visible without a picker) unless a scenario says noProfile. The fake Pico is strict
// about PICOBOOT (command blocks, tokens, ack phases, flash only clearing bits), reboots into bare
// MicroPython (raw REPL, a real little filesystem for the firmware install), answers board()/chip()/
// bench() like bench.py and probe.py, and re-plugs its USB when it boots the wedgie firmware.
// Nothing may happen to a unit until Format is pressed; a used wedgie's saves must survive the wipe
// (or not, with "wipe its saves too" ticked).
// The connect-* scenarios run the same fake Pico through /connect's Set up card (pages/setup.ts): wipe,
// MicroPython, the firmware, no tests.
// Serve dist first (npx vite preview), then: node tools/formatprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const base = process.argv[2] || "http://localhost:4173/";
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });   // /connect draws 3D wedgies

function expected(file, family) {
  const d = readFileSync(file), bytes = new Map();
  for (let o = 0; o < d.length; o += 512) {
    const fl = d.readUInt32LE(o + 8), addr = d.readUInt32LE(o + 12), n = d.readUInt32LE(o + 16), fam = d.readUInt32LE(o + 28);
    if (fl & 0x2000 && fam !== family) continue;
    for (let i = 0; i < n; i++) bytes.set(addr + i, d[o + 32 + i]);
  }
  return bytes;
}

const ATECC = { type: "ATECC608", serial: "0123abcd4455667788", revision: "00006002", configLocked: true, dataLocked: true };
const TM = { type: "OPTIGA Trust M", state: "08800000", uid: "cd16336601001c000100000000000000000000000000000000000000" };
const ALLPASS = ["pass", "pass", "pass", "pass", "pass"];
// pid: the chip (3 = RP2040, 15 = RP2350). wifi: the board has the Pico W's WiFi chip. used: it starts
// as a wedgie on 0.1.1. combo: the joystick's UP comes with IN once. unplugAt: pulled out at that button.
const scenarios = [
  { name: "new-pico", pid: 3, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "new-pico-w", pid: 3, wifi: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO_W", flashes: 2 },
  { name: "new-pico2-w", pid: 15, wifi: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO2_W", flashes: 2 },
  { name: "used-wedgie", pid: 3, used: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "used-saves", pid: 3, used: true, saves: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "used-wipe", pid: 3, used: true, saves: true, wipe: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "sticky-joy", pid: 3, combo: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "no-chip", pid: 3, found: [], lines: { sda: 0, scl: 0 }, want: ["FAIL", ["pass", "pass", "fail", "pass", "pass"]], uf2: "RPI_PICO" },
  { name: "unplugged", pid: 3, found: [ATECC], unplugAt: "down", want: ["FAIL", ["pass", "pass", "pass", "fail", "skip"]], uf2: "RPI_PICO" },
  { name: "no-profile", pid: 3, noProfile: true, found: [ATECC], want: ["PASS", ALLPASS], uf2: "RPI_PICO" },
  { name: "connect-new", page: "connect", pid: 3, found: [ATECC], uf2: "RPI_PICO" },
  { name: "connect-pico2-w", page: "connect", pid: 15, wifi: true, found: [ATECC], uf2: "RPI_PICO2_W", flashes: 2 },
  { name: "connect-no-prof", page: "connect", pid: 3, noProfile: true, found: [ATECC], uf2: "RPI_PICO" },
];

let bad = 0;
for (const sc of scenarios.filter((x) => !process.env.ONLY || x.name === process.env.ONLY)) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await ctx.addInitScript(({ sc, ATECC_SERIAL }) => {
    const ORDER = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
    const enc = new TextEncoder(), dec = new TextDecoder();
    const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const sha = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));
    const st = { execs: 0, usbErrors: [], flash: new Map(), flashes: 0, maxWrite: 0, installed: false, verdict: null, picks: 0 };
    window.__st = st;
    const uid = "e66138935f5a2c29";
    const serialT = new EventTarget(), usbT = new EventTarget();
    const granted = [], devs = [];
    const two = sc.pid === 15;
    const build = () => (st.maxWrite > 0x100a0000 ? "w" : "plain");

    // ---- serial: MicroPython, a wedgie once main.py + slot.py (0.2; menu.py before) are on it ----
    const files = new Map([["boot.py", new Uint8Array([1])]]);
    if (sc.used) for (const n of ["main.py", "menu.py", "wedgiedrive.py"]) files.set(n, new Uint8Array([7]));
    if (sc.saves) { files.set("/saves/hello/best.json", enc.encode('{"score": 120}')); files.set("/saves/demo/x.bin", Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255)); }   // over 2 KB: the raw read comes in chunks
    st.files = files;
    const wedgie = () => (files.has("menu.py") || files.has("slot.py") || files.has("slot.mpy")) && files.has("main.py");    // 0.3.14+: slot.mpy
    let push = () => {}, raw = false, code = "", line = "", cur = null, curName = "", live = true;
    const answer = (stdout, err = "") => push("OK" + stdout + "\x04" + err + "\x04>");
    let port;
    let ctl = null;
    function unplug() {
      live = false;
      try { ctl?.error(new Error("device lost")); } catch {}   // a real unplug ends the port's read
      const i = granted.indexOf(port); if (i >= 0) granted.splice(i, 1);
      serialT.dispatchEvent(Object.assign(new Event("disconnect"), { port }));
    }
    function toBootsel() {
      unplug();
      setTimeout(() => { const d = makeBoot(); devs.push(d); if (!sc.noProfile) usbT.dispatchEvent(Object.assign(new Event("connect"), { device: d })); }, 500);
    }
    function comeBack() {   // MicroPython booted after a flash
      live = true;
      if (sc.noProfile) return;
      granted.push(port);
      setTimeout(() => serialT.dispatchEvent(Object.assign(new Event("connect"), { port })), 50);
    }
    async function execRaw(c) {
      st.execs++;
      if (c === "") return push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>");
      if (c.includes("machine.bootloader()")) return toBootsel();
      if (c.includes('"@id"')) return answer('@id {"uid":"' + uid + '","machine":"Raspberry Pi Pico with ' + (two ? "RP2350" : "RP2040") + '","mp":"1.29.0","files":' + JSON.stringify([...files.keys()]) + ',"wifi":' + (build() === "w") + "}\r\n");
      if (c === "board()") {
        const w = build() === "w";
        const d = { machine: "x", cpu: two ? "RP2350" : "RP2040", uid, mp: "1.29.0", mhz: 150, heap: 200000, fs: 1400000, wbuild: w, wifi: !!sc.wifi };
        if (w && sc.wifi) d.mac = "28:cd:c1:00:11:22";
        if (!w) d.vbus = sc.wifi ? 0 : 1;
        return answer("@board " + JSON.stringify(d) + "\r\n");
      }
      if (c.startsWith("chip()")) return answer("@chip " + JSON.stringify({ lines: sc.lines || { sda: 1, scl: 1 }, found: sc.found, scan: sc.found.length ? ["0x60"] : [] }) + "\r\n");
      if (c.startsWith("bench(")) {
        let t = 0;
        const ev = (s) => { t += 40; setTimeout(() => live && push(s + "\r\n"), t); };
        push("OK");
        for (const phase of [1, 2]) for (const k of ORDER) {
          ev(`@prompt {"phase":${phase},"key":"${k}"}`);
          if (sc.unplugAt === k && phase === 1) { t += 100; setTimeout(unplug, t); return; }
          if (sc.combo && phase === 1 && k === "up") ev(`@combo {"phase":1,"key":"up","with":["press"]}`);
          ev(`@ok {"phase":${phase},"key":"${k}"}`);
        }
        t += 40; setTimeout(() => push('@benchDone {}\r\n\x04\x04>'), t);
        return;
      }
      if (c.startsWith("verdict(")) { st.verdict = c; return answer(""); }
      // the chip used, not locked (bench.py chipwork): ATECC608 hashes the page's random bytes. (Trust M's
      // answer needs a certificate chaining to Infineon, which a fake can't sign, so no scenario uses it here.)
      if (c.startsWith("chipwork(")) {
        const m = crypto.getRandomValues(new Uint8Array(100));
        return answer("@chipwork " + JSON.stringify({ kind: "atecc", msg: hex(m), sha: await sha(m), random: ["ffff0000".repeat(8), "ffff0000".repeat(8)], serial: ATECC_SERIAL, configLocked: true, dataLocked: true }) + "\r\n");
      }
      if (c.includes("@hashes")) {
        const names = JSON.parse(c.match(/^_n = (\[.*\])$/m)[1]), h = {};
        let apps = [];
        try { apps = JSON.parse(new TextDecoder().decode(files.get("apps.json"))); } catch {}
        for (const a of apps) if (Array.isArray(a?.files)) names.push(...a.files.filter((f) => typeof f === "string"));   // as install.ts asks
        for (const n of names) h[n] = files.has(n) ? await sha(files.get(n)) : null;
        return answer("@hashes " + JSON.stringify({ hashes: h, files: [...files.keys()], apps }) + "\r\n");
      }
      let m;
      if ((m = c.match(/_f = open\("([^"]+)", "wb"\)/))) { cur = []; curName = m[1]; return answer(""); }
      if ((m = c.match(/_f\.write\(binascii\.a2b_base64\("([^"]*)"\)\)/))) { cur.push(Uint8Array.from(atob(m[1]), (x) => x.charCodeAt(0))); return answer(""); }
      if (c.startsWith("_f.close()") && cur) {
        const u = new Uint8Array(cur.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of cur) { u.set(b, o); o += b.length; } files.set(curName, u); cur = null;
        if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { files.set(m[2], files.get(m[1])); files.delete(m[1]); }
        return answer("");
      }
      if ((m = c.match(/"files": wedgie\.ls\("([^"]*)"\)/))) {
        const ls = [...files.keys()].filter((k) => k.startsWith(m[1] + "/")).map((k) => [k, files.get(k).length]);
        return answer("@ls " + JSON.stringify({ files: ls, free: 600000 }) + "\r\n");
      }
      if (c.includes('print("@sha"') && (m = c.match(/with open\("([^"]+)", "rb"\)/))) return answer("@sha " + JSON.stringify(await sha(files.get(m[1]))) + "\r\n");   // files.ts writeFile's check
      if ((m = c.match(/with open\("([^"]+)", "rb"\) as _f:/))) {       // one @b line per 2048 bytes, like files.ts's read loop
        const u8 = files.get(m[1]); let o = "";
        for (let i = 0; i < u8.length; i += 2048) { let s = ""; for (const b of u8.subarray(i, i + 2048)) s += String.fromCharCode(b); o += "@b " + JSON.stringify(btoa(s)) + "\r\n"; }
        return answer(o);
      }
      if ((m = c.match(/@sha", json\.dumps\(_h\("([^"]+)"\)\)/))) return answer("@sha " + JSON.stringify(await sha(files.get(m[1]))) + "\r\n");
      if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { files.set(m[2], files.get(m[1])); files.delete(m[1]); if (wedgie()) st.installed = true; return answer(""); }
      answer("");
    }
    const hello = (id) => JSON.stringify({ id, type: "hello", name: "wedgie", fw: "wedgie-0.1.1", version: "0.1.1", uid, board: "wedgie", cpu: two ? "RP2350" : "RP2040", micropython: "1.29.0", apps: [] });
    function replug() { unplug(); setTimeout(() => { live = true; granted.push(port); serialT.dispatchEvent(Object.assign(new Event("connect"), { port })); }, 400); }
    const streams = () => ({
      readable: new ReadableStream({ start(c) { ctl = c; push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; } }),
      writable: new WritableStream({ write(chunk) {
        if (!live) throw new Error("device lost");
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") { line = ""; raw = false; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; continue; }
          if (!raw) {
            if (ch === "\x04") { if (wedgie()) setTimeout(replug, 200); continue; }
            if (ch === "\r") { line = ""; continue; }
            if (ch === "\n") { const l = line; line = ""; if (l.startsWith("{") && wedgie()) { try { const j = JSON.parse(l); if (j.type === "hello") push(hello(j.id) + "\r\n"); } catch {} } continue; }
            line += ch; continue;
          }
          if (ch !== "\x04") { code += ch; continue; }
          const c = code; code = ""; execRaw(c);
        }
      } }),
    });
    let sio = streams();
    port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), async open() { if (!live) throw new Error("Failed to open serial port."); sio = streams(); }, async close() {},
      get readable() { return sio.readable; }, get writable() { return sio.writable; } };
    if (sc.used) granted.push(port);
    Object.defineProperty(navigator, "serial", { value: Object.assign(serialT, {
      getPorts: async () => granted.slice(),
      requestPort: async () => { st.picks++; if (!live) throw new DOMException("none", "NotFoundError"); if (!granted.includes(port)) granted.push(port); return port; },
    }) });

    // ---- BOOTSEL: PICOBOOT, strictly ----
    function makeBoot() {
      const rp2040 = !two, size = (rp2040 ? 2 : 4) << 20;
      let token = 0, pending = null, exclusive = false, xipOff = false, claimed = false;
      const err = (s) => { st.usbErrors.push(s); return { status: "stall" }; };
      const dev = {
        vendorId: 0x2e8a, productId: sc.pid, serialNumber: "E0C9125B0D9B", configuration: null,
        async open() {}, async close() {},
        async selectConfiguration() {
          this.configuration = { interfaces: [
            { interfaceNumber: 0, alternates: [{ interfaceClass: 8, endpoints: [] }] },
            { interfaceNumber: 1, alternates: [{ interfaceClass: 0xff, endpoints: [{ endpointNumber: 3, direction: "out", type: "bulk" }, { endpointNumber: 4, direction: "in", type: "bulk" }] }] }] };
        },
        async claimInterface(n) { if (n !== 1) throw new Error("can't claim " + n); claimed = true; },
        async controlTransferOut(s) { if (s.request !== 0x41 || s.index !== 1) err("bad control"); pending = null; return { status: "ok" }; },
        async controlTransferIn() { return { status: "ok", data: new DataView(new ArrayBuffer(16)) }; },
        async transferOut(ep, data) {
          const u = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
          if (ep !== 3 || !claimed) return err("out on ep " + ep);
          if (pending?.phase === "data") {
            if (u.length !== pending.len) return err("data length " + u.length);
            for (let i = 0; i < u.length; i++) { const a = pending.addr + i, s = st.flash.get(a); if (s === undefined) return err("write to unerased " + a.toString(16)); st.flash.set(a, s & u[i]); }
            st.maxWrite = Math.max(st.maxWrite, pending.addr + u.length);
            pending.phase = "ack"; return { status: "ok", bytesWritten: u.length };
          }
          if (pending) return err("command while " + pending.phase);
          const dv = new DataView(u.buffer);
          if (u.length !== 32 || dv.getUint32(0, true) !== 0x431fd10b) return err("bad command block");
          const tok = dv.getUint32(4, true), id = dv.getUint8(8), size8 = dv.getUint8(9), len = dv.getUint32(12, true);
          if (tok <= token) return err("token not increasing"); token = tok;
          const want = { 1: 1, 2: 12, 3: 8, 5: 8, 6: 0, 0x0a: 16 }[id];
          if (want === undefined || want !== size8) return err(`cmd 0x${id.toString(16)} size ${size8}`);
          if (id === 0x02 && !rp2040) return err("REBOOT on RP2350");
          if (id === 0x0a && rp2040) return err("REBOOT2 on RP2040");
          const addr = dv.getUint32(16, true), n = dv.getUint32(20, true);
          if (id === 1) exclusive = dv.getUint8(16) > 0;
          if (id === 6) xipOff = true;
          if ((id === 3 || id === 5) && (!exclusive || !xipOff)) return err("flash op before exclusive/exit_xip");
          if (id === 3) {
            if (addr % 4096 || n % 4096 || addr < 0x10000000 || addr + n > 0x10000000 + size) return err("erase range " + addr.toString(16));
            if (addr === 0x10000000) { st.flash.clear(); st.maxWrite = 0; }
            for (let i = 0; i < n; i++) st.flash.set(addr + i, 0xff);
            if (addr + n === 0x10000000 + size) { st.wiped = true; files.clear(); files.set("boot.py", new Uint8Array([1])); }
          }
          if (id === 5 && (addr % 256 || len !== n)) return err("write alignment/length");
          if (id === 2 || id === 0x0a) {
            st.flashes++;
            setTimeout(() => { usbT.dispatchEvent(Object.assign(new Event("disconnect"), { device: dev })); devs.splice(devs.indexOf(dev), 1); setTimeout(comeBack, 300); }, 100);
          }
          if (len && id !== 5) return err("unexpected transfer length");
          pending = id === 5 ? { phase: "data", addr, len } : { phase: "ack" };
          return { status: "ok", bytesWritten: 32 };
        },
        async transferIn(ep) {
          if (ep !== 4 || pending?.phase !== "ack") return err("in on ep " + ep + " while " + pending?.phase);
          pending = null; return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
        },
      };
      return dev;
    }
    if (!sc.used) { live = false; devs.push(makeBoot()); }
    const visible = new Set();
    Object.defineProperty(navigator, "usb", { value: Object.assign(usbT, {
      getDevices: async () => devs.filter((d) => !sc.noProfile || visible.has(d)),
      requestDevice: async () => { st.picks++; for (let i = 0; i < 50 && !devs.length; i++) await new Promise((r) => setTimeout(r, 100)); if (!devs.length) throw new DOMException("none", "NotFoundError"); visible.add(devs[0]); return devs[0]; },
    }) });
  }, { sc, ATECC_SERIAL: ATECC.serial });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  if (sc.page === "connect") { await connectRun(sc, ctx, page, errs); await ctx.close(); continue; }
  await page.goto(base + "test");     // the old name: it lands on /format
  const notes = [];
  if (sc.wipe) await page.check("#t-wipe");
  if (!sc.noProfile) {
    await page.waitForSelector("#t-go", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => ({ path: location.pathname, flashes: window.__st.flashes, wiped: !!window.__st.wiped, maxWrite: window.__st.maxWrite, execs: window.__st.execs }));
    if (before.flashes || before.wiped || before.maxWrite || before.execs) notes.push("STARTED BEFORE FORMAT " + JSON.stringify(before));
    if (before.path !== "/format") notes.push("not on /format: " + before.path);
    await page.click("#t-go");
  }
  if (sc.noProfile) {   // tap whatever the page asks for, and count the taps
    for (let i = 0; i < 6; i++) {
      const sel = await Promise.race([
        page.waitForSelector("#t-pick", { timeout: 30000 }).then(() => "#t-pick", () => null),
        page.waitForSelector("#t-go", { timeout: 30000 }).then(() => "#t-go", () => null),
        i ? new Promise(() => {}) : page.waitForSelector("#t-new", { timeout: 30000 }).then(() => "#t-new", () => null),
        page.waitForFunction(() => /^(PASS|FAIL)$/.test(document.getElementById("t-text")?.textContent || ""), null, { timeout: 30000 }).then(() => "done", () => null),
      ]);
      if (!sel || sel === "done") break;
      await page.click(sel);
      await page.waitForTimeout(500);
    }
  }
  await page.waitForFunction(() => /^(PASS|FAIL)$/.test(document.getElementById("t-text")?.textContent || "") || /Not wiped/.test(document.body.textContent), null, { timeout: 90000 });
  const notWiped = await page.evaluate(() => (document.body.textContent.match(/Not wiped: [^.\n]*/) || [""])[0]);
  if (notWiped) notes.push(notWiped);
  const execs = await page.evaluate(() => window.__st.execs);
  await page.waitForTimeout(3000);   // the finished unit re-plugs its USB: nothing may start again
  await page.screenshot({ path: `${out}/format-${sc.name}.png`, fullPage: true });
  const got = await page.evaluate(() => ({
    status: document.getElementById("t-text").textContent,
    cards: [...document.querySelectorAll(".test-card")].map((c) => c.className.replace("test-card ", "")),
    details: [...document.querySelectorAll(".test-detail")].map((d) => d.textContent),
    facts: [...document.querySelectorAll("#t-facts dt")].map((d) => d.textContent + "=" + d.nextElementSibling.textContent),
    st: { ...window.__st, flash: undefined },
    flash: [...window.__st.flash].filter(([a, v]) => v !== 0xff && a < 0x10100000),
  }));
  let ok = got.status === sc.want[0] && JSON.stringify(got.cards) === JSON.stringify(sc.want[1]) && !errs.length && !notes.some((n) => /BEFORE|not on/.test(n));
  if (sc.saves) {
    const sv = await page.evaluate(() => [...window.__st.files.keys()].filter((k) => k.startsWith("/saves/")).sort().join(","));
    const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("wedgie.saves.")).length);
    const want = sc.wipe ? "" : "/saves/demo/x.bin,/saves/hello/best.json";
    const big = await page.evaluate(() => { const b = window.__st.files.get("/saves/demo/x.bin"); return b ? b.length === 5000 && b.every((x, i) => x === ((i * 7) & 255)) : null; });
    if (!sc.wipe && !big) { ok = false; notes.push("the 5000-byte save came back wrong"); }
    if (sv !== want || kept) { ok = false; notes.push(`saves after: [${sv}], ${kept} left in the browser`); }
    else notes.push(sc.wipe ? "saves wiped" : "saves kept");
  }
  if (got.st.execs !== execs) { ok = false; notes.push("RAN AGAIN after re-plug"); }
  if (sc.want[0] === "PASS" && !got.st.installed) { ok = false; notes.push("firmware not installed"); }
  if (!sc.unplugAt && !String(got.st.verdict).includes(sc.want[0] === "PASS" ? "True" : "False")) { ok = false; notes.push("screen verdict " + got.st.verdict); }
  if (got.st.flashes !== (sc.flashes || 1)) { ok = false; notes.push("flashes " + got.st.flashes); }
  if (!sc.noProfile && got.st.picks) { ok = false; notes.push(`${got.st.picks} taps needed`); }
  if (sc.noProfile) notes.push(`${got.st.picks} taps`);
  const want = expected(`public/mp/${sc.uf2}.uf2`, sc.pid === 3 ? 0xe48bff56 : 0xe48bff59), have = new Map(got.flash);
  let wrong = 0;
  for (const [a, v] of want) if ((have.get(a) ?? 0xff) !== v) wrong++;
  for (const [a] of have) if (!want.has(a)) wrong++;
  if (wrong || got.st.usbErrors.length || !got.st.wiped) { ok = false; notes.push(`flash: ${wrong} wrong bytes, usb errors ${JSON.stringify(got.st.usbErrors.slice(0, 3))}, wiped ${got.st.wiped}`); }
  else notes.push(`${sc.uf2} exact`);
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", sc.name.padEnd(12), got.status, got.cards.join(","), "|", got.details.join(" | "), "|", notes.join("; "), errs.length ? "ERRORS " + errs.join("; ") : "");
  if (sc.name === "new-pico-w") console.log("     facts:", got.facts.join(" · "));
  await ctx.close();
}
// /connect: a new Pico gets the Set up card; Set up wipes it and puts the firmware on, nothing before the tap.
async function connectRun(sc, ctx, page, errs) {
  const notes = [];
  if (!sc.noProfile) await page.addInitScript(() => localStorage.setItem("wedgie.serial", "1"));   // tapped Connect before
  await page.goto(base + "connect");
  if (sc.noProfile) await page.click("#pick-new");
  await page.waitForSelector(".setup-go", { timeout: 20000 });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({ flashes: window.__st.flashes, maxWrite: window.__st.maxWrite, execs: window.__st.execs }));
  if (before.flashes || before.maxWrite || before.execs) notes.push("STARTED BEFORE SET UP " + JSON.stringify(before));
  await page.click(".setup-go");
  for (let i = 0; i < 6; i++) {
    // A Mac's first serial pick shows the Bluetooth note over the card: tap that first.
    const sel = await page.waitForSelector("#bt-go, #setup-pick, .setup.good, .setup.bad", { timeout: 120000 })
      .then(() => page.evaluate(() => ["#bt-go", "#setup-pick"].find((q) => document.querySelector(q)) || "done"), () => null);
    if (!sel || sel === "done") break;
    await page.click(sel);
    await page.waitForTimeout(500);
  }
  await page.waitForSelector(".setup.good, .setup.bad", { timeout: 120000 }).catch(() => {});
  const execs = await page.evaluate(() => window.__st.execs);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/format-${sc.name}.png`, fullPage: true });
  const got = await page.evaluate(() => ({ card: document.querySelector(".setup")?.className, text: document.querySelector(".setup")?.innerText.replace(/\s+/g, " "),
    st: { ...window.__st, flash: undefined }, flash: [...window.__st.flash].filter(([a, v]) => v !== 0xff && a < 0x10100000) }));
  let ok = /good/.test(got.card || "") && got.st.installed && !errs.length && !notes.length;
  if (!got.st.installed) notes.push("firmware not installed");
  if (got.st.flashes !== (sc.flashes || 1)) { ok = false; notes.push("flashes " + got.st.flashes); }
  if (!sc.noProfile && got.st.picks) { ok = false; notes.push(`${got.st.picks} taps needed`); }
  if (sc.noProfile) notes.push(`${got.st.picks} taps`);
  const want = expected(`public/mp/${sc.uf2}.uf2`, sc.pid === 3 ? 0xe48bff56 : 0xe48bff59), have = new Map(got.flash);
  let wrong = 0;
  for (const [a, v] of want) if ((have.get(a) ?? 0xff) !== v) wrong++;
  for (const [a] of have) if (!want.has(a)) wrong++;
  if (wrong || got.st.usbErrors.length || !got.st.wiped) { ok = false; notes.push(`flash: ${wrong} wrong bytes, usb errors ${JSON.stringify(got.st.usbErrors.slice(0, 3))}, wiped ${got.st.wiped}`); }
  else notes.push(`${sc.uf2} exact`);
  if (!ok) bad++;
  console.log(ok ? "ok  " : "BAD ", sc.name.padEnd(12), "|", got.text, "|", notes.join("; "), errs.length ? "ERRORS " + errs.join("; ") : "");
}
await browser.close();
process.exit(bad ? 1 : 0);
