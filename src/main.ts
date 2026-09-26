import "@fontsource-variable/nunito/wght.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/silkscreen/400.css";
import "./style.css";
import { deviceSvg, esc } from "./ui/device";
import * as W from "./serial/wedgies";
import { openPanel } from "./ui/panel";
import { firmwareManifest } from "./serial/install";

let latest = "";
firmwareManifest().then((m) => { latest = m.version; drawTray(); }).catch(() => {});
function badge(w: W.Wedgie) {
  if (w.state !== "ready") return "";
  if (w.kind === "wedgie") return latest && w.version !== latest ? `<span class="badge">update</span>` : "";
  return `<span class="badge grey">needs firmware</span>`;
}

const CASE = "https://raw.githubusercontent.com/clawdbotatg/clawd-pico-case/main/stl/current/";
const SKILL_URL = location.origin + "/skill.md";

const app = document.getElementById("app")!;
app.innerHTML = `
<header class="top">
  <a class="brand" href="#top"><img src="/img/sticker.webp" alt="" width="46" height="35"><span class="tag">wedgie.dev</span></a>
  <nav>
    <a class="pill" href="#get">Get one</a>
    <a class="pill" href="#build">Build one</a>
    <a class="pill" href="#plug">Plug in <span class="led" id="led"></span><b id="count"></b></a>
    <a class="pill" href="#agents">Agents</a>
  </nav>
</header>

<main id="top">
  <section class="hero">
    <div class="hero-copy">
      <h1>Give yourself<br>a wedgie.</h1>
      <p class="lede">A pocket computer from three off-the-shelf parts: a Pico, a screen hat, and a secure chip
      <em>wedged</em> in between. Make it a wallet, a game, or whatever you and your agent dream up.
      Every file is MIT.</p>
      <div class="row">
        <a class="btn btn-green" href="#get">Get a wedgie · $50</a>
        <a class="btn" href="#build">Build your own</a>
      </div>
    </div>
    <div class="hero-art"><img class="sticker" src="/img/sticker-wedgie-dev.webp" alt="a pair of white briefs with a green, grey and red waistband and a wedgie.dev tag"></div>
  </section>

  <div class="band" aria-hidden="true"><i></i><i></i><i></i></div>

  <section id="plug" class="sec">
    <div class="sec-head">
      <span class="kicker">Plug in</span>
      <h2>Your wedgies</h2>
      <p>Plug a wedgie into USB-C. It shows up here with its ID. Click it to test it, send it code, or debug it.</p>
    </div>
    <div class="tray" id="tray"></div>
    <div class="row center" id="plug-actions"></div>
  </section>

  <section id="build" class="sec">
    <div class="sec-head">
      <span class="kicker">Build one</span>
      <h2>Three parts. One wedge.</h2>
      <p>No soldering. Order the parts anywhere, from anyone. To a store it's just a dev board, a screen, and a chip.</p>
    </div>
    <div class="parts">
      <div class="card part"><div class="num">1</div><h3>A Pico</h3><p>The brain. The printed case fits the USB-C RP2040 Pico. A Pico 2 W runs the same code.</p>
        <div class="price">~$5–12</div><a class="btn btn-sm" href="https://www.amazon.com/s?k=RP2040+pico+USB-C+pre-soldered+header" target="_blank" rel="noopener">Find one</a></div>
      <div class="card part"><div class="num">2</div><h3>The screen hat</h3><p>Waveshare Pico-LCD-1.3: a 240×240 screen, a joystick, and four buttons. The Pico plugs straight in.</p>
        <div class="price">~$15</div><a class="btn btn-sm" href="https://www.amazon.com/dp/B092VVCBQP" target="_blank" rel="noopener">Amazon</a></div>
      <div class="card part"><div class="num">3</div><h3>The chip</h3><p>An ATECC608 secure element on a STEMMA QT cable. Its bare wires push into the header, and the chip gets wedged between the boards.</p>
        <div class="price">~$6 + cable</div><a class="btn btn-sm" href="https://www.adafruit.com/product/4314" target="_blank" rel="noopener">Adafruit</a></div>
    </div>

    <div class="card wide assemble">
      <div>
        <h3>Put it together</h3>
        <ol>
          <li>Plug the Pico into the hat's header: parts toward the screen, USB at the joystick end.</li>
          <li>Plug the cable into the chip. Push its four bare wires into the hat's header <em>beside</em> the Pico pins: red to 3V3 (pin 36), black to GND (pin 38), blue to GP4 (pin 6), yellow to GP5 (pin 7).</li>
          <li>Wedge the chip into the gap between the two boards, wires flat.</li>
          <li>Snap it into the case and plug it in. It shows up <a href="#plug">above</a>.</li>
        </ol>
      </div>
      <div class="assemble-art">${deviceSvg({ kind: "id", id: "WEDGIE", sub: "hello" })}</div>
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
        <p class="fine">Source, measurements, and every iteration: <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">clawd-pico-case</a>.</p>
      </div>
    </div>
  </section>

  <section id="get" class="sec">
    <div class="sec-head">
      <span class="kicker">Get one</span>
      <h2>Or we'll give you a wedgie.</h2>
      <p>Assembled, tested, and mailed to you. Or send one to someone who needs one.</p>
    </div>
    <div class="card order">
      <div class="order-art">${deviceSvg({ kind: "loading", p: 0.62 })}</div>
      <div class="order-body">
        <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="order-price">$50 <span>shipped</span></div>
        <p>One wedgie: Pico, screen hat, and chip, wedged, cased, and flashed.</p>
        <div class="seg" role="radiogroup" aria-label="who is it for">
          <button class="on" data-for="me" role="radio" aria-checked="true">For me</button>
          <button data-for="gift" role="radio" aria-checked="false">Give someone a wedgie</button>
        </div>
        <div class="row">
          <button class="btn btn-green" data-pay="usdc" disabled>Pay with USDC</button>
          <button class="btn" data-pay="card" disabled>Pay with card</button>
        </div>
        <p class="fine soon">Checkout opens soon. Everything is MIT, so you can always <a href="#build">build your own</a>.</p>
      </div>
    </div>
  </section>

  <section id="agents" class="sec">
    <div class="sec-head">
      <span class="kicker">Agents</span>
      <h2>Hand your wedgie to your agent.</h2>
      <p>One skill file teaches your coding agent the hardware: the screen, the buttons, the chip, and how to put code on it.</p>
    </div>
    <div class="card wide skill">
      <div class="recess code"><span id="skill-url">${esc(SKILL_URL)}</span></div>
      <div class="row">
        <button class="btn btn-green btn-sm" id="copy-prompt">Copy a prompt for your agent</button>
        <a class="btn btn-sm" href="/skill.md" target="_blank">Read skill.md</a>
      </div>
    </div>
  </section>
</main>

<footer class="foot">
  <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
  <p>Hardware, case, firmware, and this site are MIT licensed. Build it, fork it, sell it.</p>
  <p class="fine"><a href="https://github.com/clawdbotatg/wedgie-dev" target="_blank" rel="noopener">wedgie-dev</a> ·
  <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">case</a> ·
  <a href="https://github.com/austintgriffith/picowallet" target="_blank" rel="noopener">picowallet</a></p>
</footer>
`;

// ---- the tray of plugged-in wedgies ---------------------------------------------------------------
const tray = document.getElementById("tray")!;
const actions = document.getElementById("plug-actions")!;

function screenFor(w: W.Wedgie) {
  if (w.state === "identifying") return { kind: "loading", p: 0.4 } as const;
  if (w.state === "error") return { kind: "text", text: "?" } as const;
  return { kind: "id", id: w.short || "", sub: w.board } as const;
}

// Repaint by key: frames change several times while a wedgie identifies; keep nodes stable.
function drawTray() {
  const ws = W.wedgies();
  document.getElementById("count")!.textContent = ws.length ? String(ws.length) : "";
  document.getElementById("led")!.classList.toggle("on", ws.some((w) => w.state === "ready"));
  if (!W.supported()) {
    tray.innerHTML = `<div class="empty"><p><b>This browser can't see USB devices.</b><br>Open wedgie.dev in Chrome or Edge on a computer to plug in a wedgie.</p></div>`;
    actions.innerHTML = "";
    return;
  }
  if (!ws.length) {
    tray.innerHTML = `<div class="empty">${deviceSvg({ kind: "off" }, { cls: "ghost" })}<p>No wedgies yet. Plug one in and press <b>Connect</b>. After the first time, it shows up by itself.</p></div>`;
  } else {
    tray.querySelector(".empty")?.remove();
    const keep = new Set(ws.map((w) => String(w.key)));
    tray.querySelectorAll<HTMLElement>(".slot").forEach((el) => { if (!keep.has(el.dataset.key!)) el.remove(); });
    for (const w of ws) {
      let el = tray.querySelector<HTMLElement>(`.slot[data-key="${w.key}"]`);
      const sig = `${w.state}|${w.short}|${w.board}|${w.error}|${w.kind}|${w.version}|${latest}`;
      if (!el) {
        el = document.createElement("button");
        el.className = "slot";
        el.dataset.key = String(w.key);
        el.onclick = () => openPanel(w);
        tray.appendChild(el);
      }
      if (el.dataset.sig === sig) continue;
      el.dataset.sig = sig;
      el.innerHTML = deviceSvg(screenFor(w)) +
        `<span class="idtag">${w.state === "identifying" ? "finding…" : w.state === "error" ? "can't talk" : esc(w.short)}</span>` +
        `<span class="meta">${w.state === "error" ? esc(w.error) : esc([w.board, w.kind === "wedgie" ? "wedgie " + w.version : w.chip?.type].filter(Boolean).join(" · "))}${badge(w)}</span>`;
    }
  }
  actions.innerHTML = `<button class="btn btn-green" id="connect">${ws.length ? "Connect another" : "Connect a wedgie"}</button>`;
  document.getElementById("connect")!.onclick = () => W.connectNew().catch(() => {});
}
W.onChange(drawTray);
drawTray();
W.start();

// ---- small bits -----------------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll<HTMLButtonElement>(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
}));
document.getElementById("copy-prompt")!.onclick = async (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  await navigator.clipboard.writeText(`Read ${SKILL_URL} and help me build an app for my wedgie.`).catch(() => {});
  b.textContent = "Copied";
  setTimeout(() => (b.textContent = "Copy a prompt for your agent"), 1600);
};

// The sticker leans toward the pointer, a little.
const sticker = document.querySelector<HTMLElement>(".sticker");
if (sticker && matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) {
  addEventListener("pointermove", (e) => {
    const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
    sticker.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 8}deg) rotate(-3deg)`;
  });
}

(window as any).__wedgieReady?.();
