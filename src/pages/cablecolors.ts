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

const clean = (v: string | null | undefined) => {
  const names = (v || "").split(",").map((s) => s.trim().toLowerCase()).map((s) => Object.keys(PALETTE).find((k) => k.toLowerCase() === s));
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
  if (isKit(w)) q.delete("wires"); else q.set("wires", w.map((c) => c.toLowerCase()).join(","));
  const s = q.toString();
  history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
}

export const hex = (name: string) => PALETTE[name] || "#999";
