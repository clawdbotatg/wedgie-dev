// A pretend wedgie for the 3D models around the site: real screens of the shelf's apps (tools/screens.mjs)
// on a 240x240 canvas the model shows as its screen. Like the real one (firmware/slot.py) it runs one app
// and every button is the app's. Left alone it drives itself, and now and then restarts into the next app
// (what picking another at wedgie.dev/connect does); any press takes over.
import type { Wedgie3D } from "./wedgie3d";

type App = { name: string; draw: () => void; key?: (k: string) => void };

const img = (name: string) => { const i = new Image(); i.src = `/screens/${name}.png`; return i; };
const SHOTS = {
  safe: ["safe-home", "safe-sign"].map(img),
  frog: ["frog", "frog-feed", "frog-eat"].map(img),
  bunker: ["bunker-title", "bunker", "bunker-2"].map(img),
};

export function createDemo(id = "WEDGIE", opts: { boot?: boolean } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  const g = canvas.getContext("2d")!;
  const held = new Set<string>();
  let cur = 0, safePage = 0, frogPage = 0, bunkerPage = 0;
  let w3d: Wedgie3D | null = null;

  const pic = (i: HTMLImageElement) => { g.fillStyle = "#000"; g.fillRect(0, 0, 240, 240); if (i.complete) g.drawImage(i, 0, 0); };

  // Safe signer: home, then a transaction comes in from the computer; A signs, Y says no (both: home)
  const apps: App[] = [
    { name: "Safe signer", draw: () => pic(SHOTS.safe[safePage]), key: (k) => {
      if (k === "sign") safePage = 1;
      else if (k === "A" || k === "Y") safePage = 0;
    } },
    { name: "Frog", draw: () => pic(SHOTS.frog[frogPage]), key: (k) => {
      if (k === "A") frogPage = frogPage === 0 ? 1 : frogPage === 1 ? 2 : 0;
      if (k === "Y") frogPage = 0;
    } },
    { name: "Demon Bunker", draw: () => pic(SHOTS.bunker[bunkerPage]), key: (k) => {
      if (k === "A" && bunkerPage === 0) bunkerPage = 1;
      else if (k === "up" && bunkerPage) bunkerPage = 2;
      else if (k === "down" && bunkerPage) bunkerPage = 1;
    } },
  ];

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
  const draw = () => (bootT < 1 ? drawBoot() : apps[cur].draw());

  function key(k: string, down: boolean) {
    if (down) held.add(k); else held.delete(k);
    if (down && bootT >= 1) apps[cur].key?.(k);
    draw();
  }

  // Left alone, it shows itself off: a few presses in each app ("" = a restart into the next one,
  // boot screen and all; "sign" = a Safe transaction arriving over USB). Any real press pauses it a while.
  const TOUR: [string, number][] = [
    ["sign", 2400], ["A", 3600], ["", 2600],                                   // Safe signer, then restart
    ["A", 2400], ["A", 1800], ["", 2400],                                      // Frog
    ["A", 1600], ["up", 1800], ["", 2000]];                                    // Demon Bunker, back to Safe signer
  cur = 0;
  let step = 0, timer = 0, idleUntil = 0;
  function restart() {                // the next app, like picking it at wedgie.dev: the wedgie reboots into it
    cur = (cur + 1) % apps.length; safePage = frogPage = bunkerPage = 0;
    boot(() => {});
  }
  function tour() {
    timer = window.setTimeout(() => {
      if (performance.now() < idleUntil) { tour(); return; }
      const [k] = TOUR[step % TOUR.length];
      if (!k) restart();
      else if (k === "sign") { apps[cur].key?.(k); draw(); }
      else { key(k, true); w3d?.keyVisual(k, true); setTimeout(() => { key(k, false); w3d?.keyVisual(k, false); }, 160); }
      step++;
      tour();
    }, TOUR[step % TOUR.length][1]);
  }
  function boot(then: () => void) {
    const BOOT = 1200;           // green (0.85) at ~1.0 s: right as the fly-in lands (wedgie3d GROW)
    const t0 = performance.now();
    bootT = 0;
    const tick = () => {
      bootT = Math.min(1, (performance.now() - t0) / BOOT);
      draw();
      if (bootT < 1) requestAnimationFrame(tick); else then();
    };
    requestAnimationFrame(tick);
  }
  Object.values(SHOTS).flat().forEach((i) => i.addEventListener("load", draw));
  document.fonts?.ready.then(draw);
  draw();
  if (bootT < 1) {
    // start when the page is actually showing (the site loader covers it until html.ready)
    const go = () => boot(() => setTimeout(tour, 1200));
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
