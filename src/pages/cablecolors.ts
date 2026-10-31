// Your STEMMA QT cable's wire colors. The manual is written for the kit's cable: white, yellow, black, red,
// top to bottom, plugged into the Trust M's left socket. Another cable maps each of those to its own color
// (the box at the top of /assemble), and the manual (/assemble, /assemble/3d) then says yours.
// Kept in this browser and in the link (?wires=purple,green,blue,orange), so a link carries it.
// No DOM at import: tools/asmpdf.mjs loads assemble.ts in node.

export const PALETTE: Record<string, string> = {
  White: "#f4f4ef", Yellow: "#f2c417", Black: "#232323", Red: "#d8262a", Blue: "#2f6fd6",
  Green: "#22a64a", Orange: "#f07a1a", Purple: "#8a3fd1", Brown: "#7a4a26", Gray: "#9a9da1",
};
export const KIT = ["White", "Yellow", "Black", "Red"];
const KEY = "wedgie.wires";

// A wire is a palette name, or "#rrggbb" from the color picker (in the link without the #).
const one = (v: string) => {
  v = v.trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(v)) return "#" + v.replace("#", "");
  return Object.keys(PALETTE).find((k) => k.toLowerCase() === v);
};
const clean = (v: string | null | undefined) => {
  const names = (v || "").split(",").map(one);
  return names.length === 4 && names.every(Boolean) ? (names as string[]) : null;
};

/** The 4 colors of your cable, in the kit's order (what's in place of white, yellow, black, red). */
export function wires(): string[] {
  if (typeof location === "undefined") return KIT;
  const url = clean(new URLSearchParams(location.search).get("wires"));
  if (url) { try { localStorage.setItem(KEY, url.join(",")); } catch {} return url; }
  let saved: string[] | null = null;
  try { saved = clean(localStorage.getItem(KEY)); } catch {}
  return saved || KIT;
}

export const isKit = (w: string[]) => w.every((c, i) => c === KIT[i]);

export function setWires(w: string[]) {
  const q = new URLSearchParams(location.search);
  try { if (isKit(w)) localStorage.removeItem(KEY); else localStorage.setItem(KEY, w.join(",")); } catch {}
  if (isKit(w)) q.delete("wires"); else q.set("wires", w.map((c) => c.toLowerCase().replace("#", "")).join(","));
  const s = q.toString();
  history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
}

export const hex = (c: string) => c.startsWith("#") ? c : PALETTE[c] || "#999";

// A picked color's word in the steps: the nearest of these (the swatch shows the real color).
const NAMED: Record<string, string> = {
  ...PALETTE, Pink: "#f06aa8", "Hot pink": "#e0218a", Teal: "#139a94", Cyan: "#22c3e6", "Light blue": "#8cc4ff",
  Navy: "#1f2f6b", Lime: "#a4d82a", "Dark green": "#1d5a2a", Maroon: "#7a1f2a", Tan: "#d2b48c", Gold: "#c9a227",
  Violet: "#b48cf0", Silver: "#c8c9cc", "Dark gray": "#55575a",
};
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** What to call a wire in words. */
export function label(c: string) {
  if (!c.startsWith("#")) return c;
  const [r, g, b] = rgb(c);
  let best = "Custom", d = Infinity;
  for (const [n, h] of Object.entries(NAMED)) {
    const [R, G, B] = rgb(h), e = 2 * (r - R) ** 2 + 4 * (g - G) ** 2 + 3 * (b - B) ** 2;
    if (e < d) { d = e; best = n; }
  }
  return best;
}
