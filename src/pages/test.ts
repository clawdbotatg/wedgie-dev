// /test: the assembly line, from a Pico out of the box (or a wedgie used for weeks) to a finished
// wedgie. Every unit takes the same path from scratch:
//  0. a used one (anything that answers on serial) is told to reboot into BOOTSEL;
//  1. in BOOTSEL (a blank Pico boots there): wipe + MicroPython over WebUSB (picoboot.ts), reboot;
//  2. on bare MicroPython: chip, screen (the tester says yes/no; the Pico can't see a panel), buttons;
//  3. all good: the wedgie firmware goes on last, so its USB drive can't drop the link mid-test.
// Each unit runs once per plug-in; the last result stays up until the next unit starts.
import * as W from "../serial/wedgies";
import type { Repl } from "../serial/repl";
import { install, firmwareManifest } from "../serial/install";
import { usbSupported, bootDevices, isBoot, pickBoot, flashMicroPython, BOOT_PIDS } from "../serial/picoboot";

type State = "waiting" | "running" | "pass" | "fail" | "skip";
type Result = { pass: boolean; detail: string };

const KEYS = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
const KEYS_TIMEOUT_S = 90;
const ICON: Record<State, string> = { waiting: "", running: "…", pass: "✓", fail: "✗", skip: "–" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const MP = 0, CHIP = 1, SCREEN = 2, BUTTONS = 3, FW = 4;

export function test(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Wedgie QA</h1>
    <div class="test-status">
      <div class="status-text" id="t-text">Plug in a wedgie</div>
      <div class="status-detail" id="t-detail">A new Pico is fine. Everything goes on from here.</div>
      <div class="meter" id="t-meter" hidden><div class="meter-track"><div class="meter-fill"></div></div></div>
    </div>
    <div class="test-grid" id="t-grid"></div>
    <div class="test-ask" id="t-ask" hidden>
      <p>Did its screen flash <b>red, green, blue</b>, edge to edge?</p>
      <div class="row center"><button class="btn btn-green" data-ans="1">Yes</button><button class="btn" data-ans="0">No</button></div>
    </div>
    <div class="test-actions" id="t-actions"></div>
    <div class="test-id" id="t-id" hidden></div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const text = $("t-text"), detail = $("t-detail"), grid = $("t-grid"), ask = $("t-ask"), actions = $("t-actions"), idEl = $("t-id");
  const meter = $("t-meter"), fill = meter.querySelector<HTMLElement>(".meter-fill")!;

  const tests: { name: string; state: State; detail: string }[] =
    ["MicroPython", "Chip", "Screen", "Buttons", "Firmware"].map((name) => ({ name, state: "waiting", detail: "" }));
  const draw = () => {
    grid.innerHTML = tests.map((t) =>
      `<div class="test-card ${t.state}"><div class="test-icon">${ICON[t.state]}</div><div class="test-name">${t.name}</div><div class="test-detail">${esc(t.detail)}</div></div>`).join("");
  };
  const set = (i: number, state: State, d = "") => { tests[i].state = state; tests[i].detail = d; draw(); };
  const reset = () => tests.forEach((_, i) => set(i, "waiting"));
  const status = (t: string, d: string, tone: "" | "good" | "bad" = "") => {
    text.textContent = t; detail.textContent = d;
    main.querySelector(".test-status")!.className = `test-status ${tone}`;
  };
  const progress = (p: number | null) => {
    meter.hidden = p === null;
    if (p !== null) fill.style.width = `${8 + 92 * p}%`;
  };
  const buttons = (html: string) => (actions.innerHTML = html);

  let busy = false;
  let flashedAt = 0;                  // a unit we just flashed: its serial port is on the way
  const tested = new Set<number>();   // wedgie keys already run this plug-in
  // A finished unit reboots into its firmware and re-plugs its USB, so it shows up again as a new
  // port. The same board ID within 15 s of its run is that, not a new unit.
  const ended = new Map<string, number>();
  const done = (w: W.Wedgie) => tested.has(w.key) || (!!w.uid && Date.now() - (ended.get(w.uid) || 0) < 15000);
  const flashed = new WeakSet<USBDevice>();

  // ---- 1. MicroPython onto a BOOTSEL Pico -----------------------------------------------------------
  async function flash(dev: USBDevice) {
    busy = true;
    flashed.add(dev);
    reset();
    idEl.hidden = true;
    set(MP, "running", `${BOOT_PIDS[dev.productId]}, blank`);
    status("Putting MicroPython on it…", "Don't unplug it.");
    buttons("");
    progress(0);
    try {
      await flashMicroPython(dev, progress);
      set(MP, "pass", "Flashed");
      flashedAt = Date.now();
      status("Restarting it…", "It comes back on its own in a few seconds.");
      setTimeout(() => { if (!busy && flashedAt && !W.wedgies().some((w) => w.state !== "error" && !done(w))) askSerial(); }, 5000);
    } catch (e: any) {
      set(MP, "fail", e?.message || String(e));
      status("FAIL", "MicroPython didn't go on. Unplug it, hold BOOTSEL, plug it back in.", "bad");
    }
    progress(null);
    busy = false;
  }
  // No policy grants the new serial port, so the browser has to be told once which one it is.
  function askSerial() {
    status("Pick it once more", "The browser needs to be told it's allowed to talk to it.");
    buttons(`<button class="btn btn-green" id="t-serial">Pick it</button><p class="fine">It's called <b>Board in FS mode</b> now.</p>`);
    $("t-serial").onclick = () => W.connectNew().catch(() => {});
  }

  // ---- 0. a used one: back to BOOTSEL -------------------------------------------------------------
  function used(w: W.Wedgie) {
    reset();
    idEl.hidden = false;
    idEl.innerHTML = `<span class="mono">${esc(w.short || "??????")}</span> · ${esc(w.board || "")} · ${esc(w.firmware || "")}`;
    status("This one's been used", "It gets wiped and set up from scratch, like a new one.");
    buttons(`<button class="btn btn-green" id="t-wipe">Wipe and test</button>`);
    $("t-wipe").onclick = () => wipe(w);
  }
  // The chooser opens right away (it needs this tap) and lists the Pico once it's in boot mode.
  function wipe(w: W.Wedgie) {
    tested.add(w.key);
    const chooser = pickBoot();
    status("Restarting it into boot mode…", "Pick it in the list when it shows up.");
    buttons(`<p class="fine">It's called <b>RP2 Boot</b> or <b>RP2350 Boot</b>.</p>`);
    W.withRepl(w, async (r) => {
      await r.write("\r\x03\x03");
      await new Promise((res) => setTimeout(res, 150));
      await r.write("\x01");
      await r.waitFor("raw REPL; CTRL-B to exit\r\n>", 3000);
      await r.write("import machine\nmachine.bootloader()\x04");
      await new Promise((res) => setTimeout(res, 300));
    }).catch(() => {});
    chooser.then(() => pick(), () => { if (!busy) { status("Pick it to go on", "Unplug it, hold BOOTSEL, plug it back in if it's not in the list."); idle(); } });
  }

  // ---- 2 + 3. test it, then the wedgie firmware ---------------------------------------------------
  async function run(w: W.Wedgie) {
    busy = true;
    tested.add(w.key);
    const justFlashed = flashedAt > 0;
    flashedAt = 0;
    if (!justFlashed) reset();
    set(MP, "pass", `${w.micropython || "on it"}${justFlashed ? ", flashed" : ""}`);
    idEl.hidden = false;
    idEl.innerHTML = `<span class="mono">${esc(w.short || "??????")}</span> · ${esc(w.board || "unknown board")}`;
    status("Testing…", "Don't unplug it.");
    buttons("");
    let step = CHIP;
    try {
      await W.withRepl(w, async (r) => {
        try {
          await r.enter();
          await r.exec(await W.probe(), 10000);
          set(CHIP, "running", "Looking for it");
          let res = await chip(r, w); set(CHIP, res.pass ? "pass" : "fail", res.detail); step = SCREEN;
          set(SCREEN, "running", "Look at its screen");
          res = await screen(r); set(SCREEN, res.pass ? "pass" : "fail", res.detail); step = BUTTONS;
          set(BUTTONS, "running", "Press every button");
          res = await keys(r, (left) => set(BUTTONS, "running", left.length ? `Left: ${left.join(" ")}` : "Done"));
          set(BUTTONS, res.pass ? "pass" : "fail", res.detail); step = FW;
          if (tests.slice(CHIP, FW).some((t) => t.state !== "pass")) { set(FW, "skip", "Fix it first"); return; }
          const m = await firmwareManifest();
          if (w.kind === "wedgie" && w.version === m.version) { set(FW, "pass", `wedgie ${m.version}, already`); return; }
          set(FW, "running", "Installing");
          status("Installing the wedgie firmware…", "Don't unplug it.");
          progress(0);
          const got = await install(r, (p) => progress(p));
          w.kind = "wedgie"; w.version = got.version;
          set(FW, "pass", `wedgie ${got.version}`);
        } finally {
          ask.hidden = true;
          progress(null);
          await r.leave();   // soft reset: it boots into what's on it now
        }
      });
    } catch (e: any) {
      if (tests[step].state !== "pass") set(step, "fail", e?.message || String(e));
    }
    for (let i = step + 1; i <= FW; i++) if (tests[i].state === "waiting") set(i, "skip", "");
    const failed = tests.filter((t) => t.state === "fail" || (t.state !== "pass" && t.name !== "Firmware")).map((t) => t.name);
    if (failed.length) status("FAIL", `${failed.join(", ")} failed`, "bad");
    else status("PASS", `${w.short} is ready to ship`, "good");
    buttons(`<button class="btn" id="t-again">Wipe and test it again</button><p class="fine">Or unplug it and plug in the next one.</p>`);
    $("t-again").onclick = () => {
      const now = W.wedgies().find((x) => x.uid === w.uid && x.state === "ready");
      if (!busy && now) wipe(now);
    };
    if (w.uid) ended.set(w.uid, Date.now());
    busy = false;
    pick();
  }

  async function chip(r: Repl, w: W.Wedgie): Promise<Result> {
    let c: any = null;
    r.onLine = (t, v) => { if (t === "chip") c = v; };
    await r.exec("chip()", 20000);
    if (!c) return { pass: false, detail: "No answer from the chip check" };
    // A Trust M acks its address even when the wiring is half right; only its UID proves it talks.
    const ok = (c.found || []).filter((f: any) => !f.error && (f.type !== "OPTIGA Trust M" || f.uid));
    if (ok.length) {
      w.chip = ok[0];
      return { pass: true, detail: ok.map((f: any) => f.type === "ATECC608" ? `ATECC608 ${f.serial.slice(-6)}` : "Trust M, ID read").join(", ") };
    }
    if ((c.found || []).some((f: any) => f.type === "OPTIGA Trust M")) return { pass: false, detail: "Trust M there but won't give its ID. Check the wires." };
    if (!c.lines.sda || !c.lines.scl) return { pass: false, detail: "No power on SDA/SCL. Check the wires." };
    return { pass: false, detail: "Lines have power but no chip answered. A wire is swapped." };
  }

  // Cycle red/green/blue on the device until the person answers.
  async function screen(r: Repl): Promise<Result> {
    await r.exec("screen()", 10000);
    let answer: boolean | null = null;
    ask.hidden = false;
    ask.querySelectorAll<HTMLButtonElement>("[data-ans]").forEach((b) => (b.onclick = () => (answer = b.dataset.ans === "1")));
    for (let i = 0; answer === null; i++) {
      await r.exec(`screen("${["red", "green", "blue"][i % 3]}")`, 5000);
      await new Promise((res) => setTimeout(res, 600));
    }
    ask.hidden = true;
    return answer ? { pass: true, detail: "Red, green, blue" } : { pass: false, detail: "Colors wrong. Reseat the hat." };
  }

  async function keys(r: Repl, onLeft: (left: string[]) => void): Promise<Result> {
    const seen = new Set<string>();
    let stuck: string[] = [];
    r.onLine = (t, v) => {
      if (t === "stuck") { stuck = v; if (stuck.length) r.interrupt(); }   // held from the start: no point waiting
      if (t === "key" && !v.down) { seen.add(v.key); onLeft(KEYS.filter((k) => !seen.has(k))); }
    };
    onLeft(KEYS);
    try { await r.exec(`keys(${KEYS_TIMEOUT_S})`, (KEYS_TIMEOUT_S + 10) * 1000); } catch {}   // Ctrl-C shows up as an error
    if (stuck.length) return { pass: false, detail: `Stuck down: ${stuck.join(" ")}` };
    const miss = KEYS.filter((k) => !seen.has(k));
    return miss.length ? { pass: false, detail: `Never pressed: ${miss.join(" ")}` } : { pass: true, detail: "All 9 work" };
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
      if (!actions.querySelector("#t-wipe")) used(next);
      return;
    }
    const bad = ws.find((w) => w.state === "error" && !done(w));
    if (bad) {
      tested.add(bad.key);
      reset();
      const noMp = /No MicroPython/.test(bad.error || "");
      status("FAIL", noMp ? "Something other than MicroPython is on it. Unplug it, hold BOOTSEL, plug it back in." : bad.error || "Can't talk to it", "bad");
      buttons(`<button class="btn" id="t-retry">Try again</button>`);
      $("t-retry").onclick = () => { tested.delete(bad.key); W.reidentify(bad); };
      return;
    }
    // A result stays up while the unit that just finished reboots and re-plugs itself.
    const justEnded = Date.now() - Math.max(0, ...ended.values()) < 15000;
    if (ws.some((w) => w.state === "identifying")) { if (!justEnded) { status("Found one…", "Checking what's on it."); buttons(""); } return; }
    if (flashedAt) return;
    if (!actions.querySelector("#t-again, #t-retry")) idle();
  }
  function idle() {
    buttons(`<button class="btn btn-green" id="t-new">Pick the new Pico</button>
      <p class="fine">Shows as <b>RP2 Boot</b> or <b>RP2350 Boot</b>. <a href="#" id="t-has">Pick a used one</a></p>`);
    $("t-new").onclick = () => pickBoot().then(() => pick(), () => {});
    $("t-has").onclick = (e) => { e.preventDefault(); W.connectNew().catch(() => {}); };
  }

  draw();
  if (!W.supported() || !usbSupported()) {
    status("Can't see USB here", "Open wedgie.dev/test in Chrome or Edge on a computer.", "bad");
    return;
  }
  navigator.usb.addEventListener("connect", (e) => { if (isBoot((e as USBConnectionEvent).device)) setTimeout(pick, 300); });
  W.onChange(pick);
  W.start();
  pick();
}
