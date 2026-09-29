// /build: pick a wedgie — its app, whether it has the secure chip, the color of every printed part —
// and the URL becomes that wedgie (/build?app=usbwallet&chip=atecc&lid=white&...). Anyone with the link
// sees the same one and can buy it or build it from the list below. Firmware is always the latest.
import "./build.css";
import { esc } from "../ui/device";
import { place3D } from "../ui/place3d";
import { miniCart } from "../ui/cart";
import { firmwareManifest, type Cart, type Manifest } from "../serial/install";
import type { Wedgie3D } from "../ui/wedgie3d";

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";

// Filament colors. The first few are what the site's own wedgie is printed in (wedgie3d COLORS).
const COLORS: Record<string, { name: string; hex: number }> = {
  white: { name: "White", hex: 0xf3f2ee }, black: { name: "Black", hex: 0x1c1c1e }, grey: { name: "Grey", hex: 0x6c6d71 },
  green: { name: "Green", hex: 0x278c3c }, red: { name: "Red", hex: 0xb3302a }, blue: { name: "Blue", hex: 0x2560c4 },
  yellow: { name: "Yellow", hex: 0xe2b21c }, orange: { name: "Orange", hex: 0xe06a1f }, purple: { name: "Purple", hex: 0x6b3fc9 },
  pink: { name: "Pink", hex: 0xe57aa8 },
};
// Printed parts: URL key, 3D part, label, its STL.
const PARTS = [
  { key: "lid", part: "lid", name: "Lid", stl: "lid.stl", def: "white" },
  { key: "base", part: "base", name: "Base", stl: "base.stl", def: "black" },
  { key: "a", part: "A", name: "A button", stl: "button.stl", def: "green" },
  { key: "b", part: "B", name: "B button", stl: "button.stl", def: "grey" },
  { key: "x", part: "X", name: "X button", stl: "button.stl", def: "grey" },
  { key: "y", part: "Y", name: "Y button", stl: "button.stl", def: "red" },
  { key: "stick", part: "joystick", name: "Joystick", stl: "joystick.stl", def: "grey" },
] as const;
const DEF_APP = "hello";
const NEEDS_CHIP = new Set(["usbwallet"]);
// What each app looks like on the preview's screen.
const SCREENS: Record<string, string[]> = {
  hello: ["hello"], keytest: ["buttons"], demo: ["demo", "demo-2"], mock: ["wallet-home", "wallet-chart", "wallet-send", "wallet-receive"],
  wire_demo: ["clear-sign"], usbwallet: ["wallet-home", "wallet-send", "wallet-signing", "wallet-receive"],
};
// Ready-made wedgies: each is just a /build link, like any shared one.
const PRESETS = [
  { name: "Wallet", q: "app=usbwallet&chip=atecc&lid=white&base=black&a=green&b=grey&x=grey&y=red&stick=grey" },
  { name: "Game", q: "app=demo&chip=none&lid=purple&base=black&a=yellow&b=blue&x=green&y=red&stick=yellow" },
  { name: "Plain", q: "app=hello&chip=none&lid=white&base=black&a=green&b=grey&x=grey&y=red&stick=grey" },
];

type Build = { app: string; chip: boolean; colors: Record<string, string> };

function read(carts: Cart[]): Build {
  const q = new URLSearchParams(location.search);
  const a = q.get("app");   // before the app list is in, trust the link
  const app = a && (!carts.length || carts.some((c) => c.mod === a)) ? a : DEF_APP;
  const colors: Record<string, string> = {};
  for (const p of PARTS) colors[p.key] = COLORS[q.get(p.key) || ""] ? q.get(p.key)! : p.def;
  return { app, chip: NEEDS_CHIP.has(app) || q.get("chip") !== "none", colors };
}
// Every choice goes in the URL, defaults too, so a link means the same wedgie if the defaults change.
function query(b: Build) {
  const q = new URLSearchParams({ app: b.app, chip: b.chip ? "atecc" : "none" });
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
        <div class="card"><h3>Chip</h3><p class="fine">The secure chip keeps keys. Wallets need it; games don't.</p>
          <div class="seg" role="radiogroup" aria-label="secure chip" id="bld-chip">
            <button data-chip="1" role="radio">ATECC608 secure chip</button>
            <button data-chip="0" role="radio">No chip</button>
          </div><p class="fine" id="bld-chip-note"></p></div>
        <div class="card"><h3>Colors</h3><p class="fine">Every printed part, in any PETG you like.</p><div class="bld-colors" id="bld-colors"></div></div>
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
        set({ ...b, app, chip: b.chip || NEEDS_CHIP.has(app) });
      }));
      $("#bld-fw").textContent = `wedgie ${m.version}`;
    }
    // Chip
    const must = NEEDS_CHIP.has(b.app);
    $("#bld-chip").querySelectorAll<HTMLButtonElement>("button").forEach((x) => {
      const on = (x.dataset.chip === "1") === b.chip;
      x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on));
      x.disabled = must && x.dataset.chip === "0";
      x.onclick = () => set({ ...b, chip: x.dataset.chip === "1" });
    });
    $("#bld-chip-note").textContent = must ? `${cart?.name || b.app} needs the chip.` : "";
    // Colors: one row of swatches per part.
    $("#bld-colors").innerHTML = PARTS.map((p) => `<div class="bld-color"><span class="bld-part">${p.name} <span class="fine">${COLORS[b.colors[p.key]].name}</span></span><span class="bld-sw">${
      Object.entries(COLORS).map(([k, c]) => `<button class="sw${b.colors[p.key] === k ? " on" : ""}" style="--c:#${c.hex.toString(16).padStart(6, "0")}" data-part="${p.key}" data-color="${k}" title="${c.name}" aria-label="${p.name}: ${c.name}" aria-pressed="${b.colors[p.key] === k}"></button>`).join("")
    }</span></div>`).join("");
    $("#bld-colors").querySelectorAll<HTMLButtonElement>(".sw").forEach((x) => (x.onclick = () => set({ ...b, colors: { ...b.colors, [x.dataset.part!]: x.dataset.color! } })));
    // The link
    const url = `${location.origin}/build?${query(b)}`;
    $("#bld-url").textContent = url;
    $("#bld-buy-app").textContent = cart?.name || b.app;
    // Build it yourself: the parts this one needs, the prints in its colors, then assemble and install.
    const cname = (k: string) => COLORS[b.colors[k]].name;
    const buttons = PARTS.filter((p) => p.stl === "button.stl").map((p) => `${p.name[0]} ${cname(p.key).toLowerCase()}`).join(", ");
    $("#bld-steps").innerHTML = `
      <li><b>A Pico</b> <span>Raspberry Pi Pico with headers (the USB-C RP2040 kind fits the case).</span>
        <div class="buy">${link("https://www.amazon.com/s?k=raspberry+pi+pico+with+header&i=electronics", "Amazon")}${link("https://www.adafruit.com/product/6315", "Adafruit")}${link("https://www.microcenter.com/product/692334/raspberry-pi-pico-2w-with-header", "Micro Center")}</div></li>
      <li><b>The screen hat</b> <span>Waveshare Pico-LCD-1.3.</span>
        <div class="buy">${link("https://www.amazon.com/dp/B092VVCBQP", "Amazon")}${link("https://www.waveshare.com/pico-lcd-1.3.htm", "Waveshare")}${link("https://thepihut.com/products/1-3-ips-lcd-display-module-for-raspberry-pi-pico-240x240", "The Pi Hut")}</div></li>
      ${b.chip ? `<li><b>The chip</b> <span>Adafruit ATECC608 breakout, plus a STEMMA QT / Qwiic cable with bare wire ends.</span>
        <div class="buy">${link("https://www.amazon.com/s?k=ATECC608&i=electronics", "Amazon")}${link("https://www.adafruit.com/product/4314", "Adafruit")}${link("https://www.digikey.com/en/products/detail/adafruit-industries-llc/4314/10419053", "DigiKey")}</div></li>` : ""}
      ${b.app === "battery" ? `<li><b>A battery hat</b> <span>The Battery app reads a Waveshare Pico-UPS-B.</span>
        <div class="buy">${link("https://www.waveshare.com/pico-ups-b.htm", "Waveshare")}</div></li>` : ""}
      <li><b>Print the case</b> <span>PETG, 0.16 mm layers, 4 walls, no supports. Lid in ${cname("lid").toLowerCase()}, base in ${cname("base").toLowerCase()}, joystick in ${cname("stick").toLowerCase()}, buttons: ${buttons}.</span>
        <div class="buy">${[["lid.stl", `Lid · ${cname("lid")}`], ["base.stl", `Base · ${cname("base")}`], ["joystick.stl", `Joystick · ${cname("stick")}`], ["button.stl", "Button ×4"]]
          .map(([f, t]) => `<a class="btn btn-xs" href="${CASE}${f}" download>${t}</a>`).join("")}</div></li>
      <li><b>Put it together</b> <span>${b.chip ? "Wedge the chip's wires in, then the chip, then the case." : "Plug the Pico into the hat, then snap the case on. Skip the chip steps."}</span>
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
