// The wedgie, drawn: held landscape like the real one, USB-C on the left end, joystick left of the
// screen, A B X Y down the right edge (A green on top, Y red at the bottom). White printed lid over a
// black base. Colours from picowallet emu/web/device3d.js.
export type Screen =
  | { kind: "off" }
  | { kind: "loading"; p: number }
  | { kind: "id"; id: string; sub?: string }
  | { kind: "color"; css: string }
  | { kind: "text"; text: string };

export const KEYS = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"] as const;

let n = 0;

export function deviceSvg(screen: Screen, opts: { cls?: string } = {}) {
  const i = ++n;
  const btn = (k: string, y: number, fill: string) => `
    <g class="k" data-k="${k}">
      <rect x="276" y="${y}" width="44" height="28" rx="11" fill="url(#bw${i})" />
      <rect class="cap" x="280" y="${y + 2}" width="36" height="22" rx="9" fill="${fill}" />
      <rect x="283" y="${y + 4}" width="30" height="7" rx="3.5" fill="#fff" opacity=".22" />
      <text x="298" y="${y + 18}" text-anchor="middle" class="kl">${k}</text>
    </g>`;
  return `<svg class="wedgie ${opts.cls || ""}" viewBox="-14 -8 368 214" role="img" aria-label="a wedgie">
  <defs>
    <linearGradient id="lid${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e9e8e3"/></linearGradient>
    <linearGradient id="bw${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfcec9"/><stop offset="1" stop-color="#ecebe6"/></linearGradient>
    <radialGradient id="joy${i}" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#7a7a80"/><stop offset="1" stop-color="#434347"/></radialGradient>
    <linearGradient id="well${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9c8c3"/><stop offset="1" stop-color="#eeede8"/></linearGradient>
    <filter id="sh${i}" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="9" flood-color="#000" flood-opacity=".22"/></filter>
    <clipPath id="scr${i}"><rect x="118" y="38" width="104" height="104" rx="3"/></clipPath>
  </defs>
  <g filter="url(#sh${i})">
    <rect x="-2" y="8" width="344" height="184" rx="38" fill="#141416"/>
    <rect x="-10" y="80" width="14" height="30" rx="5" fill="#2a2a2d"/>
    <rect x="-7" y="86" width="8" height="18" rx="3" fill="#0b0b0c"/>
    <rect x="0" y="0" width="340" height="182" rx="36" fill="url(#lid${i})"/>
    <rect x="1.5" y="1.5" width="337" height="179" rx="35" fill="none" stroke="#fff" stroke-width="3" opacity=".9"/>
    <rect x="0" y="0" width="340" height="182" rx="36" fill="none" stroke="#d6d5d0" stroke-width="1"/>
  </g>
  <rect x="104" y="24" width="132" height="132" rx="14" fill="url(#well${i})"/>
  <rect x="110" y="30" width="120" height="120" rx="8" fill="#101012"/>
  <g clip-path="url(#scr${i})" class="scr">${screenSvg(screen, i)}</g>
  <rect x="118" y="38" width="104" height="36" rx="3" fill="#fff" opacity=".05" />
  <g class="joy">
    <circle cx="58" cy="90" r="34" fill="url(#well${i})"/>
    <circle cx="58" cy="90" r="29" fill="#e2e1dc"/>
    <g class="k" data-k="press"><circle class="cap" cx="58" cy="90" r="20" fill="url(#joy${i})"/><circle cx="52" cy="83" r="7" fill="#fff" opacity=".18"/></g>
    <path class="k arrow" data-k="up" d="M58 55 l6 7 h-12z"/><path class="k arrow" data-k="down" d="M58 125 l6 -7 h-12z"/>
    <path class="k arrow" data-k="left" d="M23 90 l7 -6 v12z"/><path class="k arrow" data-k="right" d="M93 90 l-7 -6 v12z"/>
  </g>
  ${btn("A", 26, "#27b04b")}${btn("B", 62, "#77777b")}${btn("X", 98, "#77777b")}${btn("Y", 134, "#d7263d")}
</svg>`;
}

function screenSvg(s: Screen, i: number): string {
  const X = 118, Y = 38, W = 104;
  const bg = (c: string) => `<rect x="${X}" y="${Y}" width="${W}" height="${W}" fill="${c}"/>`;
  switch (s.kind) {
    case "off":
      return bg("#16161a");
    case "color":
      return bg(s.css);
    case "loading": {
      const fw = 10 + 44 * s.p;
      return bg("#fff") +
        `<image href="/img/sticker.webp" x="${X + 32}" y="${Y + 26}" width="40" height="30"/>` +
        `<rect x="${X + 22}" y="${Y + 66}" width="60" height="13" rx="6.5" fill="#f1f1f1" stroke="#dcdcdc" stroke-width=".8"/>` +
        `<rect x="${X + 26}" y="${Y + 69.5}" width="52" height="6" rx="3" fill="#c9cacc"/>` +
        `<rect x="${X + 27}" y="${Y + 70.5}" width="${fw}" height="4" rx="2" fill="${s.p >= 1 ? "#22c452" : "#5f6062"}"/>`;
    }
    case "id":
      return bg("#fff") +
        `<rect x="${X}" y="${Y + 18}" width="${W}" height="4" fill="#22c452"/>` +
        `<rect x="${X}" y="${Y + 25}" width="${W}" height="4" fill="#a9aaab"/>` +
        `<rect x="${X}" y="${Y + 32}" width="${W}" height="4" fill="#e3312c"/>` +
        `<text x="${X + W / 2}" y="${Y + 66}" text-anchor="middle" class="lcd lcd-big">${esc(s.id)}</text>` +
        (s.sub ? `<text x="${X + W / 2}" y="${Y + 84}" text-anchor="middle" class="lcd lcd-sub">${esc(s.sub)}</text>` : "");
    case "text":
      return bg("#101014") + `<text x="${X + 6}" y="${Y + 16}" class="lcd lcd-txt">${esc(s.text)}</text>`;
  }
  void i;
}

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Light a key on a drawn wedgie: down (held) or done (pressed and released at least once). */
export function setKey(root: Element, key: string, state: "down" | "done" | "" ) {
  root.querySelectorAll(`[data-k="${key}"]`).forEach((el) => {
    el.classList.toggle("down", state === "down");
    if (state === "done") el.classList.add("done");
    if (state === "") el.classList.remove("done");
  });
}
