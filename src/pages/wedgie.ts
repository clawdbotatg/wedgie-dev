// /connect/<ID>: one wedgie, one page, no tabs. The 3D wedgie shows its real screen (a shot every
// ~0.7 s) and pressing its buttons presses the real ones. Then Hardware (is the chip proven working,
// screen and button test), Firmware (the version, one Update button), Cartridges (tap one to play it;
// one it doesn't have goes on first), and a folded Developer section (code, console).
// The page holds the wedgie's USB port while it's open, so nothing else (another tab, wedgie.py,
// mpremote) can talk to it meanwhile.
//
// USB and resets: nothing here soft-resets a wedgie, except the firmware update's final reboot. Wedgie
// firmware 0.1.1+ adds its WEDGIE USB drive at power-up, which disconnects and reconnects USB; after
// that reboot the wedgie comes back as a NEW port (a new W.Wedgie, same ID), and this page picks it up
// by its ID. Raw-REPL work (tests, code, cartridges) stops the launcher with Ctrl-C and restarts it by
// running main.py (Repl.leave({ reset: false })), which keeps the port.
import { esc, KEYS, type Screen } from "../ui/device";
import { place3D, idScreen as idCanvas, colorScreen } from "../ui/place3d";
import type { Wedgie3D } from "../ui/wedgie3d";
import * as W from "../serial/wedgies";
import { pyStr, type Repl } from "../serial/repl";
import { installCore, installCart, removeCart, takeOver, firmwareManifest, type Cart, type Manifest } from "../serial/install";
import { cartHtml } from "../ui/cart";
import * as F from "../ui/facts";

const APP_SAMPLE = `# A wedgie app: draw with lcd, read the buttons, tick on a Timer so USB stays free.
# X goes back to the launcher. "Save as an app" puts it in the launcher's list.
from machine import Timer
from lcd import LCD, Keys, color, WHITE, BLACK

lcd = LCD()
keys = Keys()
GREEN, RED, INK = color(34, 196, 82), color(227, 49, 44), color(26, 27, 26)
x, y, dx, dy = 40, 60, 3, 2
timer = None


def tick(_):
    global x, y, dx, dy
    for k in keys.pressed():
        if k == "X":
            return stop()
        if k == "A":
            dx, dy = -dx, -dy
    x += dx; y += dy
    if not 0 < x < 204: dx = -dx
    if not 0 < y < 204: dy = -dy
    lcd.fill(WHITE)
    lcd.center_text("my wedgie app", 8, INK)
    lcd.fill_rect(x, y, 36, 36, RED if keys.held("B") else GREEN)
    lcd.show()


def start():
    global timer
    timer = Timer(period=33, mode=Timer.PERIODIC, callback=tick)


def stop():
    if timer:
        timer.deinit()


start()
`;

const PROBE_SAMPLE = `# No wedgie firmware on this board yet, so the wedgie.dev probe is loaded first:
#   ident(big, small)   col(r, g, b)   _LCD()   KEYS (pin numbers)   Pin
# Install the firmware to get lcd, Keys and the launcher.
import time
ident("HI!", "from wedgie.dev")
time.sleep(2)
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export function wedgiePage(main: HTMLElement, id: string, go: (path: string) => void): () => void {
  main.innerHTML = `
  <section class="sec wd">
    <a class="back" href="/connect">‹ All wedgies</a>
    <div class="wd-grid">
      <div class="wd-dev"><div class="wd-3d"></div><p class="fine wd-hint" id="d-hint"></p></div>
      <div class="wd-main">
        <div class="wd-head"><span class="light" id="d-light"></span><span class="idtag big">${esc(id)}</span></div>
        <div class="wd-missing card" id="d-missing" hidden></div>
        <div id="d-body">
          <div class="card wd-sec">
            <h3>Hardware</h3>
            <dl class="kv" id="d-hw"></dl>
            <div class="status recess" id="d-status" hidden></div>
          </div>
          <div class="card wd-sec">
            <h3>Firmware</h3>
            <div id="d-fw"></div>
            <div class="meter" id="d-meter" hidden><div class="meter-track"><div class="meter-fill"></div></div><span id="d-meter-t"></span></div>
          </div>
          <div class="card wd-sec carts">
            <h3>Software</h3>
            <p class="fine" id="d-carts-note"></p>
            <h4 class="shelf-h" id="d-on-h">On this wedgie</h4><div class="shelf" id="d-on"></div>
            <h4 class="shelf-h" id="d-more-h">Get more</h4><div class="shelf" id="d-more"></div>
          </div>
          <details class="card wd-sec dev">
            <summary>Developer</summary>
            <div class="row"><button class="btn btn-sm" data-act="screen">Test the screen</button><button class="btn btn-sm" data-act="keys">Test the buttons</button><button class="btn btn-sm" data-act="chip">Check the chip again</button></div>
            <div class="status recess" id="d-tstatus" hidden></div>
            <textarea class="recess editor" spellcheck="false"></textarea>
            <div class="row">
              <button class="btn btn-sm btn-green" data-act="run">Run on it</button>
              <button class="btn btn-sm" data-act="stop">Stop</button>
              <input id="d-appname" class="recess name" placeholder="app name" maxlength="12" value="My app">
              <button class="btn btn-sm" data-act="saveapp">Save as an app</button>
            </div>
            <pre class="recess out" id="d-out"></pre>
            <h4>Console</h4>
            <pre class="recess out log" id="d-log"></pre>
          </details>
        </div>
      </div>
    </div>
  </section>`;
  const $ = <T extends Element = HTMLElement>(s: string) => main.querySelector(s) as T;
  $<HTMLAnchorElement>(".back").onclick = (e) => { e.preventDefault(); go("/connect"); };
  let m: Manifest | undefined;
  firmwareManifest().then((x) => { m = x; paint(); }).catch(() => {});

  let w: W.Wedgie | null = null;   // the wedgie with this ID right now (a new object after each replug)
  let link: Repl | null = null;    // its open port, while we hold it
  let busy = "";                   // what raw-REPL work is under way ("" = none)
  let alive = true;
  let release: (() => void) | null = null;
  let stopFn: (() => void) | null = null;
  const wedgie = () => w?.kind === "wedgie";
  const carts = () => (w?.carts || []);
  const newCarts = () => !!w?.carts;                // firmware 0.1.4+: cartridges come and go
  const ours = () => wedgie() || (w?.kind === "wallet" && newCarts());   // the Wallet cart running counts

  // ---- the 3D wedgie: the real screen (mirrored), and its buttons press the real ones ---------------
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  let w3: Wedgie3D | null = null, shown: Screen = { kind: "off" }, live = false;
  const tex = (s: Screen): HTMLCanvasElement | string => {
    switch (s.kind) {
      case "live": return canvas;
      case "id": return idCanvas(s.id, s.sub);
      case "color": return colorScreen(s.css);
      case "loading": return idCanvas(`${Math.round(s.p * 100)}%`, "installing");
      case "text": return idCanvas(s.text);
      default: return colorScreen("#101012");
    }
  };
  const setScreen = (s: Screen) => { shown = s; live = s.kind === "live"; w3?.setScreen(tex(s)); };
  const idScreen = (): Screen => ({ kind: "id", id, sub: w?.board || "" });
  setScreen(idScreen());
  place3D($(".wd-3d"), {
    screen: tex(shown),
    onKey: (k, down) => { if (down && wedgie() && link && !busy) link.request({ type: "press", key: k }).catch(() => {}); },
  }).then((x) => { w3 = x; x?.setScreen(tex(shown)); });

  const cx = canvas.getContext("2d")!, img = cx.createImageData(240, 240);
  async function mirror() {
    while (alive) {
      if (link && wedgie() && live && !busy && !document.hidden) {
        try {
          const s = await link.request({ type: "shot" }, 4000);
          const raw = atob(s.data);
          for (let i = 0, j = 0; i < raw.length; i += 2, j += 4) {
            const v = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
            img.data[j] = ((v >> 11) & 31) * 255 / 31; img.data[j + 1] = ((v >> 5) & 63) * 255 / 63; img.data[j + 2] = (v & 31) * 255 / 31; img.data[j + 3] = 255;
          }
          cx.putImageData(img, 0, 0);
        } catch {}
      }
      await sleep(700);
    }
  }

  // ---- finding it, and holding its port -------------------------------------------------------------
  function attach() {
    const found = W.wedgies().find((x) => x.short === id && x.state !== "gone") || null;
    if (found !== w) {
      release?.(); release = null; link = null; w = found;
      if (w?.state === "ready") open(w);
    } else if (w && w.state === "ready" && !link && !release) open(w);
    paint();
  }
  function open(x: W.Wedgie) {
    let done!: () => void;
    const held = new Promise<void>((r) => (done = r));
    release = () => done();
    W.withRepl(x, async (r) => {
      if (x !== w) return;
      link = r;
      setScreen(wedgie() ? { kind: "live" } : idScreen());
      paint();
      await held;
    }).catch((e) => { status(`<b class="bad">Can't open it:</b> ${esc(e?.message || e)}`); })
      .finally(() => { if (x === w) { link = null; } });
  }
  const off = W.onChange(attach);
  attach();
  mirror();

  // ---- painting --------------------------------------------------------------------------------------
  const status = (s: string, at = "#d-status") => { const el = $(at); el.hidden = !s; el.innerHTML = s; };
  const tstatus = (s: string) => status(s, "#d-tstatus");   // the Developer section's own line (tests, Run, Save)
  const meter = (p: number | null, t = "") => {
    const el = $("#d-meter"); el.hidden = p === null; if (p === null) return;
    el.classList.toggle("done", p >= 1);
    $<HTMLElement>(".meter-fill").style.width = `${8 + 92 * p}%`; $("#d-meter-t").textContent = t;
  };
  function paint() {
    const here = !!w && w.state !== "gone";
    $("#d-missing").hidden = here && w!.state !== "error";
    $("#d-body").hidden = !here || w!.state === "error";
    if (!here || w!.state === "error") {
      $("#d-missing").innerHTML = w?.state === "error" ? `<p class="bad">${esc(w.error || "Can't talk to it.")}</p>`
        : `<p><b>${esc(id)} isn't plugged in.</b> Plug it in and it shows up here by itself. ${busy ? "" : `<a href="/connect" data-back>See all wedgies</a>`}</p>`;
      $("#d-missing").querySelector<HTMLElement>("[data-back]")?.addEventListener("click", (e) => { e.preventDefault(); go("/connect"); });
      $("#d-light").className = "light wait";
      $("#d-hint").textContent = "";
      return;
    }
    const x = w!;
    $("#d-light").className = `light ${F.overall(x, m)}`;
    $("#d-hint").textContent = wedgie() && link ? "Its real screen. Click its buttons (or press arrows, Enter, A, B, X, Y) to press the real ones." : "";
    paintHw(x); paintFw(x); paintCarts(x);
    main.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.disabled = !link || (!!busy && b.dataset.act !== "stop") || (b.dataset.act === "chip" && !newCarts())));
  }

  function paintHw(x: W.Wedgie) {
    const p = x.proof;
    const chip = !p ? (x.chip?.type ? esc(x.chip.type) : "not checked")
      : p.state === "checking" ? "checking…"
      : p.state === "done" ? `${p.pass ? `<b class="good">✓ ${esc(F.chipName(x))} working</b>` : `<b class="bad">✗ ${esc(F.chipName(x) || "No chip")}</b>`}<br><span class="fine">${esc(p.detail)}</span>`
      : `${x.chip?.type ? esc(x.chip.type) + "<br>" : ""}<span class="fine">${esc(p.detail)}</span>`;
    const facts = p?.state === "done" && p.facts.length ? `<details class="fine"><summary>How we know</summary>${p.facts.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}</details>` : "";
    const rows = [
      ["Board", `${esc(x.board || "?")} <span class="fine">${esc(x.cpu || "")}</span>`],
      ["Chip", chip + facts],
      ["Board ID", `<span class="mono">${esc(x.uid || "?")}</span>`],
      ...(x.free != null ? [["Room", `${kb(x.free)} free for cartridges`]] : []),
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const hw = $("#d-hw");
    if (hw.dataset.html !== rows) { hw.dataset.html = rows; hw.innerHTML = rows; }   // a repaint must not snap "How we know" shut
  }

  function paintFw(x: W.Wedgie) {
    const box = $("#d-fw");
    if (!m) { box.innerHTML = ""; return; }
    const cur = x.kind === "wedgie" ? x.version : null, fresh = cur === m.version;
    const what = x.kind === "wallet" ? "The Wallet is running. Press X on the wedgie to leave it, then check for updates here."
      : fresh ? "Up to date." : cur ? `wedgie ${esc(m.version)} is ready.` : `This board has MicroPython but no wedgie firmware yet.`;
    const sig = `${cur}|${m.version}|${x.kind}|${!!link}|${!!busy}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = `<div class="fwrow"><div><h4>${cur ? `wedgie ${esc(cur)}` : x.kind === "wallet" ? "wedgie" : "No wedgie firmware"}</h4><p>${what}</p></div>` +
      (x.kind === "wallet" ? "" : `<button class="btn btn-sm ${fresh ? "" : "btn-green"}" data-fw ${!link || busy ? "disabled" : ""}>${fresh ? "Reinstall" : cur ? "Update" : "Install"}</button>`) + `</div>` +
      (fresh || x.kind === "wallet" ? "" : `<p class="fine">Takes a minute. Your cartridges stay on it.</p>`);
    box.querySelector<HTMLButtonElement>("[data-fw]")?.addEventListener("click", updateFw);
  }

  // ---- cartridges -------------------------------------------------------------------------------------
  const inserting: Record<string, number> = {};   // mod -> progress while it goes in
  let confirmOut = "";                             // a cart whose Remove was tapped once
  function paintCarts(x: W.Wedgie) {
    if (!m) return;
    const note = $("#d-carts-note");
    if (x.kind === "micropython") note.innerHTML = "Cartridges run on wedgie firmware. Install it above first.";
    else if (!newCarts()) note.innerHTML = "Update the firmware above to put cartridges on and take them off.";
    else note.innerHTML = "Tap one under Get more to put it on. Tap one it has to play it.";
    const on = new Map(carts().map((c) => [c.mod, c.v]));
    const legacy = !newCarts() ? new Set(x.apps || []) : null;      // 0.1.3: apps it has, no versions
    const has = (c: Cart) => (legacy ? legacy.has(c.mod) : on.has(c.mod));
    fill($("#d-on"), m.carts.filter(has), x, on, legacy);
    fill($("#d-more"), m.carts.filter((c) => !has(c)), x, on, legacy);
    $("#d-on-h").hidden = !$("#d-on").children.length;
    $("#d-more-h").hidden = !$("#d-more").children.length;
  }
  function fill(shelf: HTMLElement, list: Cart[], x: W.Wedgie, on: Map<string, string | undefined>, legacy: Set<string> | null) {
    const keep = new Set(list.map((c) => c.mod));
    shelf.querySelectorAll<HTMLElement>(".cart-slot").forEach((el) => { if (!keep.has(el.dataset.mod!)) el.remove(); });
    list.forEach((c, i) => {
      let slot = shelf.querySelector<HTMLElement>(`.cart-slot[data-mod="${c.mod}"]`);
      if (!slot) {
        document.querySelector(`.cart-slot[data-mod="${c.mod}"]`)?.remove();   // moved between shelves
        slot = document.createElement("div");
        slot.className = "cart-slot";
        slot.dataset.mod = c.mod;
        slot.innerHTML = `<button class="cart" title="${esc(c.about || "")}">${cartHtml(c)}</button><p class="cart-about">${esc(c.about || "")}</p><button class="cart-out" hidden></button>`;
        slot.querySelector<HTMLButtonElement>(".cart")!.onclick = () => play(c);
        slot.querySelector<HTMLButtonElement>(".cart-out")!.onclick = () => eject(c);
      }
      if (shelf.children[i] !== slot) shelf.insertBefore(slot, shelf.children[i] || null);
      const installed = legacy ? legacy.has(c.mod) : on.has(c.mod);
      const outdated = !legacy && installed && on.get(c.mod) !== c.v;
      const playing = x.running === c.mod;
      const p = inserting[c.mod];
      const btn = slot.querySelector<HTMLButtonElement>(".cart")!;
      btn.classList.toggle("playing", playing);
      btn.classList.toggle("absent", !installed);
      btn.classList.toggle("busy", p !== undefined);
      btn.disabled = !link || !!busy || !ours() || (!installed && !newCarts());
      btn.style.setProperty("--p", String(p ?? 0));
      slot.querySelector(".cart-state")!.innerHTML = p !== undefined ? "installing" : playing ? "▶ playing" : outdated ? "update" : !installed ? kb(c.size) : "";
      slot.querySelector(".cart-state")!.className = `cart-state${playing ? " on" : outdated || !installed ? " soft" : ""}`;
      const out = slot.querySelector<HTMLButtonElement>(".cart-out")!;
      out.hidden = !installed || !newCarts();
      out.disabled = !link || !!busy;
      out.textContent = confirmOut === c.mod ? `Remove ${c.name}?` : "Remove";
      out.classList.toggle("sure", confirmOut === c.mod);
    });
  }

  // Tap one it doesn't have (or an old one): it goes on, back to the menu, so the next can go on right
  // after. Tap one it has: it plays; whatever was running is stopped first.
  async function play(c: Cart) {
    if (!link || busy || !w) return;
    const x = w, r = link;
    confirmOut = "";
    const installed = newCarts() ? carts().some((a) => a.mod === c.mod) : (x.apps || []).includes(c.mod);
    const outdated = newCarts() && carts().find((a) => a.mod === c.mod)?.v !== c.v;
    if (installed && !outdated) {
      busy = "launch"; paint();
      const launch = () => r.request({ type: "launch", app: c.mod }, 8000);
      try {
        if (x.kind === "wallet") { await takeOver(r); await backToLauncher(r); }
        try { await launch(); }
        catch { await takeOver(r); await backToLauncher(r); await launch(); }   // something owned the screen
        x.running = c.mod; setScreen({ kind: "live" });
      } catch (e: any) { status(`<b class="bad">${esc(c.name)} didn't open:</b> ${esc(e?.message || e)}. Press X on the wedgie and try again.`); }
      busy = ""; paint(); W.touch();
      return;
    }
    busy = "cart"; inserting[c.mod] = 0; paint();
    try {
      await installCart(r, c, (p) => { inserting[c.mod] = p; paint(); });
      delete inserting[c.mod];
    } catch (e: any) {
      delete inserting[c.mod];
      status(`<b class="bad">${esc(c.name)} didn't go on:</b> ${esc(e?.message || e)}`);
    }
    await backToLauncher(r).catch(() => {});
    busy = ""; setScreen({ kind: "live" }); paint(); W.touch();
  }

  async function eject(c: Cart) {
    if (!link || busy || !w) return;
    if (confirmOut !== c.mod) { confirmOut = c.mod; paint(); return; }
    confirmOut = "";
    const r = link;
    busy = "cart"; paint();
    try { await removeCart(r, c); } catch (e: any) { status(`<b class="bad">Couldn't remove ${esc(c.name)}:</b> ${esc(e?.message || e)}`); }
    await backToLauncher(r).catch(() => {});
    busy = ""; paint(); W.touch();
  }

  /** Raw REPL → the launcher, same port (main.py, no reset), then its hello refreshes what we know. */
  async function backToLauncher(r: Repl) {
    await r.leave({ reset: false });
    let h: any = null;
    for (let i = 0; i < 12 && !h; i++) h = await r.hello(700).catch(() => null);
    if (h && w) { if (String(h.fw || "").startsWith("wedgie-")) w.kind = "wedgie"; w.version = h.version; w.apps = h.apps; w.carts = h.carts; w.free = h.free ?? w.free; w.running = h.running ?? null; w.firmware = `wedgie ${h.version}`; }
  }

  // ---- firmware ---------------------------------------------------------------------------------------
  async function updateFw() {
    if (!link || busy || !w) return;
    const r = link, x = w;
    busy = "fw"; paint(); meter(0, "starting");
    try {
      if (x.kind === "micropython") { await r.enter({ reset: true }); }   // bare MicroPython: no drive, a reset is safe
      setScreen({ kind: "loading", p: 0 });
      let drawn = 0;
      const res = await installCore(r, (p, what) => { meter(p, what); if (p - drawn >= 0.05 || p === 1) { drawn = p; setScreen({ kind: "loading", p }); } });
      meter(1, res.written ? `wedgie ${res.version} installed. Restarting it…` : "Already up to date. Restarting it…");
      // The one soft reset: the new firmware only runs after one. The port drops and the wedgie comes back as a
      // new port (the drive re-enumerates USB on firmware older than 0.1.3); attach() finds it by its ID.
      await r.leave();
      status("Restarting it on the new firmware. It comes back here in a few seconds.");
      // Identify it again (queued behind this session, so it starts once the port is let go). On 0.1.3+ the
      // port survives a soft reset; if it doesn't, the disconnect marks it gone and the replug is a new one.
      W.reidentify(x);
      release?.(); release = null; link = null;
    } catch (e: any) {
      meter(null);
      status(`<b class="bad">Update failed:</b> ${esc(e?.message || e)}. It's safe to try again.`);
      await backToLauncher(r).catch(() => {});
    }
    busy = ""; paint();
  }

  // ---- hardware tests (raw REPL: stop the launcher, run, start it again) ------------------------------
  const act = async (name: string, fn: (r: Repl) => Promise<void>, opts: { probe?: boolean; keep?: boolean } = {}) => {
    if (busy || !link) return;
    busy = name; paint();
    const r = link;
    try {
      if (wedgie()) await takeOver(r); else await r.enter({ reset: true });   // bare MicroPython: no drive, a reset is safe
      if (opts.probe !== false) await r.exec(await W.probe(), 10000);
      await fn(r);
    } catch (e: any) {
      tstatus(`<b class="bad">${esc(name)} failed:</b> ${esc(e?.message || e)}`);
    }
    if (!opts.keep) await restart(r);
  };
  const restart = async (r: Repl) => {
    if (wedgie()) await backToLauncher(r).catch(() => {}); else await r.leave({ reset: true });
    setScreen(wedgie() ? { kind: "live" } : idScreen());
    busy = ""; stopFn = null;
    paint(); W.touch();
  };

  const out = $("#d-out"), editor = $<HTMLTextAreaElement>(".editor"), logEl = $("#d-log");
  editor.value = APP_SAMPLE;
  let sampleFor = "wedgie";
  const logTimer = setInterval(() => {
    if (w && !wedgie() && sampleFor === "wedgie" && editor.value === APP_SAMPLE) { editor.value = PROBE_SAMPLE; sampleFor = "probe"; }
    if ((logEl.closest("details") as HTMLDetailsElement).open && w) { logEl.textContent = w.log; logEl.scrollTop = 1e9; }
  }, 400);

  const handlers: Record<string, () => void> = {
    chip: async () => {
      if (!link || busy || !w) return;
      busy = "chip"; paint();
      await W.reprove(w, link);
      busy = ""; paint();
    },
    screen: () => act("Screen test", async (r) => {
      await r.exec("screen()", 10000);
      for (const [name, css] of [["red", "#f00"], ["green", "#0f0"], ["blue", "#00f"]]) {
        await r.exec(`screen("${name}")`, 10000);
        setScreen({ kind: "color", css });
        tstatus(`Its screen should be <b>${name.toUpperCase()}</b> edge to edge.`);
        await sleep(1100);
      }
      tstatus("Red, green, blue. If one looked wrong or patchy, reseat the screen board on the Pico.");
    }),
    keys: () => act("Button test", async (r) => {
      setScreen(idScreen());
      KEYS.forEach((k) => w3?.keyVisual(k, false));
      const seen = new Set<string>();
      tstatus(`Press every button on the wedgie: joystick up, down, left, right, push it in, then A, B, X, Y. <span id="d-left"></span>`);
      const left = () => { const l = KEYS.filter((k) => !seen.has(k)); const e = main.querySelector("#d-left"); if (e) e.textContent = l.length ? `Left: ${l.join(" ")}` : ""; };
      left();
      r.onLine = (t, v) => {
        if (t === "stuck" && v.length) tstatus(`<b class="bad">Held down from the start:</b> ${esc(v.join(", "))}`);
        if (t === "key") { if (!v.down) seen.add(v.key); w3?.keyVisual(v.key, v.down); left(); }
      };
      stopFn = () => r.interrupt();
      try { await r.exec("keys(180)", 190000); } catch {}
      const miss = KEYS.filter((k) => !seen.has(k));
      tstatus(miss.length ? `<b class="bad">Never pressed:</b> ${esc(miss.join(" "))}` : `<b class="good">All nine buttons work.</b>`);
    }),
    run: () => act("Run", async (r) => {
      out.textContent = "";
      r.onText = ((prev) => (s: string) => { prev?.(s); out.textContent = (out.textContent + s.replace(/[\x00-\x08]/g, "")).slice(-20000); out.scrollTop = 1e9; })(r.onText);
      stopFn = () => { r.interrupt(); restart(r); };
      if (wedgie()) setScreen({ kind: "live" });
      try {
        await r.exec(editor.value, 10 * 60 * 1000);
        out.textContent += "\n[returned; timers keep running until Stop]";
      } catch (e: any) { out.textContent += "\n" + (e?.message || e); }
    }, { probe: !wedgie(), keep: true }),
    stop: () => stopFn?.(),
    saveapp: () => {
      if (!wedgie()) { out.textContent = "Install wedgie firmware first; apps live in its launcher."; return; }
      const name = ($<HTMLInputElement>("#d-appname").value || "").trim() || "sketch";
      const mod = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]/, "_$&").slice(0, 20);
      act("Save", async (r) => {
        const src = editor.value;
        await r.exec(`_f = open(${pyStr(mod + ".py")}, "w")`);
        for (let i = 0; i < src.length; i += 1024) await r.exec(`_f.write(${pyStr(src.slice(i, i + 1024))})`);
        await r.exec(`_f.close()
import json, sys
try:
    _a = json.load(open("apps.json"))
except Exception:
    _a = []
_a = [x for x in _a if x["mod"] != ${pyStr(mod)}] + [{"mod": ${pyStr(mod)}, "name": ${pyStr(name.slice(0, 12))}, "about": "yours"}]
json.dump(_a, open("apps.json", "w"))
sys.modules.pop(${pyStr(mod)}, None)
import os
try:
    os.sync()
except AttributeError:
    pass`);
        out.textContent = `Saved as ${mod}.py; it's in the wedgie's launcher now.`;
      }, { probe: false });
    },
  };
  main.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => handlers[b.dataset.act!]?.()));

  return () => {
    alive = false;
    off();
    clearInterval(logTimer);
    stopFn?.();
    release?.();
    w3?.destroy();
  };
}
