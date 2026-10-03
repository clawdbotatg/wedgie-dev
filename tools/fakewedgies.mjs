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
// 0.2.5+ is sealed: Ctrl-C is a plain byte until {"type": "open"} is answered yes by the pretend person
// (person: { say: "yes" | "no", ms }, default yes after 300 ms; _st.asks counts the questions). A yes lasts
// until main.py starts again (a soft reset or exec(main.py)): one job.
// 0.3.12+ install mode: a yes to a job soft-resets first and says go after the restart (_st.jobRestarts);
// if that reset drops the port (the first since a plug-in), the go is lost (_st.lostGo) but the job runs
// on: a host finds the wedgie again by its ID, and hello says "job": true.
export function fakeWedgies(specs) {

  localStorage.setItem("wedgie.serial", "1"); // this browser tapped Connect before (see btprobe.mjs for a new one)
  const enc = new TextEncoder(), dec = new TextDecoder();
  const cmpV = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const sha = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));
  const text = (s) => enc.encode(s);
  function board(uid, machine, files) {
    // mark: boot.py's soft-reset mark (watchdog scratch) is set. 0.1.3+ sets it at power-up; a board that
    // powered up on older firmware (or none) has no mark, so the first soft reset after an update looks like a
    // power-up to the new boot.py: it adds the WEDGIE drive, which drops the port and plugs it back in.
    // driveOn: the drive is up (added at this power-up). A soft reset takes it off again, and that
    // changes USB too: the first soft reset after a plug-in drops the port as well (seen on a real
    // RP2040 wedgie 2026-09-29: the page lost it after every firmware update). While dropped, open() fails.
    const st = { files, launched: null, presses: [], shots: 0, resets: 0, drops: 0, chips: 0, interrupts: 0, resetHook: null, mark: files.has("wedgiedrive.py") || files.has("wedgiedrive.mpy"), driveOn: files.has("wedgiedrive.py") || files.has("wedgiedrive.mpy") };
    let push = () => {};
    let raw = false, code = "", line = "", cur = null, curName = "";
    const h_bin = () => cmpV(version() || "0", "0.3.15") >= 0;
    let rawPut = null;     // a raw put (0.3.15+) whose bytes are still coming: { msg, buf, got }
    const has = (m) => st.files.has(m + ".py") || st.files.has(m + ".mpy");     // 0.3.14+: the core is compiled
    const slot = () => has("slot") && st.files.has("main.py");
    const wedgie = () => st.files.has("main.py") && (has("menu") || has("slot"));
    // 0.2: the app it runs (null while stopped by Ctrl-C, or with none on it)
    const sealed = () => slot() && cmpV(version() || "0", "0.2.5") >= 0;
    const h_jobs = () => cmpV(version() || "0", "0.3.0") >= 0 && slot();
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
    // its VERSION: the source line, or in a compiled wedgie.mpy the first x.y.z string (the version is its only one)
    const version = () => (st.files.has("wedgie.py") ? (dec.decode(st.files.get("wedgie.py")).match(/VERSION = "([^"]+)"/) || [])[1] || "0.1.0"
      : st.files.has("wedgie.mpy") ? (new TextDecoder("latin1").decode(st.files.get("wedgie.mpy")).match(/\d+\.\d+\.\d+/) || [])[0] || "0.1.0" : null);
    const apps = () => { try { return JSON.parse(dec.decode(st.files.get("apps.json"))); } catch { return []; } };
    const hello = (id, type = "hello") => {
      const v = version(), h = { id, type, name: "wedgie", fw: "wedgie-" + v, version: v, uid, short: uid.slice(-6).toUpperCase(),
        board: machine.includes("RP2350") ? "Pico 2 W" : "RP2040 Pico", cpu: machine.includes("RP2350") ? "RP2350" : "RP2040", micropython: "1.26.1",
        apps: apps().map((a) => a.mod), running: running() };
      if (v >= "0.1.4") Object.assign(h, { carts: apps().map((a) => ({ mod: a.mod, v: a.v })), free: 600000, chip: null });
      if (slot()) h.slot = 1;
      if (sealed()) Object.assign(h, { sealed: true, open: !!st.open });
      if (cmpV(version() || "0", "0.3.0") >= 0 && slot()) h.jobs = cmpV(version(), "0.3.10") >= 0 ? 2 : 1;
      if (cmpV(version() || "0", "0.3.11") >= 0 && slot()) h.ram = 52000;
      if (cmpV(version() || "0", "0.3.15") >= 0 && slot()) h.bin = 4096;     // raw puts (job.py RAW)
      return JSON.stringify(h);
    };
    const answer = (stdout) => push("OK" + stdout + "\x04\x04>");
    async function execRaw(c) {
      if (c === "") { push("OK\r\nMPY: soft reboot\r\nraw REPL; CTRL-B to exit\r\n>"); return; }
      if (c.includes('"@id"')) return answer('@id {"uid":"' + uid + '","machine":"' + machine + '","mp":"1.26.1","files":' + JSON.stringify([...st.files.keys()]) + ',"wifi":' + machine.includes("W") + ',"wedgie":' + JSON.stringify(wedgie() ? version() : null) + "}\r\n");
      if (c.includes("@hashes")) {
        const names = JSON.parse(c.match(/^_n = (\[.*\])$/m)[1]);
        for (const a of apps()) if (Array.isArray(a?.files)) names.push(...a.files);   // a repo app's files, as install.ts asks
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
      if (c.includes('print("@sha"') && (m = c.match(/with open\("([^"]+)", "rb"\)/))) return answer("@sha " + JSON.stringify(await sha(st.files.get(m[1]))) + "\r\n");   // files.ts writeFile's check
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
      // The boot screen and bar a computer puts up while it has the REPL (files.ts busy/progress): every
      // _ins(title, what, p) is kept, so a probe can check the wedgie said what was happening.
      if ((m = c.match(/^_ins\((".*?"), (".*?"), ([\d.]+)\)/))) {
        st.inserting = (st.inserting || 0) + 1;
        (st.screens ||= []).push({ title: JSON.parse(m[1]), what: JSON.parse(m[2]), p: +m[3] });
        return answer("");
      }
      answer("");
    }
    async function onJson(msg) {
      if (!wedgie()) return push(">>> " + JSON.stringify(msg) + "\r\n{'x': 1}\r\n>>> ");
      const id = msg.id, v = version();
      const ok = () => push(JSON.stringify({ id, type: "ok" }) + "\r\n");
      if (msg.type === "hello") return push((st.job ? hello(id).replace(/}$/, `, "job": true${st.job.asked_ms != null ? ', "asked_ms": ' + st.job.asked_ms : ""}}`) : hello(id)) + "\r\n");   // 0.3.12+: a job is running (install mode: job.py's hello)
      if (msg.type === "launch") { if (!apps().some((a) => a.mod === msg.app)) return push(JSON.stringify({ id, type: "error", error: "no such app" }) + "\r\n"); st.launched = msg.app; return ok(); }
      if (msg.type === "home" || msg.type === "stop") { st.launched = null; if (slot()) st.stopped = true; return ok(); }
      if (slot() && msg.type === "ls") return push(JSON.stringify({ id, type: "ls", files: lsAll(msg.path || "/"), free: 600000 }) + "\r\n");
      if (slot() && msg.type === "get") { const k = find(msg.path); return push(k ? chunks(id, st.files.get(k)) : JSON.stringify({ id, type: "error", error: "can't read it" }) + "\r\n"); }
      if (slot() && msg.type === "rm") { rmAll(msg.path); return push(JSON.stringify({ id, type: "ok", free: 600000 }) + "\r\n"); }
      if (msg.type === "press") { st.presses.push(msg.key); return ok(); }
      // 0.3.0+ checked installs (firmware/job.py). The fake trusts the signature; it checks names and hashes.
      if (msg.type === "sums" && h_jobs()) {
        const sums = {};
        for (const n of msg.exists || []) sums[n] = st.files.has(n) ? 1 : null;
        for (const n of msg.names || []) sums[n] = st.files.has(n) ? await sha(st.files.get(n)) : null;
        st.hashed = (st.hashed || 0) + (msg.names || []).length;
        return push(JSON.stringify({ id, type: "sums", sums, apps: apps() }) + "\r\n");
      }
      // 0.3.10+: a job without its release asks at once; the signed list comes after the yes ("release")
      if (msg.type === "release" && st.job && !st.job.listed) {
        const listed = new Map(msg.release.split("\n").slice(2).filter(Boolean).map((l) => l.split("  ").reverse()));
        if ((st.job.m.write || []).some((n) => !listed.has(n))) { st.job = null; return push(JSON.stringify({ id, type: "error", error: "not in the signed list" }) + "\r\n"); }
        st.job.listed = listed;
        return push(JSON.stringify({ id, type: "ok", version: msg.release.split("\n")[1].slice(8) }) + "\r\n");
      }
      if (msg.type === "job" && h_jobs()) {
        st.lateJobs = (st.lateJobs || 0) + (msg.release ? 0 : 1);
        st.hashAtAsk = st.hashed || 0;
        const listed = msg.release ? new Map(msg.release.split("\n").slice(2).filter(Boolean).map((l) => l.split("  ").reverse())) : null;
        if (listed && (msg.write || []).some((n) => !listed.has(n))) return push(JSON.stringify({ id, type: "error", error: "not in the signed list" }) + "\r\n");
        st.asks = (st.asks || 0) + 1; st.jobs = (st.jobs || 0) + 1;
        const p = st.person || {};
        return setTimeout(() => {
          const asked_ms = cmpV(version() || "0", "0.3.11") >= 0 ? 42 : undefined;
          if (p.say === "no") return push(JSON.stringify({ id, type: "refused", asked_ms }) + "\r\n");
          if (cmpV(version() || "0", "0.3.12") >= 0) {     // install mode: the yes restarts it first (slot._to_job),
            st.installMode = { id, m: msg, listed, asked_ms };  // then job.resume says go (before the slot is up)
            st.jobRestarts = (st.jobRestarts || 0) + 1;
            return softReset();
          }
          st.job = { m: msg, listed, got: new Map() };
          push(JSON.stringify({ id, type: "go", asked_ms }) + "\r\n");
        }, p.ms ?? 300);
      }
      if (msg.type === "put" && st.job) {
        if (!st.job.listed) { st.job = null; return push(JSON.stringify({ id, type: "error", error: "the signed list comes first" }) + "\r\n"); }
        const j = st.job, prev = j.got.get(msg.name) || new Uint8Array();
        const add = Uint8Array.from(atob(msg.data || ""), (x) => x.charCodeAt(0)), u = new Uint8Array(prev.length + add.length);
        u.set(prev); u.set(add, prev.length); j.got.set(msg.name, u);
        if (msg.end && (await sha(u)) !== j.listed.get(msg.name)) { st.job = null; return push(JSON.stringify({ id, type: "error", error: "doesn't match the signed list" }) + "\r\n"); }
        return ok();
      }
      if (msg.type === "commit" && st.job) {
        const j = st.job; st.job = null;
        for (const n of j.m.write || []) if (!j.got.has(n) && !(st.files.has(n) && (await sha(st.files.get(n))) === j.listed.get(n))) return push(JSON.stringify({ id, type: "error", error: "not sent: " + n }) + "\r\n");
        for (const [n, u] of j.got) st.files.set(n, u);
        for (const n of j.m.delete || []) st.files.delete(n);
        if (j.m.apps != null) st.files.set("apps.json", text(j.m.apps));
        push(JSON.stringify({ id, type: "done" }) + "\r\n");
        return setTimeout(() => softReset(), 100);
      }
      if (msg.type === "open" && sealed()) {
        if (st.open) return push(JSON.stringify({ id, type: "open" }) + "\r\n");
        st.asks = (st.asks || 0) + 1;
        const p = st.person || {};
        return setTimeout(() => { st.open = p.say !== "no"; push(JSON.stringify({ id, type: st.open ? "open" : "refused" }) + "\r\n"); }, p.ms ?? 300);
      }
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
    function softReset() {
      st.resets++; st.launched = null; st.stopped = false; st.open = false;
      const drop = has("wedgiedrive") && (!st.mark || st.driveOn);
      st.driveOn = has("wedgiedrive") && !st.mark;    // the new boot.py adds it only without a mark
      st.mark = has("wedgiedrive");
      const im = st.installMode; st.installMode = null;
      if (drop && st.resetHook) {
        if (im) {                       // job.resume runs anyway; its go goes to a port the host lost
          st.lostGo = (st.lostGo || 0) + 1;
          st.job = { m: im.m, listed: im.listed, got: new Map(), asked_ms: im.asked_ms };
        }
        st.drops++; st.resetHook(); return;
      }
      if (im) return setTimeout(() => { st.job = { m: im.m, listed: im.listed, got: new Map() }; st.job.asked_ms = im.asked_ms; push(JSON.stringify({ id: im.id, type: "go", asked_ms: im.asked_ms }) + "\r\n"); }, 300);
      if (wedgie()) setTimeout(() => push(hello(null, "ready") + "\r\n"), 300);
    }
    function streams() {
      const readable = new ReadableStream({ start(c) { push = (s) => { try { c.enqueue(enc.encode(s)); } catch {} }; st.fail = (e) => { try { c.error(e); } catch {} }; } });
      const writable = new WritableStream({ write(chunk) {
        if (st.dead) return;               // no MicroPython on it: nothing ever answers
        // byte by byte: a raw put's bytes are taken as they are; the rest is text (read as latin1, decoded
        // as UTF-8 once a line or a REPL block is whole)
        const u8 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
        for (const b of chunk) {
          if (rawPut) {
            rawPut.buf[rawPut.got++] = b;
            if (rawPut.got === rawPut.buf.length) {
              const p = rawPut; rawPut = null;
              if (p.msg.refuse) push(JSON.stringify({ id: p.msg.id, type: "error", error: "no raw puts here" }) + "\r\n");
              else onJson({ ...p.msg, data: btoa(String.fromCharCode(...p.buf)) });
            }
            continue;
          }
          const ch = String.fromCharCode(b);
          if (ch === "\x03" && sealed() && !st.open && !raw) { line = ""; st.sealedBytes = (st.sealedBytes || 0) + 1; continue; }
          if (ch === "\x03") { raw = false; line = ""; st.interrupts++; st.stopped = true; continue; }
          if (ch === "\x01") { raw = true; code = ""; push("raw REPL; CTRL-B to exit\r\n>"); continue; }
          if (ch === "\x02") { raw = false; continue; }
          if (!raw) {
            if (ch === "\x04") { softReset(); continue; }
            // Repl.leave({ reset: false }) types exec(open("main.py").read()) + CR: the launcher starts again, home
            if (ch === "\r") { if (line.startsWith("exec(open(")) { line = ""; st.launched = null; st.stopped = false; st.open = false; st.relaunches = (st.relaunches || 0) + 1; } continue; }
            if (ch === "\n") {
              const l = dec.decode(u8(line)); line = "";
              if (!l.startsWith("{")) continue;
              let m; try { m = JSON.parse(l); } catch { continue; }
              if (m.type === "put" && typeof m.n === "number") {
                if (!(st.job && slot() && h_bin())) m = { ...m, refuse: true };    // its bytes are still taken off the line
                else st.rawPuts = (st.rawPuts || 0) + 1;
                if (m.n > 0) { rawPut = { msg: m, buf: new Uint8Array(m.n), got: 0 }; continue; }
                if (m.refuse) { push(JSON.stringify({ id: m.id, type: "error", error: "no raw puts here" }) + "\r\n"); continue; }
                m = { ...m, data: "" };
              }
              onJson(m); continue;
            }
            line += ch; continue;
          }
          if (ch !== "\x04") { code += ch; continue; }
          const c = dec.decode(u8(code)); code = ""; execRaw(c);
        }
      } });
      return { readable, writable };
    }
    let cur2 = streams();
    const port = { getInfo: () => ({ usbVendorId: 0x2e8a, usbProductId: 5 }), async open() { if (st.dropped) throw new DOMException("Failed to open serial port.", "NetworkError"); cur2 = streams(); }, async close() {},
      get readable() { return cur2.readable; }, get writable() { return cur2.writable; }, _st: st };
    return port;
  }
  const ports = specs.map((b) => {
    const p = board(b.uid, b.machine, new Map(Object.entries(b.files || {}).map(([k, v]) => [k, v === 1 ? new Uint8Array([1]) : text(v)])));
    if (b.noMp) p._st.dead = true;
    p._st.chip = b.chip;
    p._st.person = b.person;
    return p;
  });
  window.__ports = ports;
  const t = new EventTarget();
  const plugged = new Set(ports);
  window.__plug = (i, on) => { const p = ports[i]; p._st.dropped = !on; if (on && (p._st.files.has("wedgiedrive.py") || p._st.files.has("wedgiedrive.mpy"))) p._st.mark = p._st.driveOn = true; if (on) { plugged.add(p); t.dispatchEvent(Object.assign(new Event("connect"), { port: p })); } else { plugged.delete(p); t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })); } };
  for (const p of ports) p._st.resetHook = () => {
    p._st.dropped = true;
    p._st.fail?.(new DOMException("The device has been lost.", "NetworkError"));   // Chrome errors the open port's reads
    setTimeout(() => t.dispatchEvent(Object.assign(new Event("disconnect"), { port: p })), 1500);   // macOS tells the page late
    setTimeout(() => { p._st.dropped = false; t.dispatchEvent(Object.assign(new Event("connect"), { port: p })); }, 5000);
  };
  Object.defineProperty(navigator, "serial", { value: Object.assign(t, { getPorts: async () => ports.filter((p) => plugged.has(p)), requestPort: async () => ports[0] }) });
}
