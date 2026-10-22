// /emu: a virtual wedgie. A real wedgie's chip (RP2040), its MicroPython build and its firmware, running
// in this tab (chip/worker.ts), in the 3D case. It's plugged into wedgie.dev: the site's other tabs list
// it with the real ones and talk to it over its USB serial, the same bytes a real one gets (chip/port.ts).
// First visit: a Pico with only MicroPython, set up by the same install the bench does (installCore +
// Welcome), then unplugged and plugged back in. Its flash stays in this browser.
// One 3D wedgie: click its buttons. An agent driving the page uses window.wedgie (press, hold, screen: the
// exact pixels the firmware sent).
import "./emu.css";
import { Repl } from "../serial/repl";
import { installCore, useApp, firmwareManifest } from "../serial/install";
import * as V from "../chip/port";
import { place3D, baseColor } from "../ui/place3d";
import type { Wedgie3D } from "../ui/wedgie3d";

const KEYMAP: Record<string, string> = {
  KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Space: "press", Enter: "press", KeyJ: "A", KeyK: "B", KeyL: "X", Semicolon: "Y",
};
const READY = "wedgie.emu.ready";       // the board ID whose setup finished
const MIN_HOLD = 250;                   // ms: a click is a real press, long enough for any app's poll

export function emu(main: HTMLElement) {
  main.innerHTML = `
  <section class="emu">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Virtual wedgie</h1>
    <p class="emu-sub">A real wedgie's chip and firmware, running in this tab. Keep it open: wedgie.dev in your other tabs sees it plugged in.</p>
    <div class="emu-stage recess" id="emu-3d"></div>
    <p class="emu-keys fine">Click its buttons, or keys: arrows or WASD · Space presses the stick · J K L ; = A B X Y</p>
    <div class="emu-status" id="emu-status">Starting…</div>
    <div class="emu-bar"><div id="emu-bar-fill"></div></div>
    <div class="row emu-actions">
      <button class="btn btn-sm" id="emu-power">Unplug + replug</button>
      <button class="btn btn-sm btn-red" id="emu-wipe">Wipe</button>
      <a class="btn btn-sm btn-green" href="/connect" target="_blank" rel="noopener">wedgie.dev ↗</a>
    </div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  // the screen as the firmware drew it, 240x240 (the 3D case shows it; window.wedgie.screen() reads it)
  const screen = document.createElement("canvas");
  screen.width = screen.height = 240;
  const g = screen.getContext("2d")!;
  g.fillStyle = "#000"; g.fillRect(0, 0, 240, 240);
  const img = g.createImageData(240, 240);
  // the 3D case's screen: its own canvas, copied from this one each frame
  const live = document.createElement("canvas");
  live.width = live.height = 240;
  const lg = live.getContext("2d")!;
  let w3d: Wedgie3D | null = null;
  const st = { id: "", speed: 0, usb: false, owner: false, setup: "" as string, p: 0 };

  const status = () => {
    const short = st.id.slice(-6).toUpperCase();
    const usb = !st.usb ? "USB: not up" : st.owner ? "USB: in use by a tab" : "USB: plugged in";
    $("emu-status").textContent = st.setup || `${short ? "ID " + short + " · " : ""}${Math.round(st.speed * 100)}% of real speed · ${usb}`;
    ($("emu-bar-fill") as HTMLElement).style.width = st.setup ? `${Math.round(8 + 92 * st.p)}%` : "0";
    $("emu-bar-fill").parentElement!.hidden = !st.setup;
  };

  // One virtual wedgie per browser: its flash is one board. A second /emu tab says so.
  navigator.locks.request("wedgie-emu-run", { ifAvailable: true }, (lock) => {
    if (!lock) { $("emu-status").textContent = "It's already running in another tab. Close that one to run it here."; return; }
    return new Promise<void>(() => run());
  });

  function run() {
    const worker = new Worker(new URL("../chip/worker.ts", import.meta.url), { type: "module" });
    const ch = new BroadcastChannel("wedgie-emu");
    addEventListener("pagehide", () => ch.postMessage({ t: "bye", id: st.id }));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.t === "frame") {
        const b = new Uint8Array(m.buf), d = img.data;
        for (let i = 0, o = 0; i < b.length; i += 2, o += 4) {
          const c = (b[i] << 8) | b[i + 1];
          d[o] = (c >> 8) & 0xf8; d[o + 1] = (c >> 3) & 0xfc; d[o + 2] = (c << 3) & 0xf8; d[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        lg.drawImage(screen, 0, 0);
      } else if (m.t === "stat") {
        const first = !st.id;
        Object.assign(st, { id: m.id, speed: m.speed, usb: m.usb, owner: m.owner });
        status();
        if (first) setupIfNew();
      } else if (m.t === "error") $("emu-status").textContent = "Broke: " + m.error;
    };
    worker.postMessage({ t: "boot" });

    // ---- keys: the 3D case, the buttons, the keyboard, window.wedgie ----
    const downAt = new Map<string, number>(), holders = new Map<string, Set<string>>();
    function hold(k: string, down: boolean, who = "api") {
      const s = holders.get(k) || new Set<string>();
      holders.set(k, s);
      const was = s.size > 0;
      if (down) s.add(who); else s.delete(who);
      const now = s.size > 0;
      if (now === was) return;
      if (now) { downAt.set(k, performance.now()); send(k, true); }
      else {
        // a quick click still holds MIN_HOLD, so the app sees it however it polls
        const wait = MIN_HOLD - (performance.now() - (downAt.get(k) || 0));
        setTimeout(() => { if (!holders.get(k)?.size) send(k, false); }, Math.max(0, wait));
      }
    }
    function send(k: string, down: boolean) {
      worker.postMessage({ t: "key", k, down });
      w3d?.keyVisual(k, down);
    }
    const kbd = new Set<string>();
    addEventListener("keydown", (e) => {
      const k = KEYMAP[e.code];
      if (!k || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest?.("input, textarea, button, a")) return;
      e.preventDefault();
      if (e.repeat || kbd.has(e.code)) return;
      kbd.add(e.code); hold(k, true, e.code);
    });
    addEventListener("keyup", (e) => { const k = KEYMAP[e.code]; if (k && kbd.delete(e.code)) hold(k, false, e.code); });
    addEventListener("blur", () => { for (const c of kbd) hold(KEYMAP[c], false, c); kbd.clear(); });

    place3D($("emu-3d"), { interactive: true, screen: live, eager: true, onKey: (k, down) => hold(k, down, "3d") }).then((w) => {
      w3d = w;
      w?.setColor("base", baseColor(null));      // no secure chip in it: the grey base of a chipless wedgie
    });

    $("emu-power").onclick = () => worker.postMessage({ t: "power" });
    $("emu-wipe").onclick = () => {
      if (!confirm("Wipe this virtual wedgie? Its apps, saves and keys go, and it gets a new ID.")) return;
      try { localStorage.removeItem(READY); } catch {}
      st.id = "";
      worker.postMessage({ t: "wipe" });
    };

    // For an agent (or the console): the same presses a person makes.
    (window as any).wedgie = {
      press: (k: string, ms = MIN_HOLD) => new Promise<void>((r) => { hold(k, true); setTimeout(() => { hold(k, false); setTimeout(r, MIN_HOLD); }, ms); }),
      hold: (k: string, down: boolean) => hold(k, down),
      screen: () => screen.toDataURL("image/png"),
      get id() { return st.id; },
      get speed() { return st.speed; },
    };

    function findPort() {
      V.start();
      return new Promise<V.VirtualPort>((res) => {
        const look = () => { const p = V.virtualPorts().find((x) => x.id === st.id && x.connected); if (p) res(p); else setTimeout(look, 300); };
        look();
      });
    }
    // Wedgie firmware answers hello once it's up (its USB replugs ~1 s after power-up: wait that out).
    async function says(port: V.VirtualPort) {
      st.setup = "Starting up"; status();
      await new Promise((r) => setTimeout(r, 4000));
      if (!port.connected) port = await findPort();
      const r = new Repl(port as unknown as SerialPort);
      try {
        await r.open();
        for (let i = 0; i < 15; i++) if (await r.hello(1500)) return true;
        return false;
      } catch { return false; } finally { await r.close().catch(() => {}); st.setup = ""; status(); }
    }

    // ---- first visit: install the firmware and Welcome, as the bench does a new board ----
    async function setupIfNew() {
      let ready = "";
      try { ready = localStorage.getItem(READY) || ""; } catch {}
      if (ready === st.id) return;
      // Started from the ready-made flash (tools/emuimage.mjs): it says hello on its own.
      const port0 = await findPort();
      if (await says(port0)) { try { localStorage.setItem(READY, st.id); } catch {} return; }
      st.setup = "Setting up: waiting for its USB"; status();
      try {
        const r = new Repl(port0 as unknown as SerialPort);
        await r.open();
        try {
          const prog = (p: number, what: string) => { st.p = p; st.setup = `Setting up: ${what}`; status(); };
          const m = await firmwareManifest();
          await installCore(r, (p, w) => prog(p * 0.8, w), { launcher: false });
          const welcome = m.carts.find((c) => c.mod === "welcome");
          if (welcome) await useApp(r, welcome, (p, w) => prog(0.8 + p * 0.2, w), { launcher: false, manifest: m });
        } finally { await r.close(); }
        try { localStorage.setItem(READY, st.id); } catch {}
        st.setup = ""; status();
        worker.postMessage({ t: "power" });        // unplugged and plugged back in: it boots its firmware
      } catch (e: any) {
        st.setup = `Setup failed: ${e?.message || e}. Wipe to try again.`; status();
      }
    }
  }
}
