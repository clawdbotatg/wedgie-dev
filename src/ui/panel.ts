// One wedgie, up close. The panel holds the USB port while it's open. On wedgie firmware the drawn
// device shows the real screen (shot every ~0.7 s) and its buttons press the real ones; the Apps tab
// opens apps on it; nothing is interrupted. Firmware installs/updates it. Test and Code talk to
// MicroPython's raw REPL (the wedgie restarts its launcher when they finish).
import { esc, KEYS, type Screen } from "./device";
import { place3D, idScreen as idCanvas, colorScreen } from "./place3d";
import type { Wedgie3D } from "./wedgie3d";
import * as W from "../serial/wedgies";
import { pyStr, type Repl } from "../serial/repl";
import { install, firmwareManifest, type App } from "../serial/install";

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
# Install the firmware (Firmware tab) to get lcd, Keys and the launcher.
import time
ident("HI!", "from wedgie.dev")
time.sleep(2)
`;

let open: HTMLElement | null = null;
let closeSession: (() => void) | null = null;

export function openPanel(w: W.Wedgie) {
  closePanel();
  const wedgie = () => w.kind === "wedgie";
  const el = document.createElement("div");
  el.className = "panel-wrap";
  el.innerHTML = `
  <div class="panel card" role="dialog" aria-label="wedgie ${esc(w.short || "")}">
    <button class="x" aria-label="close">×</button>
    <div class="panel-top">
      <div class="panel-dev"></div>
      <div class="panel-info">
        <span class="idtag big">${esc(w.short || "…")}</span>
        <dl class="kv" id="p-kv"></dl>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button data-tab="apps">Apps</button><button data-tab="fw">Firmware</button><button data-tab="test">Test</button><button data-tab="code">Code</button><button data-tab="log">Console</button>
    </div>
    <div class="tab" data-tab="apps" hidden><div class="applist" id="p-apps"></div></div>
    <div class="tab" data-tab="fw" hidden>
      <div id="p-fw"></div>
      <div class="meter" id="p-meter" hidden><div class="meter-track"><div class="meter-fill"></div></div><span id="p-meter-t"></span></div>
    </div>
    <div class="tab" data-tab="test" hidden>
      <div class="row">
        <button class="btn btn-sm" data-act="ident">Show ID on its screen</button>
        <button class="btn btn-sm" data-act="chip">Check the chip</button>
        <button class="btn btn-sm" data-act="screen">Screen test</button>
        <button class="btn btn-sm btn-green" data-act="keys">Button test</button>
      </div>
      <div class="status recess" id="p-status">Tests stop what it's running; it restarts when they finish.</div>
    </div>
    <div class="tab" data-tab="code" hidden>
      <textarea class="recess editor" spellcheck="false"></textarea>
      <div class="row">
        <button class="btn btn-sm btn-green" data-act="run">Run on it</button>
        <button class="btn btn-sm" data-act="stop">Stop</button>
        <button class="btn btn-sm" data-act="saveapp">Save as an app</button>
      </div>
      <pre class="recess out" id="p-out"></pre>
    </div>
    <div class="tab" data-tab="log" hidden><pre class="recess out log" id="p-log"></pre></div>
  </div>`;
  document.body.appendChild(el);
  open = el;
  document.documentElement.classList.add("noscroll");
  const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;

  // ---- the 3D wedgie: shows its real screen (mirrored), and pressing its buttons presses the real ones --
  const dev = $(".panel-dev");
  const canvas = document.createElement("canvas");      // the mirrored screen
  canvas.width = canvas.height = 240;
  let live = false;
  let w3: Wedgie3D | null = null;
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
  let shown: Screen = { kind: "off" };
  const setScreen = (s: Screen) => { shown = s; live = s.kind === "live"; w3?.setScreen(tex(s)); };
  const idScreen = (): Screen => (w.state === "ready" ? { kind: "id", id: w.short || "", sub: w.board } : { kind: "loading", p: 0.5 });
  setScreen(wedgie() ? { kind: "live" } : idScreen());
  place3D(dev, {
    screen: tex(shown),
    onKey: (k, down) => { if (down && wedgie() && link && !busy) link.request({ type: "press", key: k }).catch(() => {}); },
  }).then((x) => { w3 = x; x?.setScreen(tex(shown)); });

  const drawInfo = () => {
    $("#p-kv").innerHTML = [
      ["Board", w.board], ["Board ID", `<span class="mono">${esc(w.uid || "?")}</span>`], ["MicroPython", w.micropython],
      ["Running", w.firmware], ["Chip", w.chip ? chipText(w.chip) : "not checked yet"],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${k === "Board ID" ? v : esc(v || "?")}</dd>`).join("");
  };
  drawInfo();

  // ---- tabs ----------------------------------------------------------------------------------------
  const showTab = (name: string) => {
    el.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.tab === name));
    el.querySelectorAll<HTMLElement>(".tab").forEach((t) => (t.hidden = t.dataset.tab !== name));
  };
  el.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
  showTab(wedgie() ? "apps" : "fw");
  $(".x").addEventListener("click", closePanel);
  el.addEventListener("click", (e) => { if (e.target === el) closePanel(); });

  const status = (s: string) => ($("#p-status").innerHTML = s);
  const out = $("#p-out");
  const editor = $<HTMLTextAreaElement>(".editor");
  editor.value = wedgie() ? APP_SAMPLE : PROBE_SAMPLE;

  // ---- the session: one open port for the panel's life --------------------------------------------
  let link: Repl | null = null;
  let busy = false;
  let alive = true;
  let stopFn: (() => void) | null = null;
  const logEl = $("#p-log");
  const logTimer = setInterval(() => { if (!logEl.closest("[hidden]")) { logEl.textContent = w.log; logEl.scrollTop = 1e9; } }, 400);

  W.withRepl(w, (r) => new Promise<void>((done) => {
    link = r;
    closeSession = () => { alive = false; done(); };
    mirror();
  })).catch((e) => {
    $("#p-status").innerHTML = `<b class="bad">Can't open it:</b> ${esc(e?.message || e)}`;
    $("#p-fw").innerHTML = `<p class="bad">Can't open it: ${esc(e?.message || e)}</p>`;
  });

  // The real screen, mirrored onto the 3D one (its texture follows this canvas).
  const cx = canvas.getContext("2d")!;
  const img = cx.createImageData(240, 240);
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
      await new Promise((res) => setTimeout(res, 700));
    }
  }

  // Raw-REPL work: stop the launcher, run fn, then start it again. No soft reset on wedgie firmware:
  // 0.1.1+ re-adds its USB drive at boot, and that drops this port. Only an install reboots (it must,
  // to run the new files); the wedgie then comes back on its own and the tray picks it up.
  const act = async (name: string, fn: (r: Repl) => Promise<void>, opts: { probe?: boolean; keep?: boolean; reboot?: boolean } = {}) => {
    if (busy || !link) return;
    busy = true;
    el.querySelectorAll<HTMLButtonElement>("[data-act], .applist button, #p-fw button").forEach((b) => (b.disabled = b.dataset.act !== "stop"));
    const r = link;
    try {
      await r.enter({ reset: !wedgie() });
      if (opts.probe !== false) await r.exec(await W.probe(), 10000);
      await fn(r);
    } catch (e: any) {
      status(`<b class="bad">${esc(name)} failed:</b> ${esc(e?.message || e)}`);
      out.textContent += `\n${name} failed: ${e?.message || e}`;
    }
    if (opts.reboot) { await reboot(r); return; }
    if (!opts.keep) await restart(r);
  };
  const reboot = async (r: Repl) => {
    await r.leave();                           // soft reset: boots the new firmware (the port drops)
    status("Restarting it on the new firmware. It shows up again in a few seconds.");
    setTimeout(() => { closePanel(); W.touch(); }, 1800);
  };
  const restart = async (r: Repl) => {
    await r.leave({ reset: !wedgie() });
    await new Promise((res) => setTimeout(res, 2200)); // boot logo + loader + launcher
    if (wedgie()) {
      const h = await r.hello(1500).catch(() => null);
      if (h) { w.version = h.version; w.apps = h.apps; w.firmware = `wedgie ${h.version}`; }
      setScreen({ kind: "live" });
    } else setScreen(idScreen());
    busy = false;
    stopFn = null;
    el.querySelectorAll<HTMLButtonElement>("[data-act], .applist button, #p-fw button").forEach((b) => (b.disabled = false));
    drawInfo(); drawApps(); drawFw(); W.touch();
  };

  // ---- Apps ----------------------------------------------------------------------------------------
  let apps: App[] = [];
  firmwareManifest().then((m) => { apps = m.apps; drawApps(); drawFw(); });
  function drawApps() {
    const box = $("#p-apps");
    if (!wedgie()) {
      box.innerHTML = `<p>These run on wedgie firmware. Install it from the <a href="#" data-go="fw">Firmware</a> tab, then open them here or from the wedgie's own menu.</p>` + appCards(false);
    } else {
      box.innerHTML = `<p class="fine">Opens on the wedgie. Its real screen shows on the left; press its buttons there to drive it. <button class="btn btn-sm" data-home>Home</button></p>` + appCards(true);
    }
    box.querySelector<HTMLElement>("[data-go]")?.addEventListener("click", (e) => { e.preventDefault(); showTab("fw"); });
    box.querySelector<HTMLButtonElement>("[data-home]")?.addEventListener("click", () => link?.request({ type: "home" }).catch(() => {}));
    box.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => (b.onclick = async () => {
      if (!link || busy) return;
      b.textContent = "Opening…";
      try { await link.request({ type: "launch", app: b.dataset.open }, 8000); } catch (e: any) { b.textContent = "Didn't open"; return; }
      b.textContent = "Open";
    }));
  }
  const appCards = (can: boolean) => apps.map((a) => `<div class="appcard"><div><h4>${esc(a.name)}</h4><p>${esc(a.about || "")}</p></div>` +
    (can ? `<button class="btn btn-sm btn-green" data-open="${esc(a.mod)}">Open</button>` : "") + `</div>`).join("");

  // ---- Firmware ------------------------------------------------------------------------------------
  function drawFw() {
    firmwareManifest().then((m) => {
      const box = $("#p-fw");
      const cur = wedgie() ? w.version : null;
      const fresh = cur === m.version;
      box.innerHTML =
        `<div class="fwrow"><div><h4>${cur ? `wedgie ${esc(cur)}` : w.kind === "wallet" ? "The wallet app" : "No wedgie firmware"}</h4>` +
        `<p>${fresh ? "Up to date." : `wedgie ${esc(m.version)} is ready: the launcher, ${m.apps.length} apps, and the boot logo.`}` +
        ` Only changed files are copied; your own files stay.</p></div>` +
        `<button class="btn btn-sm ${fresh ? "" : "btn-green"}" data-fw>${fresh ? "Reinstall" : cur ? "Update" : "Install"}</button></div>` +
        `<p class="fine">Blank board with no MicroPython? Hold BOOTSEL, plug it in, drag
        <a href="https://micropython.org/download/RPI_PICO/" target="_blank" rel="noopener">MicroPython</a> onto the drive
        (<a href="https://micropython.org/download/RPI_PICO2_W/" target="_blank" rel="noopener">Pico 2 W</a>,
        <a href="https://micropython.org/download/RPI_PICO_W/" target="_blank" rel="noopener">Pico W</a>), then come back here.</p>`;
      box.querySelector<HTMLButtonElement>("[data-fw]")!.onclick = () => {
        const meter = $("#p-meter"), fill = $<HTMLElement>(".meter-fill"), t = $("#p-meter-t");
        meter.hidden = false; meter.classList.remove("done");
        act("Install", async (r) => {
          setScreen({ kind: "loading", p: 0 });
          let shown = 0;
          const res = await install(r, (p, what) => {
            fill.style.width = `${8 + 92 * p}%`;
            t.textContent = what;
            if (p - shown >= 0.05 || p === 1) { shown = p; setScreen({ kind: "loading", p }); } // the drawn wedgie's own loader
          });
          meter.classList.add("done");
          t.textContent = res.written ? `wedgie ${res.version} installed. Restarting…` : "Already up to date. Restarting…";
          w.kind = "wedgie"; w.version = res.version;
        }, { probe: false, reboot: true });
      };
    });
  }

  // ---- Test ----------------------------------------------------------------------------------------
  const handlers: Record<string, () => void> = {
    ident: () => act("Show ID", async (r) => {
      status("Painting its ID…");
      await r.exec(`ident(${pyStr(w.short || "WEDGIE")}, ${pyStr(w.board || "")})`, 15000);
      setScreen({ kind: "id", id: w.short || "", sub: w.board });
      status(`Its screen says <b>${esc(w.short)}</b>.`);
      await new Promise((res) => setTimeout(res, 2500));
    }),
    chip: () => act("Chip check", async (r) => {
      status("Looking for a chip on GP4/GP5…");
      let c: any = null;
      r.onLine = (t, v) => { if (t === "chip") c = v; };
      await r.exec("chip()", 20000);
      const ch = c?.found?.find((f: any) => !f.error);
      w.chip = ch || { type: "none" };
      if (ch) status(`Found <b>${esc(chipText(ch))}</b>.`);
      else if (c && (!c.lines.sda || !c.lines.scl)) status(`<b class="bad">No chip.</b> SDA/SCL aren't pulled up, so the chip has no power or isn't connected. Count the plug from its GND end (GND, 3.3 V, SDA, SCL; colors vary): SDA goes left 6th hole from the USB end, SCL left 7th, GND right 3rd, 3.3 V right 5th.`);
      else status(`<b class="bad">No chip answered</b>, but the lines have power. A data wire and the power wire are probably swapped (the chip can power itself through a data pin, so it looks fine). Count the plug from its GND end and check 3.3 V is right 5th, not a data hole.`);
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
      setScreen(idScreen());
      KEYS.forEach((k) => w3?.keyVisual(k, false));
      const seen = new Set<string>();
      status(`Press every button on the wedgie: joystick up, down, left, right, push it in, then A, B, X, Y. <span id="p-left"></span>`);
      const left = () => { const l = KEYS.filter((k) => !seen.has(k)); const e = el.querySelector("#p-left"); if (e) e.textContent = l.length ? `Left: ${l.join(" ")}` : ""; };
      left();
      r.onLine = (t, v) => {
        if (t === "stuck" && v.length) status(`<b class="bad">Held down from the start:</b> ${esc(v.join(", "))}`);
        if (t === "key") { if (!v.down) seen.add(v.key); w3?.keyVisual(v.key, v.down); left(); }
      };
      stopFn = () => r.interrupt();
      try { await r.exec("keys(180)", 190000); } catch {}
      const miss = KEYS.filter((k) => !seen.has(k));
      status(miss.length ? `<b class="bad">Never pressed:</b> ${esc(miss.join(" "))}` : `<b class="good">All nine buttons work.</b>`);
    }),

    // ---- Code --------------------------------------------------------------------------------------
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
      if (!wedgie()) { out.textContent = "Install wedgie firmware first (Firmware tab); apps live in its launcher."; return; }
      const name = (prompt_name() || "sketch");
      const mod = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]/, "_$&").slice(0, 20);
      act("Save", async (r) => {
        const src = editor.value;
        await r.exec(`_f = open(${pyStr(mod + ".py")}, "w")`);
        for (let i = 0; i < src.length; i += 1024) await r.exec(`_f.write(${pyStr(src.slice(i, i + 1024))})`);
        await r.exec(`_f.close()
import json
_a = json.load(open("apps.json"))
_a = [x for x in _a if x["mod"] != ${pyStr(mod)}] + [{"mod": ${pyStr(mod)}, "name": ${pyStr(name.slice(0, 12))}, "about": "yours"}]
json.dump(_a, open("apps.json", "w"))
import os
try:
    os.sync()
except AttributeError:
    pass`);
        out.textContent = `Saved as ${mod}.py; it's in the wedgie's launcher now.`;
      }, { probe: false });
    },
  };
  function prompt_name() {
    const v = (el.querySelector<HTMLInputElement>("#p-appname")?.value || "").trim();
    return v;
  }
  $(".tab[data-tab=code] .row").insertAdjacentHTML("beforeend", `<input id="p-appname" class="recess name" placeholder="app name" maxlength="12" value="My app">`);
  el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => handlers[b.dataset.act!]?.()));

  (el as any)._cleanup = () => { clearInterval(logTimer); stopFn?.(); closeSession?.(); closeSession = null; w3?.destroy(); };
}

function chipText(c: any) {
  if (!c || c.type === "none") return "none found";
  if (c.type === "ATECC608") return `ATECC608 · ${c.serial || ""}${c.configLocked === false ? " · fresh" : ""}`;
  return `${c.type}${c.uid ? " · " + c.uid.slice(0, 12) + "…" : ""}`;
}

export function closePanel() {
  if (!open) return;
  (open as any)._cleanup?.();
  open.remove();
  open = null;
  document.documentElement.classList.remove("noscroll");
}
addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
