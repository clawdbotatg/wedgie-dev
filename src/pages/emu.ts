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
const MIN_HOLD = 250;                   // ms: a click is a real press, long enough for any app's poll

// ---- Screenshot: the screen at 3x into one folder, picked once (kept in IndexedDB; Chrome asks again only
// if it forgets the permission). No folder API (Safari, Firefox): a download instead.
function shotDb<T>(fn: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = "readonly") {
  return new Promise<T | undefined>((res) => {
    const o = indexedDB.open("wedgie-emu-shots", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onsuccess = () => { const r = fn(o.result.transaction("kv", mode).objectStore("kv")); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); };
    o.onerror = () => res(undefined);
  });
}
async function shotFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!("showDirectoryPicker" in window)) return null;
  let dir = (await shotDb((s) => s.get("dir"))) as FileSystemDirectoryHandle | undefined;
  if (dir && (await (dir as any).requestPermission({ mode: "readwrite" })) !== "granted") dir = undefined;
  if (!dir) {
    dir = await (window as any).showDirectoryPicker({ id: "wedgie-shots", mode: "readwrite" }) as FileSystemDirectoryHandle;
    await shotDb((s) => s.put(dir, "dir"), "readwrite");
  }
  return dir;
}

export function emu(main: HTMLElement) {
  main.innerHTML = `
  <section class="emu">
    <b class="emu-tag">Virtual wedgie</b>
    <div id="emu-3d"></div>
    <div class="emu-note" id="emu-note"></div>
    <div class="emu-bar" hidden><div id="emu-bar-fill"></div></div>
    <div class="row emu-actions">
      <button class="btn btn-sm" id="emu-shot">Screenshot</button>
      <button class="btn btn-sm" id="emu-power">Replug</button>
      <button class="btn btn-sm" id="emu-wipe">Wipe</button>
    </div>
    <b class="emu-id" id="emu-id"></b>
    <div id="emu-status" hidden>Starting…</div>
  </section>`;
  document.body.classList.add("emu-page");   // the whole page dark, no site header or footer (emu.css)
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
  const shots: { t: number; png: string }[] = [];
  const st = { id: "", speed: 0, usb: false, owner: false, setup: "" as string, p: 0 };

  let note = "";        // a few seconds of "Saved X" over the status line
  const status = () => {
    const short = st.id.slice(-6).toUpperCase();
    const usb = !st.usb ? "USB: not up" : st.owner ? "USB: in use by a tab" : "USB: plugged in";
    // the full line stays in #emu-status (hidden) for agents and tools/emu.mjs; people see the ID, and a note when there is one
    $("emu-status").textContent = st.setup || note || `${short ? "ID " + short + " · " : ""}${Math.round(st.speed * 100)}% of real speed · ${usb}`;
    $("emu-id").textContent = short;
    $("emu-note").textContent = st.setup || note;
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
        shots.push({ t: Date.now(), png: "" });          // the last 60 screens, for a screen that flashed by
        if (shots.length > 60) shots.shift();
        const last = shots[shots.length - 1];
        last.png = screen.toDataURL("image/png");
        if (shots.length > 1 && shots[shots.length - 2].png === last.png) shots.pop();
        lg.drawImage(screen, 0, 0);
      } else if (m.t === "stat") {
        Object.assign(st, { id: m.id, speed: m.speed, usb: m.usb, owner: m.owner });
        status();
        if (m.bare && m.usb) setup();
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

    // ?no3d: just the screen, big (a headless browser has no GPU: tools/emu.mjs)
    if (new URLSearchParams(location.search).has("no3d")) {
      live.style.cssText = "width:480px;max-width:100%;image-rendering:pixelated;border-radius:10px";
      $("emu-3d").appendChild(live);
    } else place3D($("emu-3d"), { interactive: true, screen: live, eager: true, onKey: (k, down) => hold(k, down, "3d") }).then((w) => {
      w3d = w;
      w?.setColor("base", baseColor(null));      // no secure chip in it: the grey base of a chipless wedgie
    });

    $("emu-power").onclick = () => worker.postMessage({ t: "power" });
    $("emu-shot").onclick = () => shoot().catch((e) => { $("emu-status").textContent = "Screenshot didn't save: " + (e?.message || e); });
    $("emu-wipe").onclick = () => {
      if (!confirm("Wipe its flash? Apps and saves go, the firmware goes back to new. Its ID and its chip's keys stay, like a real one.")) return;
      worker.postMessage({ t: "wipe" });
    };

    async function shoot() {
      const big = document.createElement("canvas");
      big.width = big.height = 720;
      const bg = big.getContext("2d")!;
      bg.imageSmoothingEnabled = false;
      bg.drawImage(screen, 0, 0, 720, 720);
      const blob = await new Promise<Blob>((r) => big.toBlob((b) => r(b!), "image/png"));
      const name = `${st.id.slice(-6).toUpperCase()}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;
      const dir = await shotFolder();
      if (dir) {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(blob); await w.close();
        note = `Saved ${name} in ${dir.name}`; status();
        setTimeout(() => { note = ""; status(); }, 4000);
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    }

    // For an agent (or the console): the same presses a person makes.
    (window as any).wedgie = {
      press: (k: string, ms = MIN_HOLD) => new Promise<void>((r) => { hold(k, true); setTimeout(() => { hold(k, false); setTimeout(r, MIN_HOLD); }, ms); }),
      hold: (k: string, down: boolean) => hold(k, down),
      screen: () => screen.toDataURL("image/png"),
      /** The last n different screens, oldest first: [{t, png}] (t: Date.now() when drawn). */
      history: (n = 10) => shots.slice(-n),
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
    // ---- only MicroPython on it (no ready-made image, tools/emuimage.mjs): install the firmware and
    // Welcome over its USB, as the bench does a new board. Slow (~10 min).
    let setting = false;
    async function setup() {
      if (setting) return;
      setting = true;
      st.setup = "Setting up: waiting for its USB"; status();
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const r = new Repl((await findPort()) as unknown as SerialPort);
        for (let i = 0; ; i++) {          // a wedgie.dev tab may be identifying it: wait our turn
          try { await r.open(); break; } catch (e) { if (i > 20) throw e; await new Promise((res) => setTimeout(res, 1000)); }
        }
        try {
          const prog = (p: number, what: string) => { st.p = p; st.setup = `Setting up: ${what}`; status(); };
          const m = await firmwareManifest();
          await installCore(r, (p, w) => prog(p * 0.8, w), { launcher: false });
          const welcome = m.carts.find((c) => c.mod === "welcome");
          if (welcome) await useApp(r, welcome, (p, w) => prog(0.8 + p * 0.2, w), { launcher: false, manifest: m });
        } finally { await r.close(); }
        st.setup = ""; status();
        worker.postMessage({ t: "setup" });
        worker.postMessage({ t: "power" });        // unplugged and plugged back in: it boots its firmware
      } catch (e: any) {
        st.setup = `Setup failed: ${e?.message || e}. Wipe to try again.`; status();
      } finally { setting = false; }
    }
  }
}
