// /build: pick a wedgie — its app, its secure chip (or none), the color of every printed part —
// and the URL becomes that wedgie (/build?app=usbwallet&chip=atecc&lid=white&...). Anyone with the link
// sees the same one and can buy it or build it from the list below. Firmware is always the latest.
import "./build.css";
import { esc } from "../ui/device";
import { place3D } from "../ui/place3d";
import { miniCart } from "../ui/cart";
import { firmwareManifest, type Cart, type Manifest } from "../serial/install";
import type { Wedgie3D } from "../ui/wedgie3d";

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";

// Filament you can get on Amazon in a couple of days (1.75 mm, 1 kg, from at least two of the big brands:
// Elegoo, Sunlu, Overture, Polymaker, eSun, Jayo, Hatchbox, Amazon Basics, Creality; checked 2026-09).
// The case is PETG only; buttons and the joystick can be PETG or PLA. hex: how the printed plastic looks.
type Color = { name: string; hex: number; petg?: string; pla?: string };   // petg/pla: where to buy it
const AMZ = "https://www.amazon.com/";
const COLORS: Record<string, Color> = {
  white: { name: "White", hex: 0xefefea, petg: AMZ + "dp/B0D24YS31F", pla: AMZ + "s?k=elegoo+pla+white+1kg" },
  black: { name: "Black", hex: 0x1c1c1e, petg: AMZ + "dp/B0D41Y3WWZ", pla: AMZ + "dp/B09WW4Z413" },
  grey: { name: "Grey", hex: 0x9a9da1, petg: AMZ + "dp/B07PFS4J97", pla: AMZ + "dp/B07HHFXYPS" },
  darkgrey: { name: "Dark grey", hex: 0x4a4d52, petg: AMZ + "dp/B0CB8DRBL2" },
  silver: { name: "Silver", hex: 0xa8abaf, pla: AMZ + "dp/B0DGQ8ZHFS" },
  red: { name: "Red", hex: 0xc0282d, petg: AMZ + "dp/B0DQTXX4D5", pla: AMZ + "dp/B00J0GO8I0" },
  orange: { name: "Orange", hex: 0xe86a2c, petg: AMZ + "dp/B0FS1DC7RJ", pla: AMZ + "dp/B0D421ZH2W" },
  yellow: { name: "Yellow", hex: 0xf0c020, petg: AMZ + "dp/B0D41ZWK7V", pla: AMZ + "s?k=sunlu+pla+yellow+1kg" },
  green: { name: "Green", hex: 0x3c8f3a, petg: AMZ + "dp/B0991YSBDG", pla: AMZ + "dp/B07D69XD89" },
  olive: { name: "Olive", hex: 0x6b6e3a, petg: AMZ + "dp/B0DPZ3DYH1", pla: AMZ + "dp/B0991QGSPS" },
  mint: { name: "Mint", hex: 0x9cd6be, pla: AMZ + "dp/B0B1ZVN853" },
  skyblue: { name: "Sky blue", hex: 0x5aaedc, pla: AMZ + "dp/B0C6QD6456" },
  blue: { name: "Blue", hex: 0x1f4e9e, petg: AMZ + "dp/B0873BC9SY", pla: AMZ + "s?k=sunlu+pla+klein+blue+1kg" },
  darkblue: { name: "Dark blue", hex: 0x1f2a5c, pla: AMZ + "s?k=elegoo+pla+dark+blue+1kg" },
  purple: { name: "Purple", hex: 0x633c94, petg: AMZ + "dp/B07VSVG61K", pla: AMZ + "dp/B0C6QBZ78R" },
  pink: { name: "Pink", hex: 0xeda0bc, petg: AMZ + "dp/B0DN4PJF61", pla: AMZ + "dp/B0GTZS6MGB" },
  magenta: { name: "Magenta", hex: 0xb8237a, pla: AMZ + "s?k=overture+pla+magenta+1kg" },
  beige: { name: "Beige", hex: 0xd8c6a4, petg: AMZ + "dp/B0D41ZTKKD", pla: AMZ + "dp/B0FZVDPLTY" },
  brown: { name: "Brown", hex: 0x6a4a35, petg: AMZ + "dp/B0D421TTJJ", pla: AMZ + "s?k=hatchbox+pla+brown+1kg" },
  clear: { name: "Clear", hex: 0xdde6e8, petg: AMZ + "dp/B0D9VWZWC4" },
};
// Printed parts: URL key, 3D part, label, its STL. case: PETG only.
const PARTS = [
  { key: "lid", part: "lid", name: "Lid", stl: "lid.stl", def: "white", case: true },
  { key: "base", part: "base", name: "Base", stl: "base.stl", def: "black", case: true },
  { key: "a", part: "A", name: "A button", stl: "button.stl", def: "green", case: false },
  { key: "b", part: "B", name: "B button", stl: "button.stl", def: "darkgrey", case: false },
  { key: "x", part: "X", name: "X button", stl: "button.stl", def: "darkgrey", case: false },
  { key: "y", part: "Y", name: "Y button", stl: "button.stl", def: "red", case: false },
  { key: "stick", part: "joystick", name: "Joystick", stl: "joystick.stl", def: "darkgrey", case: false },
] as const;
const fits = (p: { case: boolean }, c: Color) => !!c.petg || (!p.case && !!c.pla);
const DEF_APP = "hello";
// Secure chips: URL key, the name carts.json's "chip" uses, what to buy. The core has a driver for each.
const CHIPS = [
  { key: "atecc", chip: "ATECC608", name: "ATECC608", about: "Adafruit ATECC608 breakout",
    buy: [["https://www.amazon.com/s?k=ATECC608&i=electronics", "Amazon"], ["https://www.adafruit.com/product/4314", "Adafruit"], ["https://www.digikey.com/en/products/detail/adafruit-industries-llc/4314/10419053", "DigiKey"]] },
  { key: "trustm", chip: "OPTIGA Trust M", name: "Trust M", about: "Adafruit Infineon OPTIGA Trust M breakout",
    buy: [["https://www.adafruit.com/product/4351", "Adafruit"]] },
];
const chipOf = (key: string) => CHIPS.find((c) => c.key === key);
// What each app looks like on the preview's screen.
const SCREENS: Record<string, string[]> = {
  hello: ["hello"], keytest: ["buttons"], demo: ["demo", "demo-2"], mock: ["wallet-home", "wallet-chart", "wallet-send", "wallet-receive"],
  wire_demo: ["clear-sign"], usbwallet: ["wallet-home", "wallet-send", "wallet-signing", "wallet-receive"],
};
// Ready-made wedgies: each is just a /build link, like any shared one.
const PRESETS = [
  { name: "Wallet", q: "app=usbwallet&chip=atecc&lid=white&base=black&a=green&b=darkgrey&x=darkgrey&y=red&stick=darkgrey" },
  { name: "Game", q: "app=demo&chip=none&lid=purple&base=black&a=yellow&b=skyblue&x=mint&y=magenta&stick=yellow" },
  { name: "Plain", q: "app=hello&chip=none&lid=white&base=black&a=green&b=darkgrey&x=darkgrey&y=red&stick=darkgrey" },
];

type Build = { app: string; chip: string; colors: Record<string, string> };   // chip: a CHIPS key or "none"

function read(carts: Cart[]): Build {
  const q = new URLSearchParams(location.search);
  const a = q.get("app");   // before the app list is in, trust the link
  const app = a && (!carts.length || carts.some((c) => c.mod === a)) ? a : DEF_APP;
  const colors: Record<string, string> = {};
  for (const p of PARTS) { const c = COLORS[q.get(p.key) || ""]; colors[p.key] = c && fits(p, c) ? q.get(p.key)! : p.def; }
  return { app, chip: fitChip(carts, app, q.get("chip") || ""), colors };
}
// The app's chip if it needs one; else the one asked for (an unknown one: the ATECC608).
function fitChip(carts: Cart[], app: string, want: string) {
  const need = CHIPS.find((c) => c.chip === carts.find((x) => x.mod === app)?.chip);
  return need ? need.key : want === "none" || chipOf(want) ? want : "atecc";
}
// Every choice goes in the URL, defaults too, so a link means the same wedgie if the defaults change.
function query(b: Build) {
  const q = new URLSearchParams({ app: b.app, chip: b.chip });
  for (const p of PARTS) q.set(p.key, b.colors[p.key]);
  return q.toString();
}

const link = (href: string, t: string) => `<a class="btn btn-xs" href="${href}" target="_blank" rel="noopener">${t}</a>`;

export async function build(main: HTMLElement) {
  main.innerHTML = `
  <section class="sec bld">
    <div class="sec-head">
      <span class="kicker">Build a wedgie</span>
      <h2>Make it yours.</h2>
      <p>Pick its app, its chip, and the color of every part. The link is this exact wedgie: share it, and anyone can buy one or build one.</p>
      <div class="row bld-presets"><span class="fine">Start from</span>${PRESETS.map((p) => `<a class="btn btn-xs" href="/build?${p.q}" data-q="${p.q}">${p.name}</a>`).join("")}</div>
    </div>
    <div class="bld-grid">
      <div class="bld-look">
        <div class="card bld-stage"><div id="bld-dev"></div></div>
        <div class="card bld-link">
          <p class="fine">This wedgie's link</p>
          <div class="row"><code class="mono" id="bld-url"></code><button class="btn btn-sm btn-green" id="bld-copy">Copy link</button></div>
        </div>
      </div>
      <div class="bld-pick">
        <div class="card"><h3>Software</h3><p class="fine">The one app it boots into. You can swap it any time from Connect.</p><div class="bld-apps" id="bld-apps"><p class="fine">Loading apps…</p></div></div>
        <div class="card"><h3>Chip</h3><p class="fine">The secure chip keeps keys. Wallets need one; games don't.</p>
          <div class="seg" role="radiogroup" aria-label="secure chip" id="bld-chip">
            ${CHIPS.map((c) => `<button data-chip="${c.key}" role="radio">${c.name}</button>`).join("")}
            <button data-chip="none" role="radio">No chip</button>
          </div><p class="fine" id="bld-chip-note"></p></div>
        <div class="card"><h3>Colors</h3><p class="fine">Colors you can get on Amazon in a couple of days. The case is PETG; buttons and joystick PETG or PLA.</p><div class="bld-colors" id="bld-colors"></div></div>
        <div class="card"><h3>Firmware</h3><p class="fine">Always the latest: <b id="bld-fw">…</b>. Every wedgie updates itself from Connect.</p></div>
      </div>
    </div>

    <div class="bld-out">
      <div class="card bld-buy">
        <span class="kicker">Buy this one</span>
        <div class="order-price">$67 <span>shipped</span></div>
        <p>Built, printed in these colors, with <b id="bld-buy-app"></b> on it.</p>
        <div class="row">
          <button class="btn btn-green" disabled>Pay with USDC</button>
          <button class="btn" disabled>Pay with card</button>
        </div>
        <p class="fine soon">Checkout opens soon.</p>
      </div>
      <div class="card bld-diy">
        <span class="kicker">Build this one</span>
        <ol class="bld-steps" id="bld-steps"></ol>
      </div>
    </div>
  </section>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => main.querySelector<T>(s)!;
  let m: Manifest | null = null;
  let b: Build = read([]);
  let dev: Wedgie3D | null = null;
  place3D($("#bld-dev"), { fallback: { kind: "off" } }).then((w) => { dev = w; paintDevice(); });

  let shownApp = "";
  function paintDevice() {
    if (!dev) return;
    for (const p of PARTS) dev.setColor(p.part, COLORS[b.colors[p.key]].hex);
    if (shownApp !== b.app) { shownApp = b.app; dev.setScreens((SCREENS[b.app] || ["launcher"]).map((n) => `/screens/${n}.png`), 2600); }
  }

  function set(next: Build) {
    b = next;
    history.replaceState(null, "", "/build?" + query(b));
    paint();
  }

  function paint() {
    const cart = m?.carts.find((c) => c.mod === b.app);
    // Software: every app, as a row of little carts.
    if (m) {
      $("#bld-apps").innerHTML = m.carts.map((c) => `<button class="bld-app${c.mod === b.app ? " on" : ""}" data-app="${esc(c.mod)}" aria-pressed="${c.mod === b.app}">
        ${miniCart(c)}<span><b>${esc(c.name)}</b><span class="fine">${esc(c.about || "")}</span></span></button>`).join("");
      $("#bld-apps").querySelectorAll<HTMLButtonElement>("[data-app]").forEach((x) => (x.onclick = () => {
        const app = x.dataset.app!;
        set({ ...b, app, chip: fitChip(m!.carts, app, b.chip) });
      }));
      $("#bld-fw").textContent = `wedgie ${m.version}`;
    }
    // Chip
    const must = cart?.chip;
    $("#bld-chip").querySelectorAll<HTMLButtonElement>("button").forEach((x) => {
      const on = x.dataset.chip === b.chip;
      x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on));
      x.disabled = !!must && !on;
      x.onclick = () => set({ ...b, chip: x.dataset.chip! });
    });
    $("#bld-chip-note").textContent = must ? `${cart!.name} needs the ${must}.` : "";
    const chip = chipOf(b.chip);
    // Colors: one row of swatches per part.
    $("#bld-colors").innerHTML = PARTS.map((p) => `<div class="bld-color"><span class="bld-part">${p.name} <span class="fine">${COLORS[b.colors[p.key]].name}</span></span><span class="bld-sw">${
      Object.entries(COLORS).filter(([, c]) => fits(p, c)).map(([k, c]) => `<button class="sw${b.colors[p.key] === k ? " on" : ""}" style="--c:#${c.hex.toString(16).padStart(6, "0")}" data-part="${p.key}" data-color="${k}" title="${c.name}" aria-label="${p.name}: ${c.name}" aria-pressed="${b.colors[p.key] === k}"></button>`).join("")
    }</span></div>`).join("");
    $("#bld-colors").querySelectorAll<HTMLButtonElement>(".sw").forEach((x) => (x.onclick = () => set({ ...b, colors: { ...b.colors, [x.dataset.part!]: x.dataset.color! } })));
    // The link
    const url = `${location.origin}/build?${query(b)}`;
    $("#bld-url").textContent = url;
    $("#bld-buy-app").textContent = cart?.name || b.app;
    // Build it yourself: the parts this one needs, the prints in its colors, then assemble and install.
    const cname = (k: string) => COLORS[b.colors[k]].name;
    // One spool per color: PETG when it comes in PETG (every case color does), else PLA.
    const filament = () => [...new Set(PARTS.map((p) => b.colors[p.key]))]
      .map((k) => { const c = COLORS[k]; return link((c.petg || c.pla)!, `${c.name} ${c.petg ? "PETG" : "PLA"}`); }).join("");
    const buttons = PARTS.filter((p) => p.stl === "button.stl").map((p) => `${p.name[0]} ${cname(p.key).toLowerCase()}`).join(", ");
    $("#bld-steps").innerHTML = `
      <li><b>A Pico</b> <span>Raspberry Pi Pico with headers (the USB-C RP2040 kind fits the case).</span>
        <div class="buy">${link("https://www.amazon.com/s?k=raspberry+pi+pico+with+header&i=electronics", "Amazon")}${link("https://www.adafruit.com/product/6315", "Adafruit")}${link("https://www.microcenter.com/product/692334/raspberry-pi-pico-2w-with-header", "Micro Center")}</div></li>
      <li><b>The screen hat</b> <span>Waveshare Pico-LCD-1.3.</span>
        <div class="buy">${link("https://www.amazon.com/dp/B092VVCBQP", "Amazon")}${link("https://www.waveshare.com/pico-lcd-1.3.htm", "Waveshare")}${link("https://thepihut.com/products/1-3-ips-lcd-display-module-for-raspberry-pi-pico-240x240", "The Pi Hut")}</div></li>
      ${chip ? `<li><b>The chip</b> <span>${chip.about}, plus a STEMMA QT / Qwiic cable with bare wire ends.</span>
        <div class="buy">${chip.buy.map(([u, t]) => link(u, t)).join("")}</div></li>` : ""}
      ${b.app === "battery" ? `<li><b>A battery hat</b> <span>The Battery app reads a Waveshare Pico-UPS-B.</span>
        <div class="buy">${link("https://www.waveshare.com/pico-ups-b.htm", "Waveshare")}</div></li>` : ""}
      <li><b>Get the filament</b> <span>1.75 mm. The case in PETG; buttons and joystick in PETG or PLA.</span>
        <div class="buy">${filament()}</div></li>
      <li><b>Print the case</b> <span>0.16 mm layers, 4 walls, no supports. Lid in ${cname("lid").toLowerCase()}, base in ${cname("base").toLowerCase()}, joystick in ${cname("stick").toLowerCase()}, buttons: ${buttons}.</span>
        <div class="buy">${[["lid.stl", `Lid · ${cname("lid")}`], ["base.stl", `Base · ${cname("base")}`], ["joystick.stl", `Joystick · ${cname("stick")}`], ["button.stl", "Button ×4"]]
          .map(([f, t]) => `<a class="btn btn-xs" href="${CASE}${f}" download>${t}</a>`).join("")}</div></li>
      <li><b>Put it together</b> <span>${chip ? "Wedge the chip's wires in, then the chip, then the case." : "Plug the Pico into the hat, then snap the case on. Skip the chip steps."}</span>
        <div class="buy"><a class="btn btn-xs" href="/assemble">Assembly guide</a></div></li>
      <li><b>Put ${esc(cart?.name || b.app)} on it</b> <span>Plug it in, tap Connect at the top, open your wedgie, and tap ${esc(cart?.name || b.app)}. It gets the latest firmware too.</span>
        <div class="buy"><a class="btn btn-xs" href="/connect">Connect</a></div></li>`;
    paintDevice();
  }

  // Presets stay on this page (no reload, no loader).
  main.querySelectorAll<HTMLAnchorElement>("[data-q]").forEach((a) => (a.onclick = (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    history.replaceState(null, "", "/build?" + a.dataset.q);
    set(read(m?.carts || []));
  }));
  $("#bld-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#bld-url").textContent!); $("#bld-copy").textContent = "Copied"; setTimeout(() => ($("#bld-copy").textContent = "Copy link"), 1500); }
    catch { getSelection()?.selectAllChildren($("#bld-url")); }
  };

  paint();
  try { m = await firmwareManifest(); set(read(m.carts)); }
  catch (err) { console.error("build:", err); $("#bld-apps").innerHTML = `<p class="fine">Couldn't load the apps.</p>`; }
}
