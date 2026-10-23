// The front page: give yourself a wedgie. Get one, or build one; a virtual one at the bottom.
import { place3D, pageShown } from "../ui/place3d";
import { ITEMS, type Item } from "../shop/catalog";
import { WHY, STAR, wire } from "../shop/why";
import { blo } from "blo";

// The Safe section's drawing: Safe's mark (from safe-global/safe-wallet-monorepo), two made-up owners, a key that turns into a wedgie.
const SAFE_MARK = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21.757 11.998h-2.485c-.742 0-1.343.579-1.343 1.293v3.47c0 .714-.602 1.293-1.344 1.293H6.699c-.743 0-1.344.578-1.344 1.292v2.391c0 .714.601 1.293 1.344 1.293h10.458c.742 0 1.335-.579 1.335-1.293V19.82c0-.714.602-1.22 1.344-1.22h1.92c.743 0 1.344-.58 1.344-1.293v-4.03c0-.714-.601-1.278-1.343-1.278ZM5.355 7.249c0-.714.6-1.293 1.343-1.293h9.88c.743 0 1.344-.579 1.344-1.293v-2.39c0-.714-.601-1.293-1.344-1.293H6.125c-.742 0-1.343.579-1.343 1.293v1.842c0 .714-.602 1.292-1.344 1.292H1.526C.784 5.407.182 5.986.182 6.7v4.034c0 .714.604 1.264 1.346 1.264h2.485c.743 0 1.344-.579 1.344-1.293L5.355 7.25ZM10.472 9.485h2.387c.778 0 1.409.608 1.409 1.356v2.296c0 .748-.632 1.356-1.41 1.356h-2.386c-.778 0-1.409-.608-1.409-1.356v-2.296c0-.749.632-1.356 1.409-1.356Z"/></svg>`;
const OWNERS = ["0x3f6a1d2c8b4e7f90a1b2c3d4e5f60718293a4b5c", "", "0x9c41e07b5d2a8f3e6c1b0a9d8e7f6a5b4c3d2e1f"] as const;
const KEY_SVG = `<svg class="stx-key" viewBox="0 0 40 40"><circle cx="13" cy="20" r="7" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M20 20h15v6M30 20v5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>`;
const WEDGIE_SVG = `<svg class="stx-wedgie" viewBox="-64 -28 128 56"><rect x="-62" y="-26" width="124" height="52" rx="14" fill="#2a2b2a"/><rect x="-60" y="-26" width="120" height="48" rx="13" fill="#fefefe" stroke="#d6d6d1"/><rect x="-22" y="-20" width="44" height="36" rx="3" fill="#1a1b1a"/><rect x="-19" y="-17" width="38" height="30" fill="#fefefe"/><rect x="-19" y="-17" width="38" height="2.5" fill="#22c452"/><rect x="-19" y="-14.5" width="38" height="2" fill="#a9aaab"/><rect x="-19" y="-12.5" width="38" height="2.5" fill="#e3312c"/><path class="stx-check" pathLength="1" d="M-8 1 L-2 7 L9 -5" fill="none" stroke="#22c452" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-41" cy="-2" r="8" fill="#a9aaab"/><circle cx="-41" cy="-2" r="5" fill="#8a8b8c"/><circle cx="35" cy="-10" r="4.2" fill="#a9aaab"/><circle cx="35" cy="6" r="4.2" fill="#a9aaab"/><circle cx="47" cy="-10" r="4.2" fill="#22c452"/><circle cx="47" cy="6" r="4.2" fill="#e3312c"/></svg>`;

/** Returns once the hero wedgie is up (the loader waits for it). */
export function home(main: HTMLElement): Promise<unknown> {
  main.innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <h1>Give<br>yourself<br><span class="nowrap">a wedgie.</span></h1>
      <p class="lede">A pocket computer from three off-the-shelf parts: a Pico, a screen hat, and a secure chip
      <em>wedged</em> in between. Make it a wallet, a game, or whatever you and your agent dream up.</p>
      <div class="row">
        <a class="btn btn-green" href="#build">Build your own</a>
        <a class="btn" href="#get" id="buy-one">Buy one · $67<span class="surge">*</span></a>
      </div>
    </div>
    <div class="hero-art" id="hero-dev"></div>
  </section>

  <div class="band" aria-hidden="true"><i></i><i></i><i></i></div>

  <section id="build" class="sec">
    <div class="sec-head">
      <span class="kicker">Build one</span>
      <h2>Three easy parts.</h2>
      <p>No soldering. Order the parts anywhere, from anyone. To a store it's just a dev board, a screen, and a chip.</p>
    </div>
    <div class="parts">
      <div class="card part"><div class="num">1</div><div class="part-3d" data-part="pico"></div><h3>A Pico</h3><p>The brain: an RP2040 Pico board with headers. Some Picos are <b>USB-C</b>, some <b>micro USB</b>: it depends on the model. The case is made for the pink NULLLAB board. Any Pico-shaped board runs the code, but may not fit the case.</p><div class="buy"><a class="btn btn-xs" href="https://www.amazon.com/dp/B0GL1D8RWX" target="_blank" rel="noopener">Amazon 2-pack</a><a class="btn btn-xs" href="https://www.amazon.com/dp/B0GQRMVT4P" target="_blank" rel="noopener">Amazon single</a><a class="btn btn-xs" href="/build">More boards</a></div></div>
      <div class="card part"><div class="num">2</div><div class="part-3d" data-part="hat"></div><h3>The screen hat</h3><p>Waveshare Pico-LCD-1.3: a 240×240 screen, a joystick, and four buttons. The Pico plugs straight in.</p><div class="buy"><a class="btn btn-xs" href="https://www.amazon.com/dp/B092VVCBQP" target="_blank" rel="noopener">Amazon</a><a class="btn btn-xs" href="https://www.waveshare.com/pico-lcd-1.3.htm" target="_blank" rel="noopener">Waveshare</a><a class="btn btn-xs" href="https://thepihut.com/products/1-3-ips-lcd-display-module-for-raspberry-pi-pico-240x240" target="_blank" rel="noopener">The Pi Hut</a><a class="btn btn-xs" href="https://www.welectron.com/Waveshare-19650-Pico-LCD-13_1" target="_blank" rel="noopener">Welectron</a><a class="btn btn-xs" href="https://www.robotshop.com/products/waveshare-13in-lcd-display-module-rpi-pico-65k-colors-240x240-spi" target="_blank" rel="noopener">RobotShop</a><a class="btn btn-xs" href="https://abra-electronics.com/robotics-embedded-electronics/raspberry-pi-pico/wave-19650-1.3inch-lcd-display-module-for-raspberry-pi-pico-65k-colors-240240-spi.html" target="_blank" rel="noopener">Abra</a><a class="btn btn-xs" href="https://botland.store/raspberry-pi-pico-hat-keyboards-and-displays/19541-lcd-ips-13-240x240px-spi-65k-rgb-for-raspberry-pi-pico-waveshare-19650-5904422371883.html" target="_blank" rel="noopener">Botland</a></div></div>
      <div class="card part"><div class="num">3</div><div class="part-3d" data-part="chip"></div><h3>The chip</h3><p>Adafruit's <a href="https://www.adafruit.com/product/4351" target="_blank" rel="noopener">OPTIGA Trust M breakout</a>, plus a STEMMA QT / Qwiic cable with bare wire ends. The wires push into the header; the chip gets wedged between the boards.</p><div class="buy"><a class="btn btn-xs" href="https://www.mouser.com/ProductDetail/Adafruit/4351?qs=d0WKAl%252BL4KbhnNU%252BCwzWmQ%3D%3D" target="_blank" rel="noopener">Mouser</a><a class="btn btn-xs" href="https://www.jameco.com/z/4351-Adafruit-Industries-Adafruit-Infineon-Trust-M-Breakout-Board-Stemma-QT-Qwiic_2518263.html" target="_blank" rel="noopener">Jameco</a><a class="btn btn-xs" href="https://www.digikey.com/en/products/detail/adafruit-industries-llc/4351/10650641" target="_blank" rel="noopener">DigiKey</a><a class="btn btn-xs" href="https://www.ebay.com/itm/175631680612" target="_blank" rel="noopener">eBay</a><a class="btn btn-xs" href="https://www.adafruit.com/product/4351" target="_blank" rel="noopener">Adafruit</a><a class="btn btn-xs" href="https://thepihut.com/products/adafruit-infineon-trust-m-breakout-board-stemma-qt-qwiic-ada4351" target="_blank" rel="noopener">The Pi Hut</a><a class="btn btn-xs" href="https://core-electronics.com.au/adafruit-infineon-trust-m-breakout-board-stemma-qt-qwiic.html" target="_blank" rel="noopener">Core Electronics</a><a class="btn btn-xs" href="https://us.rs-online.com/product/adafruit-industries/4351/72044460/" target="_blank" rel="noopener">RS</a></div><p class="fine">(You can also use an <a href="https://www.adafruit.com/product/4314" target="_blank" rel="noopener">ATECC608</a>.)</p></div>
    </div>

    <div class="assembly" id="assembly">
      <div class="assembly-sticky card">
        <div class="assembly-steps">
          <h3>Put it together</h3>
          <ol>
            <li class="step on" data-n="1"><b>Wedge the wires in.</b> <span>The chip's cable plug runs GND, 3.3 V, SDA, SCL from one end; trust that order, not the colors. With the hat's back up and its USB end at the top, push the bare wires into the header beside the Pico's pins: GND right 3rd, 3.3 V right 5th (never the 4th), SDA left 6th, SCL left 7th.</span></li>
            <li class="step" data-n="2"><b>Wedge the chip in between.</b> <span>Tuck the chip into the gap, then plug the Pico into the hat's header: its chips facing you (away from the screen), USB at the joystick end. The chip ends up sandwiched between the two boards.</span></li>
            <li class="step" data-n="3"><b>Snap the case on.</b> <span>Boards into the base, USB first. Caps on, lid down until it clicks.</span></li>
            <li class="step" data-n="4"><b>Plug it in.</b> <span>A USB cable (USB-C or micro USB, whichever your Pico has), then press <b>Allow wedgie connection</b> at the top and pick it. It boots to the underwear.</span></li>
          </ol>
          <p class="fine" style="margin-top:16px"><a href="/assemble">Detailed assembly guide →</a> · <a href="/assemble/3d">Every step in 3D →</a></p>
        </div>
        <div class="assembly-stage" id="assembly-stage"></div>
      </div>
    </div>

    <div class="card wide case">
      <div class="case-3d part-3d" data-part="case"></div>
      <div>
        <h3>Print the case</h3>
        <p>A snap-together shell with no screws, designed from scratch and MIT licensed. PETG, 0.16 mm layers, 4 walls, no supports. Print the lid face down, the base floor down, and the caps flange down.</p>
        <div class="row"><a class="btn btn-sm" href="https://github.com/clawdbotatg/clawd-pico-case/tree/main/stl/current" target="_blank" rel="noopener">The case files →</a></div>
        <p class="fine">White lid, black base, grey joystick; buttons 2 grey, 1 green, 1 red. <b>Atomic wedgie</b>: its own <a href="https://github.com/clawdbotatg/clawd-pico-case/tree/main/stl/atomic-wedgie" target="_blank" rel="noopener">base and RESET plunger</a>.</p>
        <p class="fine">Source, measurements, and every iteration: <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">clawd-pico-case</a>. Why it's called a wedgie: <a href="/lore.md" target="_blank">the lore</a>.</p>
      </div>
    </div>
  </section>

  <section id="safe" class="sec">
    <div class="card wide signer">
      <div class="signer-copy">
        <span class="kicker">Safe signer</span>
        <h2>Sign on a Safe.</h2>
        <p>A wedgie can sign for a Safe multisig with Safe's own audited contracts. The key never leaves the chip, and nothing signs until you press the green button.</p>
        <div class="row"><a class="btn btn-sm" href="/safe">Use it with a Safe →</a></div>
      </div>
      <div class="stx" aria-hidden="true">
        <div class="stx-head">
          <i class="stx-logo">${SAFE_MARK}</i>
          <div><b>Treasury</b><span class="stx-mono">base:0x5afe…C0DE</span></div>
          <span class="stx-chain">Base</span>
        </div>
        <div class="stx-tx">
          <span class="stx-fn">execTransaction</span>
          <b>Send 1,000 USDC</b>
          <span class="stx-mono">to vitalik.eth · nonce 42</span>
        </div>
        <div class="stx-conf"><span>Confirmations</span><b class="stx-n"><i class="n0">0</i><i class="n1">1</i><i class="n2">2</i> of 2</b></div>
        <div class="stx-meter"><i></i></div>
        <ol class="stx-owners">
          <li class="o1"><img class="stx-av" src="${blo(OWNERS[0])}" alt=""><div><b>Owner 1</b><span class="stx-mono stx-sig">0x8f3ac2…e91b1c</span></div><span class="stx-ok">Signed</span></li>
          <li class="o2"><span class="stx-av stx-dev">${KEY_SVG}${WEDGIE_SVG}</span><div><b class="stx-who"><i>Hardware key</i><i>wedgie</i></b><span class="stx-mono stx-sig">0x04b7d9…3fa20e</span></div><span class="stx-ok">Signed</span></li>
          <li class="o3"><img class="stx-av" src="${blo(OWNERS[2])}" alt=""><div><b>Owner 3</b><span class="stx-mono">${OWNERS[2].slice(0, 6)}…${OWNERS[2].slice(-4)}</span></div><span class="stx-wait">Not needed</span></li>
        </ol>
        <div class="stx-done">Executed</div>
      </div>
    </div>
  </section>

  <section id="get" class="sec">
    <div class="sec-head">
      <span class="kicker">Get one</span>
      <h2>We'll give you a wedgie.</h2>
    </div>
    <div class="card order">
      <div class="order-art truck-lane" aria-hidden="true"><img class="truck" src="/img/truck.webp" alt=""></div>
      <div class="order-body">
        <div class="order-price"><i class="sixseven-box"></i><b class="list">$67</b>${STAR} <span>shipped</span></div>
        <p class="surge why-open" hidden></p>
        ${WHY}
        <p id="order-what">One wedgie: pico, screen, chip, and case.</p>
        <div class="seg" role="radiogroup" aria-label="who is it for">
          <button class="on" data-for="me" role="radio" aria-checked="true">For me</button>
          <button data-for="gift" role="radio" aria-checked="false">Give someone a wedgie</button>
          <button data-for="kit" role="radio" aria-checked="false">Kit</button>
        </div>
        <div class="row">
          <a class="btn btn-green" id="order-go" href="/order">Order</a>
        </div>
        <p class="fine">Card or USDC. Ships within a week, worldwide.</p>
      </div>
    </div>
  </section>

  <section id="library" class="sec">
    <div class="sec-head">
      <span class="kicker">Software</span>
      <h2>A growing app store.</h2>
      <p>Games, tools, a wallet. More every week.</p>
    </div>
    <div class="lib" id="lib">
      <div class="lib-sticky card">
        <div class="lib-stage"><div class="lib-row"></div><div class="lib-plank"></div></div>
        <div class="lib-cap"><h3></h3><p></p></div>
      </div>
    </div>
    <div class="sec-head lib-after">
      <h2>Developers, developers, developers.</h2>
      <p>Anyone can write software for a wedgie. Write it yourself, or have your agent write it. <a href="/code">How</a></p>
    </div>
  </section>

  <section id="agents" class="sec agents">
    <button class="btn btn-lg btn-green" id="pop-emu">Pop out a virtual wedgie</button>
  </section>

  <section id="teaser" class="sec teaser">
    <div class="teaser-box">
      <video playsinline preload="none" poster="/video/teaser.jpg" src="/video/teaser.mp4"></video>
      <button class="teaser-play" aria-label="Play"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></button>
    </div>
  </section>
`;

  const hero = place3D(main.querySelector<HTMLElement>("#hero-dev")!, { demo: "WEDGIE", boot: true, intro: true, eager: true, side: 1, fallback: { kind: "off" } });

  // $67: the 6-7 hands, for a moment, each time the price comes into view.
  const price = main.querySelector<HTMLElement>(".order-price")!;
  let item: Item = "wedgie", extra = 0;
  const usd = (c: number) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
  let hands: { play(): void } | null = null;
  new IntersectionObserver(async (es) => {
    if (!es.some((e) => e.isIntersecting) ) return;
    await pageShown;
    if (!hands) { const { mountSixSeven } = await import("../ui/sixseven"); hands = mountSixSeven(price.querySelector(".sixseven-box")!); }
    hands.play();
  }, { threshold: 0.6 }).observe(price);

  // The truck drives in when its section comes into view, then keeps bouncing along.
  const lane = main.querySelector<HTMLElement>(".truck-lane")!;
  new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { lane.classList.add("go"); o.disconnect(); } }, { threshold: 0.35 }).observe(lane);

  // The price right now: each sale adds a bit, gone in a day without one (shop/catalog.ts).
  const showPrice = () => {
    // Always the list price, then the demand price on top, in green, when there is one (shop/why.ts).
    price.querySelector(".list")!.textContent = usd(ITEMS[item].cents);
    const surge = price.parentElement!.querySelector<HTMLElement>("p.surge")!;   // not the hero button's *
    surge.hidden = !extra;
    surge.textContent = `+${usd(extra)} right now`;
    wire(price.parentElement!, extra > 0);
  };
  wire(price.parentElement!);
  // The Order button says Sold out when the picked one is (api/_shop.ts stockLeft).
  let left: Record<string, number> | null = null;
  const sold = () => {
    const go = main.querySelector<HTMLAnchorElement>("#order-go")!, out = left?.[item] === 0;
    go.textContent = out ? "Sold out" : "Order"; go.classList.toggle("btn-green", !out); 
    if (out) { go.removeAttribute("href"); go.setAttribute("aria-disabled", "true"); }
    else { go.href = item === "kit" ? "/order?item=kit" : "/order"; go.removeAttribute("aria-disabled"); }
  };
  fetch("/api/order").then((r) => r.json()).then((r) => {
    extra = r.extra || 0; showPrice();
    left = r.left; sold();
  }, () => {});
  main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => (b.onclick = () => {
    main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    const kit = b.dataset.for === "kit";
    main.querySelector("#order-what")!.innerHTML = kit
      ? `Every part and the case in the mail, with <a href="/assemble">assembly instructions</a> (also <a href="/assemble/3d">in 3D</a>). You need a wire stripper, tape, tweezers, and a USB data cable that fits your Pico (USB-C or micro USB, depending on the model).`
      : "One wedgie: pico, screen, chip, and case.";
    item = kit ? "kit" : "wedgie";
    showPrice(); sold();
  }));
  // The teaser: a big green play button over it; one tap plays it with sound (autoplay would have to be muted).
  const teaser = main.querySelector<HTMLVideoElement>(".teaser video")!;
  main.querySelector<HTMLButtonElement>(".teaser-play")!.onclick = (e) => {
    (e.currentTarget as HTMLElement).remove();
    teaser.controls = true;
    teaser.play();
  };
  // A virtual wedgie (/virtual) in its own small window: it shows up under Connect here, like a plugged-in one.
  main.querySelector<HTMLButtonElement>("#pop-emu")!.onclick = () => {
    if (!open("/virtual", "wedgie-emu", "popup,width=420,height=640")) location.href = "/virtual";
  };
  assembly(main.querySelector<HTMLElement>("#assembly")!);
  safeTx(main.querySelector<HTMLElement>(".stx")!);
  library(main.querySelector<HTMLElement>("#lib")!);
  main.querySelectorAll<HTMLElement>(".part-3d").forEach((el, i) => {
    new IntersectionObserver(async (es, o) => {
      if (!es.some((e) => e.isIntersecting)) return;
      o.disconnect();
      try { await pageShown; const { mountPart3D } = await import("../ui/parts3d"); await mountPart3D(el, el.dataset.part as "pico" | "hat" | "chip" | "case", i * 1.3); }
      catch (err) { console.error("part:", err); }
    }, { rootMargin: "300px" }).observe(el);
  });

  return hero;
}

// Put it together: the steps light up as you scroll, and the wedgie assembles itself beside them.
function assembly(box: HTMLElement) {
  const steps = [...box.querySelectorAll<HTMLElement>(".step")];
  const stage = box.querySelector<HTMLElement>("#assembly-stage")!;
  let a3d: import("../ui/assembly3d").Assembly3D | null = null;
  const progress = () => {
    const r = box.getBoundingClientRect();
    return Math.max(0, Math.min(1, -r.top / Math.max(1, r.height - innerHeight)));
  };
  const update = () => {
    const p = progress();
    const on = Math.min(3, Math.floor(p * 4));
    steps.forEach((s, i) => s.classList.toggle("on", i === on));
    a3d?.setProgress(p);
  };
  addEventListener("scroll", update, { passive: true });
  update();
  new IntersectionObserver(async (es, o) => {
    if (!es.some((e) => e.isIntersecting)) return;
    o.disconnect();
    try {
      await pageShown;
      const { mountAssembly3D } = await import("../ui/assembly3d");
      a3d = await mountAssembly3D(stage);
      update();
    } catch (err) { console.error("assembly:", err); }
  }, { rootMargin: "400px" }).observe(stage);
}

// The Safe transaction signs itself as it scrolls by: owner 1 signs, owner 2's hardware key turns into a
// wedgie and its screen checks, 2 of 2 confirmations, executed. --p (0..1) drives it all in CSS.
function safeTx(box: HTMLElement) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const update = () => {
    const r = box.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (innerHeight * 0.9 - r.top) / Math.max(1, r.height - innerHeight * 0.08)));   // done once it all shows
    box.style.setProperty("--p", p.toFixed(3));
    box.dataset.n = still || p >= .74 ? "2" : p >= .3 ? "1" : "0";   // confirmations, as each signature lands
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

// The software library: the shelf's carts stand side by side like books, and scrolling flips through them,
// one at a time turned to face you with its name and what it does underneath.
function library(box: HTMLElement) {
  const row = box.querySelector<HTMLElement>(".lib-row")!;
  const cap = box.querySelector<HTMLElement>(".lib-cap")!;
  let items: HTMLElement[] = [];
  let carts: import("../serial/install").Cart[] = [];
  let shown = -1;
  // Measured on load/resize, not per scroll. The viewport height is only re-read when the width changes:
  // a phone's toolbar sliding in and out resizes innerHeight mid-scroll and would jolt the carts.
  let span = 1, w = 0, vw = 0, vh = innerHeight;
  let at = 0, goal = 0, raf = 0;
  const measure = () => {
    if (innerWidth !== vw) { vw = innerWidth; vh = innerHeight; }
    span = Math.max(1, box.offsetHeight - vh);
    w = row.clientWidth;
  };
  const place = () => {
    const spine = Math.min(34, w / 22), gap = Math.min(140, w / 4.2);
    items.forEach((el, i) => {
      const d = i - at, s = Math.max(-1, Math.min(1, d));
      // perspective() first, around the stage's center (every item sits there), so each cart is its own flat
      // 3D layer: no preserve-3d scene for the browser to depth-sort every frame; z-index does the stacking.
      el.style.transform = `perspective(1100px) translate3d(${d * spine + s * gap}px,0,${(1 - Math.abs(s)) * 130}px) rotateY(${-s * 72}deg)`;
      el.style.zIndex = String(100 - Math.round(Math.abs(d) * 10));
    });
    const n = Math.round(at);
    if (n !== shown) {
      shown = n;
      cap.querySelector("h3")!.textContent = carts[n].name;
      cap.querySelector("p")!.textContent = carts[n].about || "";
      cap.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "ease-out" });
    }
  };
  // One write per frame, easing toward the scroll position (a mouse wheel jumps; a finger shouldn't lag).
  const tick = () => {
    raf = 0;
    goal = Math.max(0, Math.min(1, -box.getBoundingClientRect().top / span)) * (items.length - 1);
    at = at < 0 ? goal : at + (goal - at) * 0.4;  // the first frame snaps
    if (Math.abs(goal - at) < 0.002) at = goal;
    place();
    if (at !== goal) raf = requestAnimationFrame(tick);
  };
  const update = () => {
    if (items.length && !raf) raf = requestAnimationFrame(tick);
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", () => { measure(); update(); });
  new IntersectionObserver(async (es, o) => {
    if (!es.some((e) => e.isIntersecting)) return;
    o.disconnect();
    try {
      const [{ cartHtml }, m] = await Promise.all([import("../ui/cart"), fetch("/fw/manifest.json", { cache: "no-cache" }).then((r) => r.json())]);
      carts = m.carts || [];
      if (!carts.length) { box.closest("section")!.hidden = true; return; }
      box.style.setProperty("--n", String(carts.length));
      row.innerHTML = carts.map((c) => `<div class="lib-item"><a class="cart" href="/code" aria-label="${c.name.replace(/"/g, "&quot;")}">${cartHtml(c)}</a></div>`).join("");
      items = [...row.querySelectorAll<HTMLElement>(".lib-item")];
      measure();
      at = -1;
      update();
    } catch (err) { console.error("library:", err); }
  }, { rootMargin: "600px" }).observe(box);
}
