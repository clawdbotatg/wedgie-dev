// /test: the test bench. Plug a wedgie in, do what its own screen says, unplug. Nothing on this page
// needs touching once the computer has the test-bench profile (Chrome then lets the page use every
// Pico without asking). Every unit takes the same path from scratch:
//  0. a used one (anything answering on serial) is told to reboot into BOOTSEL;
//  1. BOOTSEL (a blank Pico boots there): wipe + plain MicroPython over WebUSB (picoboot.ts);
//  2. board facts (bench.py); a board with the Pico W's WiFi chip goes round once more for the W build;
//  3. the wedgie firmware (before the buttons, so unplugging at the end is safe; its chip drivers);
//  4. the chip, used without locking it: ATECC608 hashes on-chip, Trust M signs and its certificate
//     chains to Infineon (chipcheck.ts);
//  5. on its screen: each button alone, in order; then each again, filling the screen with its color.
import * as W from "../serial/wedgies";
import type { Repl } from "../serial/repl";
import { install } from "../serial/install";
import { checkChip } from "../serial/chipcheck";
import { usbSupported, bootDevices, isBoot, pickBoot, flashMicroPython, BOOT_PIDS } from "../serial/picoboot";

type State = "waiting" | "running" | "pass" | "fail" | "skip";
const ORDER = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
const NAME: Record<string, string> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT", press: "IN", A: "A", B: "B", X: "X", Y: "Y" };
const ICON: Record<State, string> = { waiting: "", running: "…", pass: "✓", fail: "✗", skip: "–" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const RAW = "raw REPL; CTRL-B to exit\r\n>";
const BOARD = 0, FW = 1, CHIP = 2, BUTTONS = 3, COLORS = 4;
let bench: Promise<string> | null = null;
const benchPy = () => (bench ??= fetch("/device/bench.py").then((r) => { if (!r.ok) throw new Error("bench.py missing"); return r.text(); }));

function boardName(b: any) {
  const two = b.cpu === "RP2350";
  if (b.wifi) return two ? "Pico 2 W" : "Pico W";
  if (b.vbus) return two ? "Pico 2" : "Pico";
  return `${b.cpu} board (not a Raspberry Pi Pico)`;
}

export function test(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Wedgie test bench</h1>
    <div class="test-status">
      <div class="status-text" id="t-text">Plug in a wedgie</div>
      <div class="status-detail" id="t-detail">New or used. Then follow its screen.</div>
      <div class="meter" id="t-meter" hidden><div class="meter-track"><div class="meter-fill"></div></div></div>
    </div>
    <div class="test-grid" id="t-grid"></div>
    <div class="test-actions" id="t-actions"></div>
    <div class="test-id" id="t-id"></div>
    <dl class="kv test-facts" id="t-facts" hidden></dl>
    <p class="fine">Anything plugged in here gets wiped and set up fresh.</p>
    <div class="test-setup card">
      <h3>First time on this computer?</h3>
      <p>Chrome asks before a page can use each new Pico. The test-bench profile tells it wedgie.dev may, so the bench runs hands-off.</p>
      <p><b>Linux</b> (Omarchy, Arch, Ubuntu): run this once, then restart the browser.</p>
      <pre class="recess test-cmd">curl -fsSL https://wedgie.dev/bench-linux.sh | sudo sh</pre>
      <p><b>Mac:</b> <a href="/wedgie-test.mobileconfig" download>get the profile</a>, open it, then System Settings → Privacy &amp; Security → Profiles → Install. Restart Chrome.</p>
      <p class="fine">Check it worked: chrome://policy lists <span class="mono">WebUsbAllowDevicesForUrls</span>.</p>
    </div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const text = $("t-text"), detail = $("t-detail"), grid = $("t-grid"), actions = $("t-actions"), facts = $("t-facts"), idEl = $("t-id");
  const meter = $("t-meter"), fill = meter.querySelector<HTMLElement>(".meter-fill")!;

  const tests: { name: string; state: State; detail: string }[] =
    ["Board", "Firmware", "Chip", "Buttons", "Colors"].map((name) => ({ name, state: "waiting", detail: "" }));
  const draw = () => {
    grid.innerHTML = tests.map((t) =>
      `<div class="test-card ${t.state}"><div class="test-icon">${ICON[t.state]}</div><div class="test-name">${t.name}</div><div class="test-detail">${esc(t.detail)}</div></div>`).join("");
  };
  const set = (i: number, state: State, d = "") => { tests[i].state = state; tests[i].detail = d; draw(); };
  let factRows: [string, string][] = [];
  const reset = () => { tests.forEach((_, i) => set(i, "waiting")); facts.hidden = true; factRows = []; idEl.textContent = ""; };
  const status = (t: string, d: string, tone: "" | "good" | "bad" = "") => {
    text.textContent = t; detail.textContent = d;
    main.querySelector(".test-status")!.className = `test-status ${tone}`;
  };
  const progress = (p: number | null) => { meter.hidden = p === null; if (p !== null) fill.style.width = `${8 + 92 * p}%`; };
  const buttons = (html: string) => (actions.innerHTML = html);
  const fact = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    factRows = factRows.filter((r) => r[0] !== k).concat([[k, String(v)]]);
    facts.hidden = false;
    facts.innerHTML = factRows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join("");
  };
  const idLine = (uid: string, name: string) => {
    idEl.innerHTML = uid ? `<span class="mono">${esc(uid.slice(-6).toUpperCase())}</span> · ${esc(name)}` : "";
  };

  let busy = false;
  let flashedAt = 0;              // we just put MicroPython on a unit: the next serial board is it
  let wantWifi = false;           // the next flash is the W build (the unit has the WiFi chip)
  let waitBoot = 0;               // a unit was told to reboot into BOOTSEL
  const tested = new Set<number>();
  // A finished unit reboots into its firmware and its USB drive re-plugs it: the same board ID within
  // 20 s of its run is that, not a new unit to wipe.
  const ended = new Map<string, number>();
  const done = (w: W.Wedgie) => tested.has(w.key) || (!!w.uid && Date.now() - (ended.get(w.uid) || 0) < 20000);
  const flashed = new WeakSet<USBDevice>();

  // ---- a used one: back to BOOTSEL ------------------------------------------------------------------
  function toBoot(w: W.Wedgie) {
    tested.add(w.key);
    waitBoot = Date.now();
    status("Restarting it into boot mode…", "To wipe it and set it up fresh.");
    buttons("");
    W.withRepl(w, async (r) => {
      await r.write("\r\x03\x03");
      await new Promise((res) => setTimeout(res, 150));
      await r.write("\x01");
      await r.waitFor(RAW, 3000);
      await r.write("import machine\nmachine.bootloader()\x04");
      await new Promise((res) => setTimeout(res, 300));
    }).catch(() => {});
    // Without the profile nothing shows up by itself.
    setTimeout(() => { if (!busy && waitBoot && Date.now() - waitBoot >= 8000) needPick("boot"); }, 8000);
  }
  function needPick(what: "boot" | "serial") {
    status("Chrome needs a tap", "This computer doesn't have the test-bench profile yet (below).");
    buttons(`<button class="btn btn-green" id="t-pick">Pick it</button>
      <p class="fine">It's called <b>${what === "boot" ? "RP2 Boot or RP2350 Boot" : "Board in FS mode"}</b>.</p>`);
    $("t-pick").onclick = () => (what === "boot" ? pickBoot().then(() => pick()) : W.connectNew()).catch(() => {});
  }

  // ---- wipe + MicroPython ---------------------------------------------------------------------------
  async function flash(dev: USBDevice) {
    busy = true;
    flashed.add(dev);
    waitBoot = 0;
    const wifi = wantWifi;
    wantWifi = false;
    if (!wifi) reset();
    set(BOARD, "running", `${BOOT_PIDS[dev.productId]}: ${wifi ? "WiFi MicroPython" : "wiping, MicroPython"}`);
    status(wifi ? "It has WiFi: WiFi MicroPython going on…" : "Wiping it, putting MicroPython on…", "Don't unplug it.");
    buttons("");
    progress(0);
    try {
      await flashMicroPython(dev, progress, wifi);
      flashedAt = Date.now();
      status("Restarting it…", "A few seconds.");
      setTimeout(() => { if (!busy && flashedAt && !W.wedgies().some((w) => w.state !== "error" && !done(w))) needPick("serial"); }, 8000);
    } catch (e: any) {
      set(BOARD, "fail", e?.message || String(e));
      status("FAIL", "Couldn't put MicroPython on. Unplug it, hold BOOTSEL, plug it back in.", "bad");
    }
    progress(null);
    busy = false;
  }

  // ---- the bench ------------------------------------------------------------------------------------
  async function run(w: W.Wedgie) {
    busy = true;
    tested.add(w.key);
    flashedAt = 0;
    status("Testing…", "Don't unplug it.");
    buttons("");
    let step = BOARD, gone = false;
    const phaseAt: Record<number, number> = { 1: -1, 2: -1 };
    const combos: string[] = [];
    const buttonsLine = () => (combos.length ? `All 9 alone · ${combos.join(", ")}` : "All 9, each alone");
    try {
      await W.withRepl(w, async (r) => {
        try {
          await r.enter();
          await r.exec(await W.probe(), 10000);
          await r.exec(await benchPy(), 10000);

          let b: any = null;
          r.onLine = (t, v) => { if (t === "board") b = v; };
          await r.exec("board()", 15000);
          if (!b) throw new Error("it didn't say what it is");
          const name = boardName(b);
          fact("Board", name); fact("Board ID", b.uid); fact("Processor", `${b.cpu} · ${b.mhz} MHz`);
          fact("MicroPython", `${b.mp}${b.wbuild ? " (WiFi build)" : ""}`); fact("WiFi MAC", b.mac);
          fact("Storage", `${Math.round(b.fs / 1024)} KB files · ${Math.round(b.heap / 1024)} KB RAM`);
          idLine(b.uid, name);
          if (b.wifi && !b.wbuild) {
            wantWifi = true; gone = true;
            set(BOARD, "running", `${name}: getting the WiFi MicroPython`);
            await r.write("import machine\nmachine.bootloader()\x04");
            return;
          }
          if (b.wbuild && !b.wifi) fact("WiFi", `didn't start: ${b.wifiError || "?"}`);
          set(BOARD, "pass", `${name} · ${b.uid.slice(-6).toUpperCase()}`); step = FW;

          set(FW, "running", "Installing");
          status("Installing the wedgie firmware…", "Don't unplug it.");
          progress(0);
          const got = await install(r, (p) => progress(p));
          progress(null);
          set(FW, "pass", `wedgie ${got.version}`); step = CHIP;
          await r.exec(await W.probe(), 10000);        // install restarted it: load the bench again
          await r.exec(await benchPy(), 10000);

          set(CHIP, "running", "Asking it over I2C");
          status("Testing the chip…", "Using it, not locking it.");
          let c = await chip(r);
          if (c.pass) {
            set(CHIP, "running", c.kind === "atecc" ? "Hashing on the chip" : "Signing, checking with Infineon");
            let cw: any = null;
            r.onLine = (t, v) => { if (t === "chipwork") cw = v; };
            await r.exec(`chipwork(${JSON.stringify(c.kind)})`, 30000);
            const k = cw ? await checkChip(cw).catch((e) => ({ pass: false, detail: `check failed: ${e?.message || e}`, facts: [] as [string, string][] })) : { pass: false, detail: "No answer from the chip test", facts: [] as [string, string][] };
            k.facts.forEach(([a, b]) => fact(a, b));
            c = { ...c, pass: k.pass, detail: k.detail, short: k.pass ? c.short : "CHIP TEST" };
          }
          set(CHIP, c.pass ? "pass" : "fail", c.detail); step = BUTTONS;

          status("Follow its screen", "Each button on its own, in order. Then each again for its color.");
          r.onLine = (t, v) => {
            if (t === "prompt") {
              if (v.phase === 2 && tests[BUTTONS].state === "running") { set(BUTTONS, "pass", buttonsLine()); step = COLORS; }
              phaseAt[v.phase] = ORDER.indexOf(v.key);
              set(v.phase === 1 ? BUTTONS : COLORS, "running", `Press ${NAME[v.key]} (${phaseAt[v.phase] + 1}/9)`);
            }
            if (t === "combo") combos.push(`${NAME[v.key]} came with ${v.with.map((k: string) => NAME[k]).join("+")}`);
            if (t === "stuck") combos.push(`${v.map((k: string) => NAME[k]).join("+")} held down`);
            if (t === "combo" || t === "stuck") {
              const i = step === COLORS ? COLORS : BUTTONS;
              set(i, "running", `${tests[i].detail.split(" · ")[0]} · ${combos[combos.length - 1]}`);
            }
          };
          await r.exec(`bench(${c.pass ? "True" : "False"}, ${JSON.stringify(c.short)})`, 30 * 60 * 1000);
          if (tests[BUTTONS].state === "running") set(BUTTONS, "pass", buttonsLine());
          set(COLORS, "pass", "All 9 shown"); step = COLORS + 1;
          const failed = tests.filter((t) => t.state !== "pass").map((t) => t.name.toUpperCase());
          await r.exec(`verdict(${failed.length ? "False" : "True"}, ${JSON.stringify(failed.join(" "))})`, 10000);
        } finally {
          progress(null);
          if (!gone) await r.leave();   // it boots into the wedgie firmware
        }
      });
    } catch (e: any) {
      const m = e?.message || String(e);
      if (step <= COLORS && tests[step].state !== "pass") {
        const at = step === BUTTONS ? phaseAt[1] : step === COLORS ? phaseAt[2] : -1;
        set(step, "fail", /unplugged/.test(m) && at >= 0 ? `Unplugged at ${NAME[ORDER[at]]}` : m);
      }
    }
    busy = false;
    if (gone) { waitBoot = Date.now(); pick(); return; }
    for (let i = step + 1; i <= COLORS; i++) if (tests[i].state === "waiting") set(i, "skip", "");
    const failed = tests.filter((t) => t.state !== "pass").map((t) => t.name);
    if (failed.length) status("FAIL", `${failed.join(", ")}. Unplug it.`, "bad");
    else status("PASS", `${w.short} is ready. Unplug it.`, "good");
    if (w.uid) ended.set(w.uid, Date.now());
    pick();
  }

  async function chip(r: Repl) {
    let c: any = null;
    r.onLine = (t, v) => { if (t === "chip") c = v; };
    await r.exec("chip()", 20000);
    if (!c) return { pass: false, detail: "No answer from the chip check", short: "NO ANSWER", kind: "" };
    fact("I2C lines", `SDA ${c.lines.sda ? "pulled up" : "no pull-up"}, SCL ${c.lines.scl ? "pulled up" : "no pull-up"}`);
    fact("I2C answered at", c.scan.length ? c.scan.join(", ") : "nothing");
    // A Trust M acks its address even when the wiring is half right; only its UID proves it talks.
    const ok = (c.found || []).filter((f: any) => !f.error && (f.type !== "OPTIGA Trust M" || f.uid));
    for (const f of ok) {
      if (f.type === "ATECC608") {
        fact("Chip", `ATECC608 · revision ${f.revision}`); fact("Chip serial", f.serial);
        fact("Chip state", `config ${f.configLocked ? "locked" : "unlocked (fresh)"}, data ${f.dataLocked ? "locked" : "unlocked"}`);
      } else { fact("Chip", "OPTIGA Trust M"); fact("Chip UID", f.uid); }
    }
    if (ok.length) {
      const f = ok[0];
      return f.type === "ATECC608" ? { pass: true, detail: `ATECC608 ${f.serial.slice(-6)}`, short: "ATECC608", kind: "atecc" } : { pass: true, detail: "Trust M, ID read", short: "TRUST M", kind: "trustm" };
    }
    if ((c.found || []).some((f: any) => f.type === "OPTIGA Trust M")) return { pass: false, detail: "Trust M there but won't give its ID. Check the wires.", short: "TRUST M NO ID", kind: "" };
    if (!c.lines.sda || !c.lines.scl) return { pass: false, detail: "No power on SDA/SCL. Check the wires.", short: "NO POWER", kind: "" };
    return { pass: false, detail: "Lines have power but no chip answered. A wire is swapped.", short: "NO ANSWER", kind: "" };
  }

  // ---- what to do next ------------------------------------------------------------------------------
  async function pick() {
    if (busy) return;
    const boot = (await bootDevices()).find((d) => !flashed.has(d));
    if (busy) return;
    if (boot) return void flash(boot);
    const ws = W.wedgies();
    for (const k of [...tested]) if (!ws.some((w) => w.key === k)) tested.delete(k);
    const next = ws.find((w) => w.state === "ready" && !done(w));
    if (next) {
      if (flashedAt && Date.now() - flashedAt < 90000) return void run(next);
      reset();
      idLine(next.uid || "", next.board || "");
      return void toBoot(next);
    }
    const bad = ws.find((w) => w.state === "error" && !done(w));
    if (bad && /No MicroPython/.test(bad.error || "")) {
      // New boards often ship with a maker's demo on them. Opening the port at 1200 baud is the
      // standard "reboot into BOOTSEL" knock (pico-sdk, CircuitPython and Arduino builds all obey it).
      tested.add(bad.key);
      reset();
      waitBoot = Date.now();
      status("Restarting it into boot mode…", "It came with something else on it. That gets wiped.");
      buttons("");
      try { await bad.port.open({ baudRate: 1200 }); await bad.port.close(); } catch {}
      setTimeout(() => {
        if (!busy && waitBoot && Date.now() - waitBoot >= 8000) {
          needPick("boot");
          status("Still waiting for boot mode", "If Pick it doesn't list it: unplug it, hold BOOTSEL, plug it back in.");
        }
      }, 8000);
      return;
    }
    if (bad) {
      tested.add(bad.key);
      reset();
      const noMp = false;
      status("Can't talk to it", noMp ? "Something other than MicroPython is on it. Unplug it, hold BOOTSEL, plug it back in." : bad.error || "", "bad");
      buttons(`<button class="btn" id="t-retry">Try again</button>`);
      $("t-retry").onclick = () => { tested.delete(bad.key); W.reidentify(bad); };
      return;
    }
    const justEnded = Date.now() - Math.max(0, ...ended.values()) < 20000;
    if (ws.some((w) => w.state === "identifying")) {
      if (!justEnded && !flashedAt && !waitBoot) { status("Found one…", "Checking what's on it."); buttons(""); }
      return;
    }
    if (!flashedAt && !waitBoot && !actions.innerHTML && !justEnded) idle();
  }
  // Without the profile, the first sight of a unit needs a tap.
  function idle() {
    buttons(`<p class="fine">Plugged in and nothing happens? No profile yet: <a href="#" id="t-new">pick a new Pico</a> · <a href="#" id="t-used">pick a used one</a></p>`);
    $("t-new").onclick = (e) => { e.preventDefault(); pickBoot().then(() => pick(), () => {}); };
    $("t-used").onclick = (e) => { e.preventDefault(); W.connectNew().catch(() => {}); };
  }

  draw();
  if (!W.supported() || !usbSupported()) {
    status("Can't see USB here", "Open wedgie.dev/test in Chrome or Edge on a computer.", "bad");
    return;
  }
  navigator.usb.addEventListener("connect", (e) => { if (isBoot((e as USBConnectionEvent).device)) setTimeout(pick, 300); });
  W.onChange(pick);
  W.arm(); // the bench is for people with a board in hand
  W.start();
  idle();
  pick();
}
