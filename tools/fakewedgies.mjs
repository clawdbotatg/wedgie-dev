// Fake wedgies on a fake navigator.serial, for the probes (fakeserial.mjs: /connect, updateprobe.mjs:
// /update). A board is MicroPython's raw REPL with a real little filesystem (the installer's hash /
// write / verify / rename steps really run) and, once main.py + menu.py (0.1.x) or slot.py (0.2+) are
// on it, the firmware's JSON lines (hello / shot / launch / press / home / chip; 0.2: stop / ls / get /
// rm). 0.2 runs the one app in apps.json: Ctrl-C stops it, main.py or a soft reset starts it again.
// Soft resets drop the port only where boot.py would add the WEDGIE drive (mark below), like the real
// thing (firmware/boot.py). Saves are files named "/saves/<game>/<name>".
// Use: await ctx.addInitScript(fakeWedgies, [{ uid, machine, files: { "name": "text" | 1 } }, ...])
//   (1 = a one-byte stand-in); window.__ports[i]._st is each board's state; window.__plug(i, false|true)
//   pulls a board out or plugs it back in. A board with noMp: true never answers (no MicroPython);
//   chip: "none" has no secure chip (default: an ATECC608 that proves itself).
export function fakeWedgies(specs) {

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
    const slot = () => st.files.has("slot.py") && st.files.has("main.py");
    const wedgie = () => st.files.has("main.py") && (st.files.has("menu.py") || st.files.has("slot.py"));
    // 0.2: the app it runs (null while stopped by Ctrl-C, or with none on it)
    const running = () => (slot() ? (st.stopped ? null : apps()[0]?.mod ?? null) : st.launched);
    const norm = (k) => "/" + k.replace(/^\//, "");
    const lsAll = (root = "/") => {
      root = root.replace(/\/$/, "") || "";
      const out = new Map();
      for (const [k, v] of st.files) {
        const p = norm(k);
        if (root && !p.startsWith(root + "/")) continue;
        const parts = p.split("/");
        for (let i = 2; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); if (!root || d.startsWith(root + "/")) out.set(d + "/", 0); }
        out.set(p, v.length);
      }
      return [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    };
    const find = (p) => [...st.files.keys()].find((k) => norm(k) === norm(p));
    const rmAll = (p) => { for (const k of [...st.files.keys()]) if (norm(k) === norm(p) || norm(k).startsWith(norm(p).replace(/\/$/, "") + "/")) st.files.delete(k); };
    const chunks = (id, u8, type = "file") => {
      const n = Math.max(1, Math.ceil(u8.length / 3072));
      let o = "";
      for (let i = 0; i < n; i++) { let s = ""; for (const b of u8.subarray(i * 3072, (i + 1) * 3072)) s += String.fromCharCode(b); o += JSON.stringify({ id, type, i, n, size: u8.length, data: btoa(s) }) + "\r\n"; }
      return o;
    };
    const version = () => (st.files.has("wedgie.py") ? (dec.decode(st.files.get("wedgie.py")).match(/VERSION = "([^"]+)"/) || [])[1] || "0.1.0" : null);
    const apps = () => { try { return JSON.parse(dec.decode(st.files.get("apps.json"))); } catch { return []; } };
    const hello = (id, type = "hello") => {
      const v = version(), h = { id, type, name: "wedgie", fw: "wedgie-" + v, version: v, uid, short: uid.slice(-6).toUpperCase(),
        board: machine.includes("RP2350") ? "Pico 2 W" : "RP2040 Pico", cpu: machine.includes("RP2350") ? "RP2350" : "RP2040", micropython: "1.26.1",
        apps: apps().map((a) => a.mod), running: running() };
      if (v >= "0.1.4") Object.assign(h, { carts: apps().map((a) => ({ mod: a.mod, v: a.v })), free: 600000, chip: null });
      if (slot()) h.slot = 1;
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
      if (c.startsWith("_f.close()") && cur) {
        const n = cur.reduce((a, b) => a + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of cur) { u.set(b, o); o += b.length; } st.files.set(curName, u); cur = null;
        if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { st.files.set(m[2], st.files.get(m[1])); st.files.delete(m[1]); }
        return answer("");
      }
      if ((m = c.match(/@sha", json\.dumps\(_h\("([^"]+)"\)\)/))) return answer("@sha " + JSON.stringify(await sha(st.files.get(m[1]))) + "\r\n");
      if ((m = c.match(/os\.rename\("([^"]+)", "([^"]+)"\)/))) { st.files.set(m[2], st.files.get(m[1])); st.files.delete(m[1]); return answer(""); }
      if ((m = c.match(/for _n in (\[.*?\]):\n    (try:\n        )?os\.remove\(_n\)/)) || (m = c.match(/for n in (\[.*?\]):\n    os\.remove\(n\)/))) { for (const n of JSON.parse(m[1])) st.files.delete(n); return answer(""); }
      if ((m = c.match(/"files": wedgie\.ls\("([^"]*)"\)/))) return answer("@ls " + JSON.stringify({ files: lsAll(m[1]), free: 600000 }) + "\r\n");
      if ((m = c.match(/with open\("([^"]+)", "rb"\) as _f:/))) {
        const u8 = st.files.get(find(m[1]));
        if (!u8) return push("OK\x04Traceback (most recent call last):\r\nOSError: [Errno 2] ENOENT\r\n\x04>");
        let o = ""; for (let i = 0; i < u8.length; i += 2048) { let s = ""; for (const b of u8.subarray(i, i + 2048)) s += String.fromCharCode(b); o += "@b " + JSON.stringify(btoa(s)) + "\r\n"; }
        return answer(o);
      }
      if ((m = c.match(/wedgie\.rm\("([^"]+)"\)/))) { rmAll(m[1]); return answer(""); }
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
      if (msg.type === "home" || msg.type === "stop") { st.launched = null; if (slot()) st.stopped = true; return ok(); }
      if (slot() && msg.type === "ls") return push(JSON.stringify({ id, type: "ls", files: lsAll(msg.path || "/"), free: 600000 }) + "\r\n");
      if (slot() && msg.type === "get") { const k = find(msg.path); return push(k ? chunks(id, st.files.get(k)) : JSON.stringify({ id, type: "error", error: "can't read it" }) + "\r\n"); }
      if (slot() && msg.type === "rm") { rmAll(msg.path); return push(JSON.stringify({ id, type: "ok", free: 600000 }) + "\r\n"); }
      if (msg.type === "press") { st.presses.push(msg.key); return ok(); }
      if (msg.type === "chip" && v >= "0.1.4") {
        st.chips++;
        if (st.chip === "none") return push(JSON.stringify({ id, type: "chip", kind: null, chip: null, lines: { sda: 0, scl: 0 }, msg: "00" }) + "\r\n");
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
          if (running() && x > 80 && x < 160 && y > 90 && y < 170) c = c565(34, 196, 82);
          if (!running() && !slot() && y > 60 && y < 94 && x > 9 && x < 231) c = c565(34, 196, 82);
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
        if (st.dead) return;               // no MicroPython on it: nothing ever answers
        for (const ch of dec.decode(chunk)) {
          if (ch === "\x03") { raw = false; line = ""; st.interrupts++; st.stopped = true; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; continue; }
          if (!raw) {
            if (ch === "\x04") {
              st.resets++; st.launched = null; st.stopped = false;
              if (st.files.has("wedgiedrive.py") && !st.mark && st.resetHook) { st.mark = true; st.drops++; st.resetHook(); continue; }
              if (wedgie()) setTimeout(() => push(hello(null, "ready") + "\r\n"), 300);
              continue;
            }
            // Repl.leave({ reset: false }) types exec(open("main.py").read()) + CR: the launcher starts again, home
            if (ch === "\r") { if (line.startsWith("exec(open(")) { line = ""; st.launched = null; st.stopped = false; st.relaunches = (st.relaunches || 0) + 1; } continue; }
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
  const ports = specs.map((b) => {
    const p = board(b.uid, b.machine, new Map(Object.entries(b.files || {}).map(([k, v]) => [k, v === 1 ? new Uint8Array([1]) : text(v)])));
    if (b.noMp) p._st.dead = true;
    p._st.chip = b.chip;
    return p;
  });
  window.__ports = ports;
  const t = new EventTarget();
  const plugged = new Set(ports);
  window.__plug = (i, on) => { const p = ports[i]; if (on) { plugged.add(p); t.dispatchEvent(Object.assign(new Event("connect"), { port: p })); } else { plugged.delete(p); t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })); } };
  for (const p of ports) p._st.resetHook = () => {
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })), 50);
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("connect"), { port: p })), 600);
  };
  Object.defineProperty(navigator, "serial", { value: Object.assign(t, { getPorts: async () => ports.filter((p) => plugged.has(p)), requestPort: async () => ports[0] }) });
}
