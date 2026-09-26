// One wedgie, up close: what it is, a live test (screen + all nine buttons light up here as you press
// them on the device), code you can run on it or save as its main.py, and the raw serial log.
import { deviceSvg, esc, setKey, KEYS, type Screen } from "./device";
import * as W from "../serial/wedgies";
import { pyStr, type Repl } from "../serial/repl";

const SAMPLE = `# Runs on your wedgie. The wedgie.dev probe is loaded first, so you have:
#   ident(big, small)   col(r, g, b)   _LCD()   KEYS (pin numbers)   Pin
import time
ident("HI!", "from wedgie.dev")
time.sleep(1)
lcd = _LCD()
x, y, dx, dy = 20, 40, 3, 2
keys = {k: Pin(p, Pin.IN, Pin.PULL_UP) for k, p in KEYS.items()}
lcd.fill(col(255, 255, 255))
while keys["X"].value():            # press X to stop
    lcd.rect(x, y, 24, 24, col(255, 255, 255))
    x += dx; y += dy
    if x < 0 or x > 216: dx = -dx
    if y < 0 or y > 216: dy = -dy
    c = col(34, 196, 82) if keys["A"].value() else col(227, 49, 44)
    lcd.rect(x, y, 24, 24, c)
    time.sleep_ms(16)
ident("BYE")
`;

let open: HTMLElement | null = null;
let stopFn: (() => void) | null = null;

export function openPanel(w: W.Wedgie) {
  closePanel();
  const el = document.createElement("div");
  el.className = "panel-wrap";
  el.innerHTML = `
  <div class="panel card" role="dialog" aria-label="wedgie ${esc(w.short || "")}">
    <button class="x" aria-label="close">×</button>
    <div class="panel-top">
      <div class="panel-dev">${deviceSvg(screen(w))}</div>
      <div class="panel-info">
        <span class="idtag big">${esc(w.short || "…")}</span>
        <dl class="kv">
          <dt>Board</dt><dd>${esc(w.board || "?")}</dd>
          <dt>Board ID</dt><dd class="mono">${esc(w.uid || "?")}</dd>
          <dt>MicroPython</dt><dd>${esc(w.micropython || "?")}</dd>
          <dt>Running</dt><dd>${esc(w.firmware || "?")}</dd>
          <dt>Chip</dt><dd id="p-chip">${esc(w.chip ? chipText(w.chip) : "not checked yet")}</dd>
        </dl>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button class="on" data-tab="test">Test</button><button data-tab="code">Code</button><button data-tab="fw">Firmware</button><button data-tab="log">Console</button>
    </div>
    <div class="tab" data-tab="test">
      <div class="row">
        <button class="btn btn-sm" data-act="ident">Show ID on its screen</button>
        <button class="btn btn-sm" data-act="chip">Check the chip</button>
        <button class="btn btn-sm" data-act="screen">Screen test</button>
        <button class="btn btn-sm btn-green" data-act="keys">Button test</button>
      </div>
      <div class="status recess" id="p-status">Pick a test. Tests talk to it over USB; its app restarts when they finish.</div>
    </div>
    <div class="tab" data-tab="code" hidden>
      <textarea class="recess editor" spellcheck="false">${esc(SAMPLE)}</textarea>
      <div class="row">
        <button class="btn btn-sm btn-green" data-act="run">Run on wedgie</button>
        <button class="btn btn-sm" data-act="stop">Stop</button>
        <button class="btn btn-sm" data-act="save">Save as its main.py</button>
      </div>
      <pre class="recess out" id="p-out"></pre>
    </div>
    <div class="tab" data-tab="fw" hidden>
      <p>One-file wedgie firmware (.uf2) is on the way. For now: hold BOOTSEL, plug in, and drag
      <a href="https://micropython.org/download/RPI_PICO/" target="_blank" rel="noopener">MicroPython</a> onto the drive that shows up
      (<a href="https://micropython.org/download/RPI_PICO2_W/" target="_blank" rel="noopener">Pico 2 W build</a>). Then run code from the Code tab.</p>
      <div class="row"><button class="btn btn-sm" data-act="reid">Identify again</button></div>
    </div>
    <div class="tab" data-tab="log" hidden><pre class="recess out log" id="p-log"></pre></div>
  </div>`;
  document.body.appendChild(el);
  open = el;
  document.documentElement.classList.add("noscroll");

  const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  const dev = $(".panel-dev");
  const status = (s: string) => ($("#p-status").innerHTML = s);
  const setScreen = (s: Screen) => {
    dev.innerHTML = deviceSvg(s);
  };
  const out = $("#p-out");
  const logEl = $("#p-log");
  const logTimer = setInterval(() => { if (!logEl.closest("[hidden]")) { logEl.textContent = w.log; logEl.scrollTop = 1e9; } }, 400);
  el.addEventListener("remove", () => clearInterval(logTimer));
  (el as any)._cleanup = () => clearInterval(logTimer);

  $(".x").addEventListener("click", closePanel);
  el.addEventListener("click", (e) => { if (e.target === el) closePanel(); });
  el.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => (b.onclick = () => {
    el.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    el.querySelectorAll<HTMLElement>(".tab").forEach((t) => (t.hidden = t.dataset.tab !== b.dataset.tab));
  }));

  let busy = false;
  const act = async (name: string, fn: (r: Repl) => Promise<void>) => {
    if (busy) return;
    busy = true;
    el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.disabled = b.dataset.act !== "stop"));
    try {
      await W.withRepl(w, async (r) => {
        await r.enter();
        await r.exec(await W.probe(), 10000);
        try { await fn(r); } finally { await r.leave(); }
      });
    } catch (e: any) {
      status(`<b class="bad">${esc(name)} failed:</b> ${esc(e?.message || e)}`);
    }
    busy = false;
    stopFn = null;
    el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.disabled = false));
  };

  const handlers: Record<string, () => void> = {
    ident: () => act("Show ID", async (r) => {
      status("Painting its ID…");
      await r.exec(`ident(${pyStr(w.short || "WEDGIE")}, ${pyStr(w.board || "")})`, 15000);
      setScreen({ kind: "id", id: w.short || "", sub: w.board });
      status(`Its screen says <b>${esc(w.short)}</b> now. It goes back to its app in a moment.`);
      await new Promise((res) => setTimeout(res, 2500));
    }),
    chip: () => act("Chip check", async (r) => {
      status("Looking for a chip on GP4/GP5…");
      let c: any = null;
      r.onLine = (t, v) => { if (t === "chip") c = v; };
      await r.exec("chip()", 20000);
      const ch = c?.found?.find((f: any) => !f.error);
      w.chip = ch || { type: "none" };
      $("#p-chip").textContent = chipText(w.chip);
      if (ch) status(`Found <b>${esc(chipText(ch))}</b>.`);
      else if (c && (!c.lines.sda || !c.lines.scl)) status(`<b class="bad">No chip.</b> SDA/SCL aren't pulled up, so the chip has no power or isn't connected. Check the blue (GP4) and yellow (GP5) wires, then red and black.`);
      else status(`<b class="bad">No chip answered</b>, but the lines have power. Check that red (3V3, pin 36) and black (GND, pin 38) aren't swapped.`);
    }),
    screen: () => act("Screen test", async (r) => {
      await r.exec("screen()", 10000);
      for (const [name, css] of [["red", "#f00"], ["green", "#0f0"], ["blue", "#00f"]]) {
        await r.exec(`screen("${name}")`, 10000);
        setScreen({ kind: "color", css });
        status(`Its screen should be <b>${name.toUpperCase()}</b> edge to edge.`);
        await new Promise((res) => setTimeout(res, 1100));
      }
      status("Red, green, blue sent. If one looked wrong, reseat the hat on the Pico.");
    }),
    keys: () => act("Button test", async (r) => {
      setScreen(screen(w));
      const root = dev.querySelector("svg")!;
      KEYS.forEach((k) => setKey(root, k, ""));
      const seen = new Set<string>();
      status(`Press every button on the wedgie: joystick up, down, left, right, push it in, then A, B, X, Y. <span id="p-left"></span>`);
      const left = () => { const l = KEYS.filter((k) => !seen.has(k)); const e = el.querySelector("#p-left"); if (e) e.textContent = l.length ? `Left: ${l.join(" ")}` : ""; };
      left();
      r.onLine = (t, v) => {
        if (t === "stuck" && v.length) status(`<b class="bad">Held down from the start:</b> ${esc(v.join(", "))}`);
        if (t === "key") { if (!v.down) seen.add(v.key); setKey(root, v.key, v.down ? "down" : "done"); left(); }
      };
      stopFn = () => r.interrupt();
      try { await r.exec("keys(180)", 190000); } catch {}
      const miss = KEYS.filter((k) => !seen.has(k));
      status(miss.length ? `<b class="bad">Never pressed:</b> ${esc(miss.join(" "))}` : `<b class="good">All nine buttons work.</b>`);
    }),
    run: () => act("Run", async (r) => {
      out.textContent = "";
      r.onText = ((prev) => (s: string) => { prev?.(s); out.textContent = (out.textContent + s.replace(/[\x00-\x08]/g, "")).slice(-20000); out.scrollTop = 1e9; })(r.onText);
      stopFn = () => r.interrupt();
      status("Running. Press Stop (or the key your code watches) to end it.");
      const code = $<HTMLTextAreaElement>(".editor").value;
      try { await r.exec(code, 10 * 60 * 1000); out.textContent += "\n[done]"; }
      catch (e: any) { out.textContent += "\n" + (e?.message || e); }
    }),
    stop: () => stopFn?.(),
    save: () => act("Save", async (r) => {
      const src = (await W.probe()) + "\n\n# ---- your code ----\n" + $<HTMLTextAreaElement>(".editor").value;
      await r.exec("f = open('main.py', 'w')");
      for (let i = 0; i < src.length; i += 1024) await r.exec(`f.write(${pyStr(src.slice(i, i + 1024))})`);
      await r.exec("f.close()");
      out.textContent = `Saved main.py (${src.length} bytes). It runs every time the wedgie powers up.`;
    }),
    reid: () => { W.reidentify(w); closePanel(); },
  };
  el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => handlers[b.dataset.act!]?.()));
}

function screen(w: W.Wedgie): Screen {
  return w.state === "ready" ? { kind: "id", id: w.short || "", sub: w.board } : { kind: "loading", p: 0.5 };
}

function chipText(c: any) {
  if (!c || c.type === "none") return "none found";
  if (c.type === "ATECC608") return `ATECC608 · ${c.serial || ""}${c.configLocked === false ? " · fresh" : ""}`;
  return `${c.type}${c.uid ? " · " + c.uid.slice(0, 12) + "…" : ""}`;
}

export function closePanel() {
  if (!open) return;
  stopFn?.();
  (open as any)._cleanup?.();
  open.remove();
  open = null;
  document.documentElement.classList.remove("noscroll");
}
addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
