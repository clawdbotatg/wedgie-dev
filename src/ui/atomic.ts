// The atomic wedgie's picture (the front page and /atomic): a 1940s comic burst, electron orbits, and the 3D wedgie
// on its red base, signing on a Safe with no cable. The burst is drawn here (an SVG), the wedgie is the real one
// (place3d.ts) with its base reprinted red.
import "./atomic.css";
import { place3D } from "./place3d";

/** The atomic wedgie's base: red PETG, as /build draws it. */
export const ATOMIC_RED = 0xc0282d;
/** What the buyer gets to plug in: these are on /atomic and in public/build.md too. */
export const BOARD = { name: "Waveshare RP2040-Plus", url: "https://www.waveshare.com/rp2040-plus.htm" };
export const BATTERY = { name: "601120 LiPo", volts: "3.7 V", mah: 100, wh: "0.37 Wh", plug: "MX1.25" };
export const CASE_FILES = "https://github.com/clawdbotatg/clawd-pico-case/tree/main/stl/atomic-wedgie";

// A comic burst: n spikes, each a little off (the same every time: no Math.random, the page must not jump on a reload).
function burst(n: number, r0: number, r1: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2 + (rnd() - 0.5) * 0.08;
    const r = i % 2 ? r0 * (0.92 + rnd() * 0.12) : r1 * (0.82 + rnd() * 0.22);
    pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r * 0.78).toFixed(1)}`);
  }
  return pts.join(" ");
}

const BURST = burst(17, 150, 232, 7), INNER = burst(17, 128, 196, 7);
const ART = `<svg class="atom-burst" viewBox="-260 -200 520 400" aria-hidden="true">
  <defs><pattern id="atom-dots" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><circle cx="4.5" cy="4.5" r="2" fill="var(--ink)" opacity=".2"/></pattern></defs>
  <polygon class="atom-shadow" points="${BURST}" transform="translate(9 11)"/>
  <polygon class="atom-star" points="${BURST}"/>
  <polygon points="${INNER}" fill="url(#atom-dots)"/>
  <polygon class="atom-core" points="${burst(17, 96, 150, 7)}"/>
  <g class="atom-orbits">
    <g transform="rotate(-24)"><ellipse rx="212" ry="64"/><circle class="e e1" r="8"/></g>
    <g transform="rotate(24)"><ellipse rx="212" ry="64"/><circle class="e e2" r="8"/></g>
  </g>
</svg>`;

/** Fill `el` with the picture. words: the comic title over it (the front page; /atomic has its own h1). */
export function atomicArt(el: HTMLElement, opts: { words?: boolean; eager?: boolean } = {}) {
  el.classList.add("atom-art");
  el.innerHTML = `${ART}<div class="atom-dev"></div>${opts.words ? `<div class="atom-words" aria-hidden="true"><b>Atomic</b><b>wedgie!</b></div>` : ""}<span class="atom-pow" aria-hidden="true">No cord!</span>`;
  // A picture, not a toy (clicks go to the link around it): the Safe Signer's home, then a transaction to sign.
  return place3D(el.querySelector<HTMLElement>(".atom-dev")!, { interactive: false, eager: opts.eager, side: -1, pose: { x: -0.42, y: 0.32 },
    screens: ["/screens/safe-home.png", "/screens/safe-sign.png"], fallback: { kind: "off" } })
    .then((w) => { w?.setColor("base", ATOMIC_RED); return w; });
}
