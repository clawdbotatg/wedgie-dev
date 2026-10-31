// /assemble: the whole build, one step per card: the words, a drawing made from Austin's photo of that
// step, and the real photos under it (tap one to see it big). Source of truth for the steps:
// clawd-pico-case/assembly/ASSEMBLY.md. Drawings and photos: public/img/assemble/ (tools/asmimg.py).
import "./assemble.css";
import { KIT, PALETTE, hex, wires, setWires, isKit } from "./cablecolors";

type Step = { t: string; p: string; d?: string; ph: string[]; art?: string; tip?: string; warn?: string; end?: string };

// The 4 wires go by color: the kit's cable is white, yellow, black, red, top to bottom with the Trust M
// chip side up and the plug in its left socket. Another cable: its owner maps each to theirs (the box at
// the top of this page, cablecolors.ts), and every step says their colors. In the text: {w0} = what's in
// white's place, lower case; {W0} the same, capitalized.
const JOBS = [
  { job: "GND", to: "right 3rd", hole: "R2" },
  { job: "3V3", to: "right 5th", hole: "R4" },
  { job: "SDA", to: "left 6th", hole: "L5" },
  { job: "SCL", to: "left 7th", hole: "L6" },
];
export const say = (s: string, w: string[]) => s.replace(/\{([wW])([0-3])\}/g, (_, c, i) => c === "W" ? w[+i] : w[+i].toLowerCase());
const badge = (x: number, y: number, hex: string) => `<circle class="bd" cx="${x}" cy="${y}" r="11" style="fill:${hex}"/>`;

// The screen board's sockets seen from above (board face down, USB end up): the top 8 holes of each
// row. The four the chip uses show their wire's color; the 4th on the right is struck out.
export function headerArt(w: string[]) {
  const L = ["GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND"];
  const R = ["VBUS", "VSYS", "GND", "3V3_EN", "3V3", "VREF", "GP28", "AGND"];
  const use = Object.fromEntries(JOBS.map((j, i) => [j.hole, { c: w[i], hex: hex(w[i]) }]));
  const y = (i: number) => 58 + i * 30;
  let s = "";
  for (let i = 0; i < 8; i++) {
    for (const [side, x, names] of [["L", 150, L], ["R", 250, R]] as const) {
      const u = use[side + i], no = side === "R" && i === 3;
      s += u ? badge(x, y(i), u.hex) : `<rect class="hole${no ? " no" : ""}" x="${x - 11}" y="${y(i) - 11}" width="22" height="22" rx="5"/>`;
      if (no) s += `<path class="x" d="M${x - 7} ${y(i) - 7}l14 14m0-14l-14 14"/>`;
      const tx = side === "L" ? x - 22 : x + 22, a = side === "L" ? "end" : "start";
      s += `<text class="pn${u ? " on" : ""}" x="${tx}" y="${y(i) + 4}" text-anchor="${a}">${names[i]}</text>`;
      if (u) s += `<text class="wl" x="${side === "L" ? 10 : 390}" y="${y(i) + 4}" text-anchor="${side === "L" ? "start" : "end"}">${u.c}</text>`;
    }
    s += `<text class="rn" x="200" y="${y(i) + 4}" text-anchor="middle">${i + 1}</text>`;
  }
  return `<svg class="wire-art" viewBox="0 0 400 300" role="img" aria-label="${say("The screen board's sockets, face down, USB end up. {W0} wire in the right row's 3rd, {w1} right 5th, {w2} left 6th, {w3} left 7th. Never the right 4th.", w)}">
    <rect class="usb" x="170" y="6" width="60" height="22" rx="6"/><text class="usbt" x="200" y="21" text-anchor="middle">USB</text>
    <rect class="strip" x="132" y="38" width="36" height="252" rx="9"/><rect class="strip" x="232" y="38" width="36" height="252" rx="9"/>
    ${s}</svg>`;
}

// Steps /assemble/3d leaves out: most Picos don't need them (Austin, 10-19).
export const NO_3D = ["Snap off extra board"];

const RAW: Step[] = [
  { t: "Cable and tools",
    p: `In your kit: the STEMMA QT / Qwiic cable (4-pin JST-SH plug). You need: a wire stripper (it cuts near the hinge and strips near the tip), electrical tape, a stiff wire or pin, and tweezers.`,
    d: "01", ph: ["01-cable-and-strippers"] },
  { t: "Cut and strip the wires",
    p: `Keep one plug. Cut the wires about <b>2 in (5 cm)</b> from it, near the stripper's hinge. Strip with the notches near its tip. Strip off as much as a socket is deep, about <b>5 mm</b> (between 1/8 and 1/4 in), so the bare wire goes all the way down.`,
    d: "03", ph: ["03-cut-and-stripped-a", "03-cut-and-stripped-b"] },
  { t: "Lay out the screen board",
    p: `Turn the screen board face down, sockets up, USB mark at the top. Each wire pushes into a socket, no solder. Count sockets from the USB end:`,
    d: "04", ph: ["04-board-and-guide"], art: "{HEADER}",
    warn: `Never put anything in the 4th socket on the right row.` },
  { t: "Push in {w0} and {w1}",
    p: `Twist the strands at each tip tight, so each acts like one solid wire. On the right row: <b>{w0} into the 3rd</b>, <b>{w1} into the 5th</b>.`,
    d: "05", ph: ["05-white-yellow-in-header"],
    tip: `This is the hard part. Slow down. Get every strand in, no stray wire sticking out anywhere.` },
  { t: "Tape over the wires",
    p: `A small piece of electrical tape over those sockets, right on top of the wires, holds them in.`,
    d: "06", ph: ["06-tape-over-wires"] },
  { t: "Poke the holes open",
    p: `Push the stiff wire or pin through the tape into each covered socket. This opens the holes for the Pico's pins. The tape still holds the wires.`,
    d: "06t", ph: ["08-black-red-taped", "07-poke-holes-through-tape"] },
  { t: "{W2} and {w3}, same way",
    p: `On the left row: <b>{w2} into the 6th</b>, <b>{w3} into the 7th</b>. Tape over them. Poke the holes open.`,
    d: "08", ph: ["08-black-red-guide", "08-black-red-in-header", "08-black-red-taped"] },
  { t: "Header ready",
    p: `All 4 wires in, taped, holes open. Ready for the Pico.`,
    d: "09h", ph: ["09-header-ready"] },
  { t: "Plug in the chip",
    p: `Plug the cable back into the Trust M, either socket: both work. It only fits one way. Tilt the Trust M on its side and wedge it between the two rows of sockets, over the wires. It should be a snug fit: the Pico goes on top of it next.`,
    d: "10p", ph: ["10-chip-laid-down", "10-chip-plugged", "10-chip-plugged-side", "10-ready-for-pico"] },
  { t: "Snap off extra board",
    p: `Some Picos have a little extra board left on the end, away from the USB port. Pinch it with pliers and snap it off. Otherwise it won't fit the case.`,
    d: "11p", ph: ["11-snap-off-tab", "11-picos-with-tabs"] },
  { t: "Stack the boards",
    p: `Push the Pico into the sockets, <b>USB port at the same end as the screen board's USB mark</b>, the Pico's chips and BOOTSEL button facing out. Push straight, all the way in, until it's flush. The Trust M ends up wedged between the two boards.`,
    d: "10", ph: ["11-pico-going-on", "10-stacked-top", "10-chip-wedged", "10-headers-flush", "11-stacked-usb"],
    warn: `No pin, wire or chip sticking out. If anything does, do it again: it won't fit the case.` },
  { t: "Peel the screen protector",
    p: `Pull the blue tab off the screen.`,
    d: "13", ph: ["13-screen-protector"] },
  { t: "Case parts",
    p: `White lid, black base, joystick cap, 2 gray buttons, 1 green, 1 red.`,
    d: "14", ph: ["14-case-parts"] },
  { t: "Joystick cap",
    p: `Line up the square hole with the joystick and press hard until it snaps. It takes more force than you'd think. It should stay on upside down and click up, down, left, right and in.`,
    d: "15", ph: ["15-joystick-on", "15-joystick-side", "15-joystick-gap"],
    tip: `The small gap under the cap's rim is on purpose, so it can tilt.` },
  { t: "Buttons into the lid",
    p: `Lay the lid face down at the edge of the mat, so the buttons can hang out the front. Drop them in with tweezers: <b>green, gray, gray, red</b>. Green sits over the board's A button, red over Y.`,
    d: "16", ph: ["16-buttons-tweezers", "16-buttons-placed", "16-ready"] },
  { t: "Boards into the base",
    p: `Screen up, <b>USB end first</b> into the base's hole, then lower the rest. Don't force it straight down. The screen board lies flat on the rails, the USB port centered in the hole.`,
    d: "17", ph: ["17-in-base", "17-usb-centered"],
    warn: `The USB port must sit right in the middle of the hole. If it doesn't, something is wrong: take it out and do it again before you close the case.` },
  { t: "Check the USB fit",
    p: `Look at the USB end. The port must line up perfectly with the hole in the base.`,
    d: "15q", ph: ["15-usb-fit-check"],
    warn: `Not lined up? Push the Pico all the way into the screen board's sockets, and make sure the screen board sits flush on the base's supports.` },
  { t: "Close the case",
    p: `Flip the base over and lower it, screen down, into the lid (still face down, buttons in). Line it up and press hard until it snaps. It's tight on purpose.`,
    d: "18", ph: ["18-lower-into-lid", "18-press-closed", "18-closed", "18-closed-usb"] },
  { t: "Check the feel",
    p: `Press every button. Push the joystick every way and straight in. Each should click. Look for anything off: a tilted joystick, a stuck button.`,
    d: "19", ph: ["18-closed"] },
  { t: "Install the firmware",
    p: `Unplug it. Hold the <b>BOOTSEL</b> button through the small hole in the base with a paperclip, and plug in a USB data cable (USB-C or micro USB, whichever your Pico has). Let go once it's in. Open <a href="/reset">wedgie.dev/reset</a> in Chrome, click <b>Find it</b>, and follow the page. The screen stays dark until the firmware is on. Don't unplug while it runs.`,
    d: "fw", ph: ["18-closed-usb"],
    warn: `Firmware done, but the screen is still dark or shows an error? A wire is in the wrong socket, a wire came out, or the Trust M touches a Pico pin. Open the case and check.`,
    end: `<div class="row"><a class="btn btn-green" href="/reset">Go to Reset</a></div>` },
  { t: "Install the software",
    p: `Leave it plugged in. Open <a href="/connect">wedgie.dev/connect</a> in Chrome and follow the page.`,
    d: "sw", ph: [],
    end: `<div class="row"><a class="btn btn-green" href="/connect">Go to Connect</a></div>` },
];

/** The steps in your cable's colors (w: what's in white's, yellow's, black's, red's place). */
export function stepsFor(w: string[]): Step[] {
  return RAW.map((s) => ({ ...s, t: say(s.t, w), p: say(s.p, w), art: s.art === "{HEADER}" ? headerArt(w) : s.art }));
}
/** The kit's cable (the printed manual). */
export const STEPS = stepsFor(KIT);
// The steps whose photos show the cable: with your own colors, each says which of the kit's is yours.
const WIRE_STEPS = 9;

// "If something's off", on the page and in the printed manual.
export const TROUBLE: [string, string][] = [
  ["It doesn't show up on USB", "A charge-only cable, or BOOTSEL wasn't held while plugging in."],
  ["The screen stays black", "The Pico isn't fully seated. Press it straight in until it's flush."],
  ["No chip found", "A wire in the wrong socket, a wire that came out, or the chip board touching a Pico pin."],
  ["A wire keeps coming out", "Twist the bare end tighter, push it all the way down, and tape it before the Pico goes in."],
];

const IMG = "/img/assemble/";

const sw = (c: string) => `<i class="sw" style="background:${hex(c)}"></i>`;
const CABLE_PHOTO = "02-trust-m-plug";

export function assemble(main: HTMLElement) {
  let w = wires();
  main.innerHTML = `
  <section class="sec asm">
    <div class="sec-head">
      <span class="kicker">Assembly</span>
      <h2>Put a wedgie together.</h2>
      <p>No soldering. ${RAW.length} steps. Take your time on the wires (2 to 9); the rest just clicks. <a href="/assemble.pdf" download>Print the manual (PDF)</a></p>
      <p class="row"><a class="btn btn-green" href="/assemble/3d">Every step in 3D →</a></p>
    </div>
    <div class="card cbl" id="cbl">
      <button type="button" class="cbl-ph" data-ph="${CABLE_PHOTO}" aria-label="Photo"><img src="${IMG}p/${CABLE_PHOTO}.webp" alt="The kit's cable in the Trust M's left socket: white, yellow, black, red, top to bottom"></button>
      <div class="cbl-ask">
        <h3 id="cbl-title"></h3>
        <p class="cbl-now" id="cbl-now"></p>
        <button type="button" class="btn btn-green" id="cbl-open">Map wire colors</button>
      </div>
      <div class="cbl-map" id="cbl-map" hidden>
        <div class="cbl-3d recess" id="cbl-3d"></div>
        <ol class="cbl-rows">
          ${KIT.map((k, i) => `<li><span class="cbl-kit">${sw(k)}<b>${k}</b></span><span class="cbl-arrow">→</span>
            <span class="cbl-pick" data-i="${i}">${Object.keys(PALETTE).map((c) => `<button type="button" data-c="${c}" style="background:${hex(c)}" aria-label="${k} is ${c}" title="${c}"></button>`).join("")}</span></li>`).join("")}
        </ol>
        <p class="note bad" id="cbl-same" hidden>Two wires have the same color.</p>
        <div class="row cbl-btns"><button type="button" class="btn" id="cbl-kit">Kit colors</button><button type="button" class="btn" id="cbl-done">Done</button></div>
      </div>
    </div>
    <ol class="asm-steps" id="asm-steps"></ol>

    <div class="card asm-trouble">
      <h3>If something's off</h3>
      <dl>
        ${TROUBLE.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join("")}
      </dl>
    </div>
    <dialog class="asm-big"><img alt=""><button type="button" class="btn">Close</button></dialog>
  </section>`;

  const $ = (id: string) => main.querySelector<HTMLElement>("#" + id)!;
  const list = $("asm-steps"), map = $("cbl-map"), open = $("cbl-open");
  // A step's photos show the kit's colors: with yours, the cable steps say which is which.
  const key = () => isKit(w) ? "" : `<p class="cbl-key">In the photos: ${KIT.map((k, i) => `<span>${sw(k)}→${sw(w[i])}</span>`).join("")}</p>`;
  function paint() {
    const kit = isKit(w);
    $("cbl-title").textContent = kit ? "Cable not these colors?" : "Your cable";
    $("cbl-now").innerHTML = kit ? "" : KIT.map((k, i) => `<span>${sw(k)}→${sw(w[i])}<b>${w[i]}</b></span>`).join("");
    map.querySelectorAll<HTMLElement>(".cbl-pick").forEach((p) => p.querySelectorAll<HTMLElement>("button").forEach((b) => {
      const on = b.dataset.c === w[+p.dataset.i!];
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    }));
    $("cbl-same").hidden = new Set(w).size === 4;
    list.innerHTML = stepsFor(w).map((s, i) => `
      <li class="card asm-step" id="step-${i + 1}">
        <div class="asm-copy">
          <div class="asm-head"><span class="num">${i + 1}</span><h3>${s.t}</h3>${NO_3D.includes(RAW[i].t) ? "" : `<a class="asm-3d" href="/assemble/3d${location.search}#${i + 1}">See it in 3D →</a>`}</div>
          <p>${s.p}</p>
          ${s.art ? `<div class="asm-art recess">${s.art}</div>` : ""}
          ${i < WIRE_STEPS ? key() : ""}
          ${s.tip ? `<p class="note">${s.tip}</p>` : ""}
          ${s.warn ? `<p class="note bad">${s.warn}</p>` : ""}
          ${s.end || ""}
        </div>
        <figure class="draw">
          <img src="${s.d ? `${IMG}d${s.d}.webp` : `${IMG}p/${s.ph[0]}.webp`}" alt="Step ${i + 1}: ${s.t}" loading="lazy">
          <figcaption class="photos">${s.ph.map((f) => `<button type="button" data-ph="${f}" aria-label="Photo"><img src="${IMG}t/${f}.webp" alt="" loading="lazy"></button>`).join("")}</figcaption>
        </figure>
      </li>`).join("");
    main.querySelectorAll<HTMLAnchorElement>('a[href^="/assemble/3d"]').forEach((a) => { a.href = "/assemble/3d" + location.search + (a.hash || ""); });
  }
  paint();

  let c3d: import("../ui/cable3d").Cable3D | null = null;
  open.addEventListener("click", () => {
    map.hidden = false; open.hidden = true;
    if (!c3d) import("../ui/cable3d").then(async ({ mountCable3D }) => { c3d = await mountCable3D($("cbl-3d"), w.map(hex)); })
      .catch((err) => { console.error("cable 3D:", err); $("cbl-3d").hidden = true; });
  });
  const set = (nw: string[]) => { w = nw; setWires(w); c3d?.setColors(w.map(hex)); paint(); };
  map.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-c]");
    if (!b) return;
    const i = +b.closest<HTMLElement>(".cbl-pick")!.dataset.i!;
    set(w.map((c, j) => j === i ? b.dataset.c! : c));
  });
  $("cbl-kit").addEventListener("click", () => set([...KIT]));
  $("cbl-done").addEventListener("click", () => { map.hidden = true; open.hidden = false; c3d?.destroy(); c3d = null; $("cbl-3d").innerHTML = ""; });

  const big = main.querySelector<HTMLDialogElement>(".asm-big")!, bigImg = big.querySelector("img")!;
  main.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ph]");
    if (b) { bigImg.src = `${IMG}p/${b.dataset.ph}.webp`; big.showModal(); }
  });
  big.addEventListener("click", () => big.close());
}
