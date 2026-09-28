// Drives /connect with fake WebSerial boards so the USB paths run without hardware. Real clicks.
//  - a bare MicroPython board (raw REPL; a little filesystem, so the installer's hash / write / verify /
//    rename steps really run), which becomes a wedgie 0.1.4 after a firmware install;
//  - a wedgie on 0.1.3: no cartridges protocol, two apps with stale files; its update keeps them;
//  - a wedgie on 0.1.4: answers hello / shot / launch / press / home / apps / chip (a real SHA-256 the
//    page checks) as JSON lines, and takes cartridges in and out through the raw REPL.
// Soft resets drop the port only where boot.py would add the WEDGIE drive (st.mark below): the bare board's
// first boot on the new firmware does, the 0.1.3 wedgie's doesn't. The page must find it again either way.
// Serve dist first (npx vite preview), then: node tools/fakeserial.mjs [url] [outdir] [phone]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/connect\/?$/, "").replace(/\/$/, "");
const out = process.argv[3] || "shots";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
// "phone" as a third argument: the same run at iPhone width (the screenshots are what to look at)
const phone = process.argv[4] === "phone";
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  localStorage.setItem("wedgie.serial", "1"); // this browser tapped Connect before (see btprobe.mjs for a new one)
  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const sha = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));
  const text = (s) => enc.encode(s);
  function board(uid, machine, files) {
    // mark: boot.py's soft-reset mark (watchdog scratch) is set. 0.1.3+ sets it at power-up; a board that
    // powered up on older firmware (or none) has no mark, so the first soft reset after an update looks like a
    // power-up to the new boot.py: it adds the WEDGIE drive, which drops the port and plugs it back in.
    const st = { files, launched: null, presses: [], shots: 0, resets: 0, drops: 0, chips: 0, interrupts: 0, resetHook: null, mark: files.has("wedgiedrive.py") };
    let push = () => {};
    let raw = false, code = "", line = "", cur = null, curName = "";
    const wedgie = () => st.files.has("menu.py") && st.files.has("main.py");
    const version = () => (st.files.has("wedgie.py") ? (dec.decode(st.files.get("wedgie.py")).match(/VERSION = "([^"]+)"/) || [])[1] || "0.1.0" : null);
    const apps = () => { try { return JSON.parse(dec.decode(st.files.get("apps.json"))); } catch { return []; } };
    const hello = (id, type = "hello") => {
      const v = version(), h = { id, type, name: "wedgie", fw: "wedgie-" + v, version: v, uid, short: uid.slice(-6).toUpperCase(),
        board: machine.includes("RP2350") ? "Pico 2 W" : "RP2040 Pico", cpu: machine.includes("RP2350") ? "RP2350" : "RP2040", micropython: "1.26.1",
        apps: apps().map((a) => a.mod), running: st.launched };
      if (v >= "0.1.4") Object.assign(h, { carts: apps().map((a) => ({ mod: a.mod, v: a.v })), free: 600000, chip: null });
      return JSON.stringify(h);
    };
    const answer = (stdout) => push("OK" + stdout + "\x04\x04>");
    async function execRaw(c) {
      if (c === "") { push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"); return; }
      if (c.includes('"@id"')) return answer('@id {"uid":"' + uid + '","machine":"' + machine + '","mp":"1.26.1","files":' + JSON.stringify([...st.files.keys()]) + ',"wifi":' + machine.includes("W") + ',"wedgie":' + JSON.stringify(wedgie() ? version() : null) + "}\r\n");
      if (c.includes("@hashes")) {
        const names = JSON.parse(c.match(/for n in (\[.*?\])\}/)[1]);
        const h = {};
        for (const n of names) h[n] = st.files.has(n) ? await sha(st.files.get(n)) : null;
        return answer("@hashes " + JSON.stringify({ hashes: h, files: [...st.files.keys()], apps: apps() }) + "\r\n");
      }
      let m;
      if (c.includes('open("apps.json", "w")')) { st.files.set("apps.json", text(JSON.parse(c.match(/_f\.write\((".*")\)\n_f\.close/)[1]))); return answer(""); }
      if ((m = c.match(/_f = open\("([^"]+)", "wb"\)/))) { cur = []; curName = m[1]; return answer(""); }
      if ((m = c.match(/_f\.write\(binascii\.a2b_base64\("([^"]*)"\)\)/))) { cur.push(Uint8Array.from(atob(m[1]), (x) => x.charCodeAt(0))); return answer(""); }
      if (c === "_f.close()") { const n = cur.reduce((a, b) => a + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of cur) { u.set(b, o); o += b.length; } st.files.set(curName, u); return answer(""); }
      if ((m = c.match(/@sha", json\.dumps\(_h\("([^"]+)"\)\)/))) return answer("@sha " + JSON.stringify(await sha(st.files.get(m[1]))) + "\r\n");
      if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { st.files.set(m[2], st.files.get(m[1])); st.files.delete(m[1]); return answer(""); }
      if ((m = c.match(/for _n in (\[.*?\]):\n    os\.remove\(_n\)/))) { for (const n of JSON.parse(m[1])) st.files.delete(n); return answer(""); }
      if (c.includes("os.statvfs")) return answer("600000\r\n");
      if (c.startsWith("_ins(")) { st.inserting = (st.inserting || 0) + 1; return answer(""); }
      answer("");
    }
    async function onJson(msg) {
      if (!wedgie()) return push(">>> " + JSON.stringify(msg) + "\r\n{'x': 1}\r\n>>> ");
      const id = msg.id, v = version();
      const ok = () => push(JSON.stringify({ id, type: "ok" }) + "\r\n");
      if (msg.type === "hello") return push(hello(id) + "\r\n");
      if (msg.type === "launch") { if (!apps().some((a) => a.mod === msg.app)) return push(JSON.stringify({ id, type: "error", error: "no such app" }) + "\r\n"); st.launched = msg.app; return ok(); }
      if (msg.type === "home") { st.launched = null; return ok(); }
      if (msg.type === "press") { st.presses.push(msg.key); return ok(); }
      if (msg.type === "chip" && v >= "0.1.4") {
        st.chips++;
        const m = crypto.getRandomValues(new Uint8Array(100));
        return push(JSON.stringify({ id, type: "chip", kind: "atecc", chip: "ATECC608", msg: hex(m), sha: await sha(m), random: ["ffff0000".repeat(8), "ffff0000".repeat(8)],
          serial: "0123abcd4455667788", configLocked: false, dataLocked: false, lines: { sda: 1, scl: 1 } }) + "\r\n");
      }
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
      push(JSON.stringify({ id, type: "error", error: "unknown type" }) + "\r\n");
    }
    function streams() {
      const readable = new ReadableStream({ start(c) { push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; } });
      const writable = new WritableStream({ write(chunk) {
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") { raw = false; line = ""; st.interrupts++; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; continue; }
          if (!raw) {
            if (ch === "\x04") {
              st.resets++; st.launched = null;
              if (st.files.has("wedgiedrive.py") && !st.mark && st.resetHook) { st.mark = true; st.drops++; st.resetHook(); continue; }
              if (wedgie()) setTimeout(() => push(hello(null, "ready") + "\r\n"), 300);
              continue;
            }
            // Repl.leave({ reset: false }) types exec(open("main.py").read()) + CR: the launcher starts again, home
            if (ch === "\r") { if (line.startsWith("exec(open(")) { line = ""; st.launched = null; st.relaunches = (st.relaunches || 0) + 1; } continue; }
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
  const one = () => new Uint8Array([1]);
  const legacyApps = text(JSON.stringify([{ mod: "hello", name: "Hello" }, { mod: "keytest", name: "Buttons" }]));
  const ports = [
    board("e66138935f5a2c29", "Raspberry Pi Pico 2 W with RP2350", new Map([["boot.py", one()]])),
    board("de6474e3a3152a2f", "Raspberry Pi Pico with RP2040", new Map([["main.py", one()], ["menu.py", one()], ["wedgiedrive.py", one()], ["wedgie.py", text('VERSION = "0.1.3"')],
      ["apps.json", legacyApps], ["hello.py", one()], ["keytest.py", one()]])),
    board("aa11bb22cc3d9f01", "Raspberry Pi Pico 2 W with RP2350", new Map([["main.py", one()], ["menu.py", one()], ["wedgie.py", text('VERSION = "0.1.4"')]])),
  ];
  window.__ports = ports;
  const t = new EventTarget();
  for (const p of ports) p._st.resetHook = () => {
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })), 50);
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("connect"), { port: p })), 600);
  };
  Object.defineProperty(navigator, "serial", { value: Object.assign(t, { getPorts: async () => ports, requestPort: async () => ports[0] }) });
});

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const st = (i, k) => page.evaluate(([i, k]) => window.__ports[i]._st[k], [i, k]);
const files = (i) => page.evaluate((i) => [...window.__ports[i]._st.files.keys()].sort(), i);
const appsOn = (i) => page.evaluate((i) => { try { return JSON.parse(new TextDecoder().decode(window.__ports[i]._st.files.get("apps.json"))); } catch { return null; } }, i);
const rowText = (id) => page.evaluate((id) => document.querySelector(`.wrow[data-id="${id}"]`)?.textContent.replace(/\s+/g, " ").trim() || "", id);
const waitFor = (fn, arg, ms = 20000, what = "") => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => { console.log("STUCK:", what, "|", (await page.textContent("main").catch(() => "")).replace(/\s+/g, " ").slice(0, 500)); return false; });
const wait = (fn, arg, ms, what) => waitFor(fn, arg, ms, what).then((ok) => { if (!ok) { bad++; } return ok; });

await page.goto(base + "/connect");
await page.waitForFunction(() => !document.getElementById("wl"));

// ---- the list: every wedgie, its hardware / firmware / what it plays, in plain words --------------------
await wait(() => document.querySelectorAll(".wrow[data-id]").length === 3 && !document.querySelector(".light.wait"), null, 25000, "three rows, settled");
const [BARE, OLD, NEW] = ["5A2C29", "152A2F", "3D9F01"];
for (const id of [BARE, OLD, NEW]) console.log("·", id, "→", await rowText(id));
check(/Hardware.*ATECC608 ✓ working/.test(await rowText(NEW)), "0.1.4: chip proven working on the list");
check(await st(2, "chips") === 1 && await st(2, "interrupts") === 0, "0.1.4: the chip proof ran once, over JSON, with nothing stopped");
check(/update ready: 0\.1\.4/.test(await rowText(OLD)), "0.1.3: update ready on the list");
check(/Firmware\s*none yet install/.test(await rowText(BARE)), "bare board: no firmware, install on the list");
check(/the menu · no cartridges yet/.test(await rowText(NEW)), "0.1.4: playing: the menu, no cartridges");
await page.screenshot({ path: `${out}/connect-list${phone ? "-phone" : ""}.png` });

// ---- one wedgie: tap its row, its page at /connect/<ID> -------------------------------------------------
await page.click(`.wrow[data-id="${NEW}"]`);
await wait((id) => location.pathname === `/connect/${id}` && document.querySelectorAll("#d-more .cart-slot").length === 7, NEW, 10000, "detail page with 7 carts to get");
await wait(() => window.__ports[2]._st.shots >= 2, null, 10000, "live screen mirrored");
check(/ATECC608 working/.test(await page.textContent("#d-hw")), "detail: hardware says the chip works");
check(/Up to date/.test(await page.textContent("#d-fw")), "detail: firmware up to date");
await page.screenshot({ path: `${out}/connect-wedgie${phone ? "-phone" : ""}.png`, fullPage: true });

// tap a cart it doesn't have: it goes in (files + apps.json, the wedgie's screen says so), then plays
await page.click('#d-more .cart-slot[data-mod="hello"] .cart');
await wait(() => window.__ports[2]._st.launched === "hello", null, 20000, "hello inserted and launched");
check((await files(2)).includes("hello.py"), "hello.py is on it");
const a1 = await appsOn(2);
check(a1?.length === 1 && a1[0].mod === "hello" && /^[0-9a-f]{12}$/.test(a1[0].v), "apps.json lists hello with its version: " + JSON.stringify(a1));
check((await st(2, "inserting")) >= 2, "its screen showed the cart going in");
check((await st(2, "resets")) === 0, "no soft reset (the port stays)");
await wait(() => document.querySelector('#d-on .cart-slot[data-mod="hello"] .cart.playing'), null, 5000, "hello on the shelf, playing");

// a cart with shared files: wire_demo (cbor, rlp, p256), then the wallet (shares p256)
await page.click('#d-more .cart-slot[data-mod="wire_demo"] .cart');
await wait(() => window.__ports[2]._st.launched === "wire_demo", null, 30000, "wire_demo in");
await page.click('#d-more .cart-slot[data-mod="usbwallet"] .cart');
await wait(() => window.__ports[2]._st.launched === "usbwallet", null, 30000, "wallet in");
check(JSON.stringify((await appsOn(2)).map((a) => a.mod)) === '["hello","wire_demo","usbwallet"]', "three carts in catalog order");

// play one it has: instant, nothing copied
const writesBefore = await st(2, "interrupts");
await page.click('#d-on .cart-slot[data-mod="hello"] .cart');
await wait(() => window.__ports[2]._st.launched === "hello", null, 5000, "hello again");
check((await st(2, "interrupts")) === writesBefore, "a cart it has plays without stopping anything");

// take wire_demo out: its own files go, the one it shares with the wallet (p256) stays
await page.click('#d-on .cart-slot[data-mod="wire_demo"] .cart-out');
check(/Remove Clear sign\?/.test(await page.textContent('#d-on .cart-slot[data-mod="wire_demo"] .cart-out')), "Remove asks once");
await page.click('#d-on .cart-slot[data-mod="wire_demo"] .cart-out');
await wait(() => !JSON.parse(new TextDecoder().decode(window.__ports[2]._st.files.get("apps.json"))).some((a) => a.mod === "wire_demo"), null, 15000, "wire_demo out");
const f2 = await files(2);
check(!f2.includes("wire_demo.py") && !f2.includes("cbor.py") && !f2.includes("rlp.py") && f2.includes("p256.py") && f2.includes("usbwallet.py"), "its files gone, shared p256.py kept: " + f2.join(" "));
await wait(() => document.querySelector('#d-more .cart-slot[data-mod="wire_demo"]'), null, 5000, "wire_demo back on Get more");
await page.focus(".wd-3d canvas.w3d").catch(() => {});
await page.keyboard.press("a");
await wait(() => window.__ports[2]._st.presses.includes("A"), null, 5000, "A on the 3D wedgie pressed the real A");
await page.screenshot({ path: `${out}/connect-carts${phone ? "-phone" : ""}.png`, fullPage: true });

// ---- back to the list (no reload), then the 0.1.3 wedgie: update keeps its apps ------------------------
await page.click(".back");
await wait(() => location.pathname === "/connect" && document.querySelectorAll(".wrow[data-id]").length === 3, null, 5000, "back on the list");
check(/Playing\s*the menu · 2 cartridges/.test(await rowText(NEW)), "the list: back at its menu (a cart coming out restarts it), 2 cartridges");
await page.click(`.wrow[data-id="${OLD}"]`);
await wait(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, 10000, "0.1.3 page, Update enabled");
check(/Update the firmware/.test(await page.textContent("#d-carts-note")), "0.1.3: cartridges ask for the update");
await page.click("[data-fw]");
await wait((id) => /Up to date/.test(document.querySelector("#d-fw")?.textContent || "") && location.pathname === `/connect/${id}`, OLD, 120000, "0.1.3 → 0.1.4, came back by its ID");
check((await st(1, "resets")) === 1 && (await st(1, "drops")) === 0, "one soft reset, at the end; its port stayed (0.1.3 marks soft resets)");
const a3 = await appsOn(1);
check(JSON.stringify(a3?.map((a) => a.mod)) === '["hello","keytest"]' && a3.every((a) => a.v), "its two apps kept, with versions: " + JSON.stringify(a3?.map((a) => a.mod)));
await wait(() => document.querySelectorAll('#d-on .cart-state.soft').length === 2, null, 10000, "its old apps show as updates");
check(await st(1, "chips") >= 1, "after the update the chip is proven too");

// ---- the bare board: install the core, it comes back a wedgie with an empty launcher --------------------
await page.click(".back");
await page.click(`.wrow[data-id="${BARE}"]`);
await wait(() => document.querySelector("[data-fw]") && !document.querySelector("[data-fw]").disabled, null, 10000, "bare page, Install enabled");
await page.click("[data-fw]");
await wait(() => /Up to date/.test(document.querySelector("#d-fw")?.textContent || ""), null, 120000, "bare board installed");
const f0 = await files(0);
check(f0.includes("menu.py") && !f0.includes("hello.py") && !f0.includes("usbwallet.py"), "the core only, no carts: " + f0.length + " files");
check(JSON.stringify(await appsOn(0)) === "[]", "an empty launcher");
check((await st(0, "drops")) === 1, "its first boot added the WEDGIE drive (port dropped, came back, found by its ID)");
check(errs.length === 0, errs.length ? "page errors: " + errs.join(" | ") : "no page errors");
await browser.close();
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
