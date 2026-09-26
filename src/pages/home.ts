// The front page: give yourself a wedgie. Get one, or build one; agents at the bottom.
import { esc } from "../ui/device";
import { place3D, SCREENS } from "../ui/place3d";

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";
const SKILL_URL = location.origin + "/skill.md";

export function home(main: HTMLElement) {
  main.innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <h1>Give yourself<br>a wedgie.</h1>
      <p class="lede">A pocket computer from three off-the-shelf parts: a Pico, a screen hat, and a secure chip
      <em>wedged</em> in between. Make it a wallet, a game, or whatever you and your agent dream up.
      Every file is MIT.</p>
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
      <p>Assembled, tested, and mailed to you. Or send one to someone who needs one.</p>
    </div>
    <div class="card order">
      <div class="order-art" id="art-order"></div>
      <div class="order-body">
        <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="order-price">$67 <span>shipped</span></div>
        <p>One wedgie: Pico, screen hat, and chip, wedged, cased, and flashed.</p>
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

    <div class="card wide assemble">
      <div>
        <h3>Put it together</h3>
        <ol>
          <li>Plug the Pico into the hat's header: parts toward the screen, USB at the joystick end.</li>
          <li>Plug the cable into the chip. Its plug runs GND, 3.3 V, SDA, SCL from one end: <em>trust that order, not the wire colors</em>. Looking at the Pico side with USB at the top, push the bare wires into the hat's header <em>beside</em> the Pico pins, counting holes from the USB end: GND right 3rd, 3.3 V right 5th (never the 4th), SDA left 6th, SCL left 7th.</li>
          <li>Wedge the chip into the gap between the two boards, wires flat.</li>
          <li>Snap it into the case and plug it in. Press <a href="/connect">Connect</a> at the top.</li>
        </ol>
      </div>
      <div class="assemble-art" id="art-build"></div>
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

  <section id="agents" class="sec">
    <div class="sec-head">
      <span class="kicker">Agents</span>
      <h2>Hand your wedgie to your agent.</h2>
      <p>One skill file teaches your coding agent the wedgie: how to write an app, install it, see the real screen, and press the buttons. <code>wedgie.py</code> is the one-file tool it uses to do that over USB.</p>
    </div>
    <div class="card wide skill">
      <div class="recess code"><span id="skill-url">${esc(SKILL_URL)}</span></div>
      <div class="row">
        <button class="btn btn-green btn-sm" id="copy-prompt">Copy a prompt for your agent</button>
        <a class="btn btn-sm" href="/skill.md" target="_blank">Read skill.md</a>
        <a class="btn btn-sm" href="/wedgie.py" download>wedgie.py</a>
      </div>
    </div>
  </section>
`;

  place3D(main.querySelector<HTMLElement>("#art-order")!, { interactive: false, screens: SCREENS.wallet, side: 1 });
  place3D(main.querySelector<HTMLElement>("#art-build")!, { interactive: false, screens: SCREENS.apps, side: -1 });

  main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => (b.onclick = () => {
    main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
  }));
  main.querySelector<HTMLButtonElement>("#copy-prompt")!.onclick = async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(`Read ${SKILL_URL} and help me build an app for my wedgie.`).catch(() => {});
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy a prompt for your agent"), 1600);
  };

  // The sticker leans toward the pointer, a little.
  const sticker = main.querySelector<HTMLElement>(".sticker");
  if (sticker && matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) {
    addEventListener("pointermove", (e) => {
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      sticker.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 8}deg) rotate(-3deg)`;
    });
  }
}
