// A pretend wedgie for the 3D models around the site: the launcher and a few apps, hard-coded, on a
// 240x240 canvas the model shows as its screen. Joystick up/down picks, A (or joystick press) opens,
// X goes back, like firmware/menu.py. Left alone it drives itself; any press takes over.
import type { Wedgie3D } from "./wedgie3d";

type App = { name: string; draw: () => void; key?: (k: string) => void };

const img = (name: string) => { const i = new Image(); i.src = `/screens/${name}.png`; return i; };
const SHOTS = {
  hello: img("hello"), demo: img("demo"), demo2: img("demo-2"), clear: img("clear-sign"),
  wallet: ["wallet-home", "wallet-chart", "wallet-send", "wallet-receive", "wallet-signing"].map(img),
};

export function createDemo(id = "WEDGIE", opts: { boot?: boolean } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  const g = canvas.getContext("2d")!;
  const held = new Set<string>(), seen = new Set<string>();
  let sel = 0, app: App | null = null, demoScene = 0, walletPage = 0;
  let w3d: Wedgie3D | null = null;

  const pic = (i: HTMLImageElement) => { g.fillStyle = "#000"; g.fillRect(0, 0, 240, 240); if (i.complete) g.drawImage(i, 0, 0); };
  const text = (s: string, x: number, y: number, c: string, px = 8, align: CanvasTextAlign = "left") => {
    g.fillStyle = c; g.font = `${px}px Silkscreen, monospace`; g.textAlign = align; g.textBaseline = "top"; g.fillText(s, x, y);
  };

  const apps: App[] = [
    { name: "Hello", draw: () => pic(SHOTS.hello) },
    { name: "Buttons", draw: drawButtons, key: (k) => seen.add(k) },
    { name: "Demo", draw: () => pic(demoScene ? SHOTS.demo2 : SHOTS.demo), key: (k) => { if (k === "A") demoScene ^= 1; } },
    { name: "Wallet look", draw: () => pic(SHOTS.wallet[walletPage]), key: (k) => {
      if (k === "right") walletPage = (walletPage + 1) % SHOTS.wallet.length;
      if (k === "left") walletPage = (walletPage + SHOTS.wallet.length - 1) % SHOTS.wallet.length;
      if (k === "A" && walletPage === 2) walletPage = 4;           // send -> signing
      if (k === "Y") walletPage = 0;
    } },
    { name: "Clear sign", draw: () => pic(SHOTS.clear) },
  ];

  function drawLauncher() {                  // menu.py's draw()
    g.fillStyle = "#fefefe"; g.fillRect(0, 0, 240, 240);
    [["#22c452", 10], ["#a9aaab", 19], ["#e3312c", 28]].forEach(([c, y]) => { g.fillStyle = c as string; g.fillRect(0, y as number, 240, 5); });
    text("wedgie", 6, 42, "#1a1b1a"); text(id.slice(-6), 234, 42, "#787b78", 8, "right");
    const first = Math.max(0, Math.min(sel - 3, apps.length - 4));
    for (let r = 0; r < 4; r++) {
      const i = first + r, y = 58 + r * 40;
      if (!apps[i]) break;
      if (i === sel) { g.fillStyle = "#22c452"; g.fillRect(9, y, 222, 36); g.fillStyle = "#168c34"; g.fillRect(9, y + 32, 222, 4); text(apps[i].name, 22, y + 10, "#fefefe", 16); }
      else { g.strokeStyle = "#e2e2dd"; g.lineWidth = 1; g.strokeRect(9.5, y + 0.5, 221, 35); text(apps[i].name, 22, y + 10, "#1a1b1a", 16); }
    }
    text("A open", 8, 226, "#787b78"); text(`${sel + 1}/${apps.length}`, 234, 226, "#787b78", 8, "right");
  }

  function drawButtons() {                   // keytest.py, roughly: every key, lit while held
    g.fillStyle = "#000"; g.fillRect(0, 0, 240, 240);
    text("KEY TEST", 4, 4, "#ffdc00");
    const S = 34, JX = 20, JY = 96;
    const box: Record<string, [number, number, number, number, string]> = {
      up: [JX + S + 4, JY - S - 4, S, S, "UP"], down: [JX + S + 4, JY + S + 4, S, S, "DN"], left: [JX, JY, S, S, "LT"],
      right: [JX + 2 * (S + 4), JY, S, S, "RT"], press: [JX + S + 4, JY, S, S, "IN"],
      A: [170, 14, 52, 46, "A"], B: [170, 70, 52, 46, "B"], X: [170, 126, 52, 46, "X"], Y: [170, 182, 52, 46, "Y"],
    };
    for (const [k, [x, y, w, h, l]] of Object.entries(box)) {
      const on = held.has(k);
      g.fillStyle = on ? "#00ff00" : "#1e1e1e"; g.fillRect(x, y, w, h);
      g.strokeStyle = on ? "#fff" : seen.has(k) ? "#22c452" : "#787878"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      text(l, x + w / 2, y + h / 2 - 4, on ? "#000" : "#fff", 8, "center");
    }
    text(`${seen.size}/9 keys seen`, 4, 216, seen.size === 9 ? "#00ff00" : "#fff");
    text("X quits", 4, 228, "#787878");
  }

  // Boot: the device's own boot screen (splash.py's underwear, loader.py's bar filling grey, then green).
  const logo = new Image();
  logo.src = "/img/loader-logo.webp";
  let bootT = opts.boot ? 0 : 1;
  function drawBoot() {
    g.fillStyle = "#fefefe"; g.fillRect(0, 0, 240, 240);
    if (logo.complete) g.drawImage(logo, 72, 74, 96, 77);
    const x = 45, y = 166, w = 150, h = 30;
    const pill = (px: number, py: number, pw: number, ph: number, c: string | CanvasGradient) => { g.fillStyle = c; g.beginPath(); g.roundRect(px, py, pw, ph, ph / 2); g.fill(); };
    pill(x, y, w, h, "#eceded");
    pill(x + 11, y + 7, w - 22, h - 14, "#c9cacc");
    const f = Math.min(1, bootT / 0.8), gr = g.createLinearGradient(0, y + 9, 0, y + 21);
    if (bootT >= 0.85) { gr.addColorStop(0, "#46cd64"); gr.addColorStop(1, "#168c34"); } else { gr.addColorStop(0, "#7c7d7f"); gr.addColorStop(1, "#48494b"); }
    pill(x + 13, y + 9, 12 + (w - 38) * f, h - 18, gr);
  }
  const draw = () => (bootT < 1 ? drawBoot() : app ? app.draw() : drawLauncher());

  function key(k: string, down: boolean) {
    if (down) held.add(k); else held.delete(k);
    if (down) {
      if (app) {
        if (k === "X") app = null;
        else app.key?.(k);
      } else if (k === "up") sel = (sel + apps.length - 1) % apps.length;
      else if (k === "down") sel = (sel + 1) % apps.length;
      else if (k === "A" || k === "press") { app = apps[sel]; demoScene = 0; walletPage = 0; seen.clear(); }
    }
    draw();
  }

  // Left alone, it shows itself off: down, down, A, look around, X... Any real press pauses it a while.
  const TOUR: [string, number][] = [["down", 900], ["down", 900], ["down", 900], ["A", 1800], ["right", 1400], ["right", 1400],
    ["A", 2200], ["X", 1200], ["up", 900], ["up", 900], ["A", 1800], ["A", 1800], ["X", 1200], ["up", 900], ["A", 2000], ["X", 1400]];
  let step = 0, timer = 0, idleUntil = 0;
  function tour() {
    timer = window.setTimeout(() => {
      if (performance.now() < idleUntil) { tour(); return; }
      const [k] = TOUR[step % TOUR.length];
      key(k, true); w3d?.keyVisual(k, true);
      setTimeout(() => { key(k, false); w3d?.keyVisual(k, false); }, 160);
      step++;
      tour();
    }, TOUR[step % TOUR.length][1]);
  }
  Object.values(SHOTS).flat().forEach((i) => i.addEventListener("load", draw));
  document.fonts?.ready.then(draw);
  draw();
  if (bootT < 1) {
    const BOOT = 1900;           // green (0.85) at ~1.6 s: right as the fly-in lands (wedgie3d GROW)
    const tick = () => {
      bootT = Math.min(1, (performance.now() - (tick as any).t0) / BOOT);
      draw();
      if (bootT < 1) requestAnimationFrame(tick); else setTimeout(tour, 1200);
    };
    // start when the page is actually showing (the site loader covers it until html.ready)
    const go = () => { const t = performance.now(); (tick as any).t0 = t; requestAnimationFrame(tick); };
    const whenShown = () => (document.documentElement.classList.contains("ready") ? go() : setTimeout(whenShown, 50));
    logo.decode?.().catch(() => {}).finally(whenShown);
  } else tour();

  return {
    canvas,
    /** a person pressed something: they drive now; the tour waits until they've been idle a while */
    key(k: string, down: boolean) { idleUntil = performance.now() + 12000; key(k, down); },
    attach(w: Wedgie3D | null) { w3d = w; },
    stop() { clearTimeout(timer); },
  };
}
