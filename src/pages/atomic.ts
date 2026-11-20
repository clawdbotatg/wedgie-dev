// /atomic: the atomic wedgie. What it's for (Austin, 11-19): playing away from the computer. It has no Wi-Fi or
// Bluetooth, so signing and anything online still need the cable: never say "sign anywhere". The word for it: air-gapped.
// A wedgie with a battery inside: a Waveshare RP2040-Plus for the Pico, a small LiPo,
// the red base and a RESET button. What's different, where to get the parts, how to build one, and where to order.
// The shop's side: src/shop/catalog.ts (atomic, atomickit). The picture: ui/atomic.ts.
import { atomicArt, BOARD, BATTERY, CASE_FILES } from "../ui/atomic";
import { ITEMS, type Item } from "../shop/catalog";
import { WHY, STAR, wire } from "../shop/why";

const CUR = "https://github.com/clawdbotatg/clawd-pico-case/blob/main/stl/current/";
const AW = "https://github.com/clawdbotatg/clawd-pico-case/blob/main/stl/atomic-wedgie/";
const usd = (c: number) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const ext = (href: string, text: string, cls = "btn btn-xs") => `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${text}</a>`;

/** Returns once the picture's wedgie is up (the loader waits for it). */
export function atomic(main: HTMLElement): Promise<unknown> {
  const buy = (k: Item, what: string) => `
      <div class="card" data-item="${k}">
        <h3>${ITEMS[k].name[0].toUpperCase() + ITEMS[k].name.slice(1)}</h3>
        <div class="order-price"><b class="list">${usd(ITEMS[k].cents)}</b>${STAR} <span>shipped</span></div>
        <p class="surge why-open" hidden></p>
        <p>${what}</p>
        <div class="row"><a class="btn btn-green" href="/order?item=${k}">Order</a></div>
      </div>`;
  main.innerHTML = `
  <section class="hero atomic-hero">
    <div class="hero-copy">
      <h1 class="atom-title"><i>Atomic</i>wedgie.</h1>
      <p class="lede">A wedgie with a battery inside. Air-gapped games, anywhere. Plug it in to sign.</p>
      <div class="row">
        <a class="btn btn-green" href="#build">Build your own</a>
        <a class="btn" href="#get">Get one · ${usd(ITEMS.atomic.cents)}<span class="surge">*</span></a>
      </div>
    </div>
    <div id="atomic-art"></div>
  </section>

  <div class="band" aria-hidden="true"><i></i><i></i><i></i></div>

  <section class="sec">
    <div class="sec-head">
      <span class="kicker">What's new</span>
      <h2>Same wedgie. Plays unplugged.</h2>
      <p>The same screen, the same secure chip, the same apps. Three things change.</p>
    </div>
    <div class="atomic-facts">
      <div class="card"><h3>Runs on its own</h3><p>Unplug it and the game keeps going. The charge shows in the top right corner. After 20 seconds with no press the screen goes off; any button wakes it.</p></div>
      <div class="card"><h3>Air-gapped</h3><p>No Wi-Fi, no Bluetooth. Plug in the USB-C cable to sign, install apps, or charge.</p></div>
      <div class="card"><h3>A RESET button</h3><p>It pokes through the red base. Press it to restart the wedgie: with a battery inside, pulling the cable no longer does.</p></div>
    </div>
  </section>

  <section id="build" class="sec">
    <div class="sec-head">
      <span class="kicker">Build one</span>
      <h2>Two new parts.</h2>
      <p>The screen hat and the chip are the ones <a href="/#build">every wedgie uses</a>. The Pico is a different board, and there's a battery.</p>
    </div>
    <div class="parts atomic-parts">
      <div class="card part"><div class="num">1</div><h3>The board</h3><p>A <b>${BOARD.name}</b>, with headers: Pico-shaped, with a battery plug, a charger, USB-C, and a RESET button. A plain Pico has none of those, so it won't do here.</p><div class="buy">${ext(BOARD.url, "Waveshare")}</div></div>
      <div class="card part"><div class="num">2</div><h3>The battery</h3><p>A <b>${BATTERY.name}</b>: ${BATTERY.volts}, ${BATTERY.mah} mAh (${BATTERY.wh}), 6 × 11 × 20 mm, with a 2-pin <b>${BATTERY.plug}</b> plug. Check that its red wire lands on the board's <b>+</b> before you plug it in: some come wired backwards.</p><div class="buy">${ext("https://www.amazon.com/s?k=601120+lipo+1.25", "Amazon: search 601120 1.25")}</div></div>
      <div class="card part"><div class="num">3</div><h3>The rest</h3><p>The Waveshare Pico-LCD-1.3 screen hat, the OPTIGA Trust M chip and its cable: the same as any wedgie, wired the same way.</p><div class="buy"><a class="btn btn-xs" href="/#build">The parts</a><a class="btn btn-xs" href="/build.md" target="_blank">build.md</a></div></div>
    </div>

    <div class="card wide atomic-print">
      <div>
        <h3>Print the case</h3>
        <p>The same case with a different base: a channel for the battery's plug and wire, a BOOT pin hole, and a RESET plunger. PETG, 0.16 mm layers, 4 walls, no supports.</p>
        <table>
          <tr><th>Part</th><th>Copies</th><th>Color</th></tr>
          <tr><td>${ext(AW + "base.stl", "Atomic base", "")}</td><td>1</td><td>Red</td></tr>
          <tr><td>${ext(AW + "aw-reset-plunger.stl", "RESET plunger", "")}</td><td>1</td><td>Black</td></tr>
          <tr><td>${ext(CUR + "lid.stl", "Lid", "")}</td><td>1</td><td>White</td></tr>
          <tr><td>${ext(CUR + "joystick.stl", "Joystick", "")} (${ext(CUR + "JOYSTICK-PRINT.md", "special settings", "")})</td><td>1</td><td>Grey</td></tr>
          <tr><td>${ext(CUR + "button.stl", "Button", "")}</td><td>4</td><td>2 grey, 1 green, 1 red</td></tr>
        </table>
        <div class="row">${ext(CASE_FILES, "The atomic case files →", "btn btn-sm")}</div>
      </div>
    </div>

    <div class="card wide">
      <div>
        <h3>Put it together</h3>
        <p>Build it like any wedgie, with two more steps.</p>
        <ol class="atomic-steps">
          <li><b>RESET plunger first.</b> <span>Drop it into its hole from inside the red base, flange up, before the boards go in.</span></li>
          <li><b>Wire the chip and stack the boards.</b> <span>The same as every wedgie: the <a href="/assemble">assembly guide</a>, with the ${BOARD.name} where the Pico goes.</span></li>
          <li><b>Plug in the battery.</b> <span>Into the board's battery plug. Its wire runs in the channel at the end of the base, away from the USB.</span></li>
          <li><b>Snap the lid on, plug it in.</b> <span>Set it up over USB like any wedgie (<a href="/connect">Connect</a>). Put a game on it, then pull the cable.</span></li>
        </ol>
      </div>
    </div>
  </section>

  <div class="band roomy" aria-hidden="true"><i></i><i></i><i></i></div>

  <section id="get" class="sec">
    <div class="sec-head">
      <span class="kicker">Get one</span>
      <h2>We'll give you an atomic wedgie.</h2>
    </div>
    <div class="atomic-buy">
      ${buy("atomic", "One atomic wedgie, assembled, and a USB cable.")}
      ${buy("atomickit", "Every part, the battery, the red case, a cable, and how to build it.")}
    </div>
    ${WHY}
    <p class="fine" style="margin-top:14px">Card or USDC. Ships within a week. US only for now: there's a battery inside.</p>
  </section>
`;

  // The price right now and what's left, like the front page (shop/catalog.ts, api/_shop.ts stockLeft).
  const get = main.querySelector<HTMLElement>("#get")!;
  wire(get);
  fetch("/api/order").then((r) => r.json()).then((r) => {
    const extra = r.extra || 0;
    get.querySelectorAll<HTMLElement>("[data-item]").forEach((c) => {
      const surge = c.querySelector<HTMLElement>("p.surge")!, go = c.querySelector<HTMLAnchorElement>(".btn")!;
      surge.hidden = !extra;
      surge.textContent = `+${usd(extra)} right now`;
      if (r.left?.[c.dataset.item!] === 0) { go.textContent = "Sold out"; go.classList.remove("btn-green"); go.removeAttribute("href"); go.setAttribute("aria-disabled", "true"); }
    });
    wire(get, extra > 0);
  }, () => {});
  document.querySelector(".foot > .band")?.remove();
  return atomicArt(main.querySelector<HTMLElement>("#atomic-art")!, { eager: true });
}
