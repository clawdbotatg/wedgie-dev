// The front page: give yourself a wedgie. Get one, or build one; agents at the bottom.
import { place3D, SCREENS } from "../ui/place3d";

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";

export function home(main: HTMLElement) {
  main.innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <h1>Give yourself<br>a wedgie.</h1>
      <p class="lede">A pocket computer from three off-the-shelf parts: a Pico, a screen hat, and a secure chip
      <em>wedged</em> in between. Make it a wallet, a game, or whatever you and your agent dream up.</p>
      <div class="row">
        <a class="btn btn-green" href="#get">Get a wedgie · $67</a>
        <a class="btn" href="#build">Build your own</a>
      </div>
    </div>
    <div class="hero-art"><img class="sticker" src="/img/sticker.webp" alt="a pair of white briefs with a green, grey and red waistband"></div>
  </section>

  <div class="band" aria-hidden="true"><i></i><i></i><i></i></div>

  <section id="get" class="sec">
    <div class="sec-head">
      <span class="kicker">Get one</span>
      <h2>We'll give you a wedgie.</h2>
    </div>
    <div class="card order">
      <div class="order-art" id="art-order"></div>
      <div class="order-body">
        <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="order-price">$67 <span>shipped</span></div>
        <p>One wedgie: pico, screen, chip, and case.</p>
        <div class="seg" role="radiogroup" aria-label="who is it for">
          <button class="on" data-for="me" role="radio" aria-checked="true">For me</button>
          <button data-for="gift" role="radio" aria-checked="false">Give someone a wedgie</button>
        </div>
        <div class="row">
          <button class="btn btn-green" data-pay="usdc" disabled>Pay with USDC</button>
          <button class="btn" data-pay="card" disabled>Pay with card</button>
        </div>
        <p class="fine soon">Checkout opens soon.</p>
      </div>
    </div>
  </section>

  <section id="build" class="sec">
    <div class="sec-head">
      <span class="kicker">Build one</span>
      <h2>Three parts. One wedge.</h2>
      <p>No soldering. Order the parts anywhere, from anyone. To a store it's just a dev board, a screen, and a chip.</p>
    </div>
    <div class="parts">
      <div class="card part"><div class="num">1</div><h3>A Pico</h3><p>The brain: a Raspberry Pi Pico 2 W with headers. Any Pico-shaped board runs the same code; the printed case fits the USB-C RP2040 kind.</p>
        <div class="price">~$7–12</div><div class="buy"><a class="btn btn-sm btn-green" href="https://www.amazon.com/dp/B0DRJXPPWL" target="_blank" rel="noopener">Amazon</a><a class="btn btn-sm" href="https://www.adafruit.com/product/6315" target="_blank" rel="noopener">Adafruit</a><a class="btn btn-sm" href="https://www.microcenter.com/product/692334/raspberry-pi-pico-2w-with-header" target="_blank" rel="noopener">Micro Center</a></div></div>
      <div class="card part"><div class="num">2</div><h3>The screen hat</h3><p>Waveshare Pico-LCD-1.3: a 240×240 screen, a joystick, and four buttons. The Pico plugs straight in.</p>
        <div class="price">~$13–15</div><div class="buy"><a class="btn btn-sm btn-green" href="https://www.amazon.com/dp/B092VVCBQP" target="_blank" rel="noopener">Amazon</a><a class="btn btn-sm" href="https://www.waveshare.com/pico-lcd-1.3.htm" target="_blank" rel="noopener">Waveshare</a><a class="btn btn-sm" href="https://thepihut.com/products/1-3-ips-lcd-display-module-for-raspberry-pi-pico-240x240" target="_blank" rel="noopener">The Pi Hut</a></div></div>
      <div class="card part"><div class="num">3</div><h3>The chip</h3><p>Adafruit's ATECC608 breakout, plus a STEMMA QT / Qwiic cable with bare wire ends. The wires push into the header; the chip gets wedged between the boards.</p>
        <div class="price">~$5 + cable</div><div class="buy"><a class="btn btn-sm btn-green" href="https://www.amazon.com/dp/B07YYRCJ9M" target="_blank" rel="noopener">Amazon</a><a class="btn btn-sm" href="https://www.adafruit.com/product/4314" target="_blank" rel="noopener">Adafruit</a><a class="btn btn-sm" href="https://www.digikey.com/en/products/detail/adafruit-industries-llc/4314/10419053" target="_blank" rel="noopener">DigiKey</a></div></div>
    </div>

    <div class="assembly" id="assembly">
      <div class="assembly-sticky card">
        <div class="assembly-steps">
          <h3>Put it together</h3>
          <ol>
            <li class="step on" data-n="1"><b>Wedge the wires in.</b> <span>The chip's cable plug runs GND, 3.3 V, SDA, SCL from one end; trust that order, not the colors. With the hat's back up and its USB end at the top, push the bare wires into the header beside the Pico's pins: GND right 3rd, 3.3 V right 5th (never the 4th), SDA left 6th, SCL left 7th.</span></li>
            <li class="step" data-n="2"><b>Wedge the chip in between.</b> <span>Tuck the chip into the gap, then plug the Pico into the hat's header: parts toward the screen, USB at the joystick end. The chip ends up sandwiched between the two boards.</span></li>
            <li class="step" data-n="3"><b>Snap the case on.</b> <span>Boards into the base, USB first. Caps on, lid down until it clicks.</span></li>
            <li class="step" data-n="4"><b>Plug it in.</b> <span>USB-C, then press <a href="/connect">Connect</a> at the top. It boots to the underwear.</span></li>
          </ol>
        </div>
        <div class="assembly-stage" id="assembly-stage"></div>
      </div>
    </div>

    <div class="card wide case">
      <div>
        <h3>Print the case</h3>
        <p>A snap-together shell with no screws, designed from scratch and MIT licensed. PETG, 0.16 mm layers, 4 walls, no supports. Print the lid face down, the base floor down, and the caps flange down.</p>
        <div class="row">
          <a class="btn btn-sm btn-green" href="${CASE}full-set.stl" download>Full set (.stl)</a>
          <a class="btn btn-sm" href="${CASE}lid.stl" download>Lid</a>
          <a class="btn btn-sm" href="${CASE}base.stl" download>Base</a>
          <a class="btn btn-sm" href="${CASE}joystick.stl" download>Joystick</a>
          <a class="btn btn-sm" href="${CASE}button.stl" download>Button ×4</a>
        </div>
        <p class="fine">Source, measurements, and every iteration: <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">clawd-pico-case</a>. Why it's called a wedgie: <a href="/lore.md" target="_blank">the lore</a>.</p>
      </div>
    </div>
  </section>

  <section id="agents" class="sec agents">
    <a class="btn btn-lg" href="/skill.md" target="_blank"><span class="bot" aria-hidden="true">🤖</span> skill.md</a>
  </section>
`;

  place3D(main.querySelector<HTMLElement>("#art-order")!, { interactive: false, screens: SCREENS.wallet, side: 1 });

  main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => (b.onclick = () => {
    main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
  }));
  assembly(main.querySelector<HTMLElement>("#assembly")!);

  // The sticker leans toward the pointer, a little.
  const sticker = main.querySelector<HTMLElement>(".sticker");
  if (sticker && matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) {
    addEventListener("pointermove", (e) => {
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      sticker.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 8}deg) rotate(-3deg)`;
    });
  }
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
      const { mountAssembly3D } = await import("../ui/assembly3d");
      a3d = await mountAssembly3D(stage);
      update();
    } catch (err) { console.error("assembly:", err); }
  }, { rootMargin: "400px" }).observe(stage);
}
