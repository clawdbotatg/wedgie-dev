import { P } from "./palette";
// The wedgie's boot screen on the page: the undies logo (/fw/logo.bin) and the boot bar (/fw/bar.bin),
// decoded from the same files the wedgie draws them from (firmware/loader.py screen / _Bar), so the
// page's picture of an install matches the real screen. One progress bar everywhere (CLAUDE.md).
type Img = { x: number; y: number; w: number; h: number; px: Uint8Array };
let logo: Img & { bg: number } | null = null;
let bar: { X: number; Y: number; W: number; H: number; F0: number; F1: number; CW: number; CR: number; L: number; R: number; T0: number; TH: number;
  empty: Uint8Array; full: Uint8Array; cap: Uint8Array; green: Uint8Array } | null = null;
let loading: Promise<void> | null = null;
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 240;
let last: [string, string, number] = ["", "", 0];

function load() {
  return loading ||= Promise.all(["logo.bin", "bar.bin"].map((n) => fetch("/fw/" + n).then((r) => r.arrayBuffer()))).then(([lb, bb]) => {
    const l = new DataView(lb);
    logo = { x: l.getUint16(0), y: l.getUint16(2), w: l.getUint16(4), h: l.getUint16(6), bg: l.getUint16(8), px: new Uint8Array(lb, 10) };
    const b = new DataView(bb), h = [...Array(12)].map((_, i) => b.getUint16(i * 2));
    const [X, Y, W, H, F0, F1, CW, CR, L, R, T0, TH] = h;
    const e = H * (L + 1 + R) * 2, t = TH * (L + 1 + R) * 2, c = TH * CW * 2;
    const u = new Uint8Array(bb);
    bar = { X, Y, W, H, F0, F1, CW, CR, L, R, T0, TH, empty: u.subarray(24, 24 + e), full: u.subarray(24 + e, 24 + e + t),
      cap: u.subarray(24 + e + t, 24 + e + t + c), green: u.subarray(24 + e + t + c, 24 + e + t + c + t) };
    draw(...last);
  }).catch(() => {});
}


/** A piece of bar.bin (rows tall: left block, one middle column, right block), columns a..b at strip row y0. */
function piece(img: ImageData, s: Uint8Array, rows: number, y0: number, a: number, b: number) {
  const { X, Y, W, L, R } = bar!;
  const at = (r: number, c: number) => {         // strip column c of row r -> byte offset in s
    if (c < L) return (r * L + c) * 2;
    if (c >= W - R) return (rows * (L + 1) + r * R + c - (W - R)) * 2;
    return (rows * L + r) * 2;
  };
  for (let r = 0; r < rows; r++) for (let c = a; c < b; c++) {
    const i = at(r, c), v = s[i] << 8 | s[i + 1], o = ((Y + y0 + r) * 240 + X + c) * 4;
    img.data[o] = ((v >> 11) & 31) * 255 / 31; img.data[o + 1] = ((v >> 5) & 63) * 255 / 63; img.data[o + 2] = (v & 31) * 255 / 31; img.data[o + 3] = 255;
  }
}

function draw(title: string, what: string, p: number) {
  const g = canvas.getContext("2d")!;
  if (!logo || !bar) { g.fillStyle = P.WHITE; g.fillRect(0, 0, 240, 240); return; }
  const img = g.createImageData(240, 240);
  const bg = logo.bg;
  for (let i = 0; i < 240 * 240; i++) { img.data[i * 4] = ((bg >> 11) & 31) * 255 / 31; img.data[i * 4 + 1] = ((bg >> 5) & 63) * 255 / 63; img.data[i * 4 + 2] = (bg & 31) * 255 / 31; img.data[i * 4 + 3] = 255; }
  for (let r = 0; r < logo.h; r++) for (let c = 0; c < logo.w; c++) {
    const i = (r * logo.w + c) * 2, v = logo.px[i] << 8 | logo.px[i + 1], o = ((logo.y + r) * 240 + logo.x + c) * 4;
    img.data[o] = ((v >> 11) & 31) * 255 / 31; img.data[o + 1] = ((v >> 5) & 63) * 255 / 63; img.data[o + 2] = (v & 31) * 255 / 31; img.data[o + 3] = 255;
  }
  // loader._Bar.to: the fill ends at p (strip columns), the cap rides on its end; full is green
  const B = bar, extra = B.CW - B.CR;
  piece(img, B.empty, B.H, 0, 0, B.W);
  const end = Math.max(B.F0 + Math.floor((B.F1 - B.F0) * p), B.F0 + 2 * B.CR);
  if (p >= 1) piece(img, B.green, B.TH, B.T0, 0, B.W);
  else if (end >= B.F1 - extra) piece(img, B.full, B.TH, B.T0, 0, B.W);
  else {
    piece(img, B.full, B.TH, B.T0, 0, end - B.CR);
    for (let r = 0; r < B.TH; r++) for (let c = 0; c < B.CW; c++) {
      const i = (r * B.CW + c) * 2, v = B.cap[i] << 8 | B.cap[i + 1], o = ((B.Y + B.T0 + r) * 240 + B.X + end - B.CR + c) * 4;
      img.data[o] = ((v >> 11) & 31) * 255 / 31; img.data[o + 1] = ((v >> 5) & 63) * 255 / 63; img.data[o + 2] = (v & 31) * 255 / 31; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.textAlign = "center"; g.textBaseline = "top";
  g.fillStyle = P.INK; g.font = "16px Silkscreen, monospace";
  const words = title.split(/\s+/), lines = [""];
  for (const w of words) { if (lines[lines.length - 1] && (lines[lines.length - 1] + " " + w).length > 15) lines.push(""); lines[lines.length - 1] = (lines[lines.length - 1] + " " + w).trim(); }
  const ls = lines.filter(Boolean).slice(0, 2);
  ls.forEach((s, i) => g.fillText(s, 120, (ls.length === 1 ? 30 : 16) + i * 24));
  if (what) { g.fillStyle = P.MUTED; g.font = "8px Silkscreen, monospace"; g.fillText(what.slice(0, 28), 120, 214); }
}

/** The boot screen with the bar at p (0..1): one canvas, redrawn in place (the 3D wedgie shows it live). */
export function bootScreen(title: string, what: string, p: number) {
  last = [title, what, p];
  draw(title, what, p);
  load();
  return canvas;
}
