// A cartridge: the grey Game Boy-style shell every wedgie app comes in, with the app's label (its color,
// its 12x12 pixel icon from firmware/carts.json, its name). Drawn in HTML/CSS (style.css: .cart).
import { esc } from "./device";
import type { Cart } from "../serial/install";

const PAL: Record<string, string> = { k: "#1a1b1a", w: "#fefefe", g: "#22c452", r: "#e3312c", y: "#ffd21f", b: "#2f7df6", s: "#a9aaab" };
const icons = new Map<string, string>();

/** The pixel icon as a data URL (drawn once per cart). */
export function iconUrl(c: Pick<Cart, "mod" | "icon">) {
  let u = icons.get(c.mod);
  if (u) return u;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 12;
  const g = cv.getContext("2d")!;
  (c.icon || []).forEach((row, y) => [...row].forEach((ch, x) => { if (PAL[ch]) { g.fillStyle = PAL[ch]; g.fillRect(x, y, 1, 1); } }));
  u = cv.toDataURL();
  icons.set(c.mod, u);
  return u;
}

/** The cart's inner HTML (inside a <button class="cart">). */
export function cartHtml(c: Cart) {
  // .cart (the button) carries the shadow; .cart-body is clipped to the shell's cut corner.
  return `<span class="cart-body"><span class="cart-ridges"></span>
    <span class="cart-label" style="--label:${esc(c.label || "#8a8c8e")}">
      <img class="cart-icon" src="${iconUrl(c)}" alt="" width="48" height="48">
      <span class="cart-name">${esc(c.name)}</span>
      <span class="cart-meter"><i></i></span>
    </span>
    <span class="cart-state"></span></span>`;
}

/** A small cart for a one-line summary ("Software: [cart] Wallet playing"). */
export function miniCart(c: Pick<Cart, "mod" | "icon" | "label">) {
  return `<span class="mini-cart" style="--label:${esc(c.label || "#8a8c8e")}"><img src="${iconUrl(c)}" alt="" width="12" height="12"></span>`;
}
