// Put a 3D wedgie in an element once it's near the screen. Until then (and if WebGL isn't there) the
// drawn wedgie stays. three.js and the case geometry load once, on the first one.
import type { Wedgie3D, Wedgie3DOptions } from "./wedgie3d";
import { deviceSvg, type Screen } from "./device";

// Building a 3D scene ties up the main thread for a moment; never let that hold the page back. Wait
// until the site is showing (the loader adds html.ready), then a frame more.
export const pageShown = new Promise<void>((r) => {
  const check = () => (document.documentElement.classList.contains("ready") ? requestAnimationFrame(() => setTimeout(r, 0)) : requestAnimationFrame(check));
  check();
});

export function place3D(el: HTMLElement, opts: Wedgie3DOptions & { fallback?: Screen; demo?: string; boot?: boolean } = {}): Promise<Wedgie3D | null> {
  if (!el.firstChild) el.innerHTML = deviceSvg(opts.fallback || { kind: "off" });
  // demo: a clickable pretend wedgie (launcher + apps, hard-coded) instead of a still screen
  const demo = opts.demo !== undefined ? import("./demo").then((m) => m.createDemo(opts.demo, { boot: opts.boot })) : null;
  return new Promise((resolve) => {
    const io = new IntersectionObserver(async (es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      try {
        await pageShown;
        const { mountWedgie3D } = await import("./wedgie3d");
        const d = demo ? await demo : null;
        const holder = document.createElement("div");
        holder.className = "w3d-holder";
        el.replaceChildren(holder);
        const w = await mountWedgie3D(holder, d ? { ...opts, interactive: true, screen: d.canvas, screens: undefined, onKey: (k, down) => { holder.dataset.lastKey = `${k} ${down ? "down" : "up"}`; d.key(k, down); } } : opts);
        d?.attach(w);
        resolve(w);
      } catch (err) {
        console.error("3D wedgie:", err);
        el.innerHTML = deviceSvg(opts.fallback || { kind: "off" });
        resolve(null);
      }
    }, { rootMargin: "400px" });
    io.observe(el);
  });
}

/** The screen the wedgie firmware paints for "show ID" (probe.py ident): white, the waistband, the ID. */
export function idScreen(id: string, sub = "", canvas = document.createElement("canvas")) {
  canvas.width = canvas.height = 240;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fefefe"; g.fillRect(0, 0, 240, 240);
  [["#22c452", 44], ["#a9aaab", 58], ["#e3312c", 72]].forEach(([c, y]) => { g.fillStyle = c as string; g.fillRect(0, y as number, 240, 8); });
  g.fillStyle = "#1a1b1a"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `${id.length > 7 ? 30 : 38}px Silkscreen, monospace`;
  g.fillText(id, 120, 126);
  if (sub) { g.fillStyle = "#6b6e6b"; g.font = "14px Silkscreen, monospace"; g.fillText(sub, 120, 176); }
  return canvas;
}

/** A plain color screen (the screen test). */
export function colorScreen(css: string, canvas = document.createElement("canvas")) {
  canvas.width = canvas.height = 240;
  const g = canvas.getContext("2d")!;
  g.fillStyle = css; g.fillRect(0, 0, 240, 240);
  return canvas;
}

export const SCREENS = {
  apps: ["/screens/launcher.png", "/screens/hello.png", "/screens/demo.png", "/screens/buttons.png", "/screens/demo-2.png"],
  wallet: ["/screens/wallet-home.png", "/screens/wallet-chart.png", "/screens/wallet-send.png", "/screens/wallet-signing.png", "/screens/wallet-receive.png", "/screens/clear-sign.png"],
};
