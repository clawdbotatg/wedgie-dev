// /assemble: the whole build, one step per card: the words, a drawing made from Austin's photo of that
// step, and the real photos under it (tap one to see it big). Source of truth for the steps:
// clawd-pico-case/assembly/ASSEMBLY.md. Drawings and photos: public/img/assemble/ (tools/asmimg.py).
import "./assemble.css";

type Step = { t: string; p: string; d?: string; ph: string[]; art?: string; tip?: string; warn?: string; end?: string };

// The 4 wires go by their place in the plug, never by color: cables come in any colors (public/lore.md).
// Number = place in the plug, top to bottom: Trust M chip side up, words readable, plug in the left socket.
// The right socket is turned around, so there the order reads backwards. Both sockets are wired the same.
const WIRES = [
  { n: 1, job: "GND", to: "right 3rd", hole: "R2" },
  { n: 2, job: "3V3", to: "right 5th", hole: "R4" },
  { n: 3, job: "SDA", to: "left 6th", hole: "L5" },
  { n: 4, job: "SCL", to: "left 7th", hole: "L6" },
];
const badge = (x: number, y: number, n: number) =>
  `<circle class="bd" cx="${x}" cy="${y}" r="11"/><text class="bn" x="${x}" y="${y + 4.5}" text-anchor="middle">${n}</text>`;

// The Trust M board with the plug in, as in the step's photo: each wire's number, job and socket.
export const PLUG = (() => {
  let s = "";
  WIRES.forEach((w, i) => {
    const y = 74 + i * 26;
    s += `<path class="wire" d="M268 ${100 + i * 8}C240 ${100 + i * 8} 230 ${y} 200 ${y}H186"/>`;
    s += badge(174, y, w.n);
    s += `<text class="wj" x="156" y="${y + 5}" text-anchor="end">${w.job}<tspan class="wt"> → ${w.to}</tspan></text>`;
  });
  return `<svg class="wire-art" viewBox="24 36 372 148" role="img" aria-label="The Trust M with the plug on its left. Top to bottom: wire 1 GND goes to the right row's 3rd socket, 2 3V3 right 5th, 3 SDA left 6th, 4 SCL left 7th.">
    <rect class="board" x="276" y="40" width="116" height="140" rx="14"/>
    <text class="bt" x="334" y="64" text-anchor="middle">Trust M</text>
    <rect class="chip" x="316" y="96" width="36" height="36" rx="4"/>
    <rect class="plug" x="262" y="90" width="26" height="44" rx="3"/>
    <rect class="sock" x="370" y="92" width="14" height="40" rx="2"/>
    ${s}</svg>`;
})();

// The screen board's sockets seen from above (board face down, USB end up): the top 8 holes of each
// row. The four the chip uses carry their wire's number; the 4th on the right is struck out.
export const HEADER = (() => {
  const L = ["GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND"];
  const R = ["VBUS", "VSYS", "GND", "3V3_EN", "3V3", "VREF", "GP28", "AGND"];
  const use = Object.fromEntries(WIRES.map((w) => [w.hole, w]));
  const y = (i: number) => 58 + i * 30;
  let s = "";
  for (let i = 0; i < 8; i++) {
    for (const [side, x, names] of [["L", 150, L], ["R", 250, R]] as const) {
      const u = use[side + i], no = side === "R" && i === 3;
      s += u ? badge(x, y(i), u.n) : `<rect class="hole${no ? " no" : ""}" x="${x - 11}" y="${y(i) - 11}" width="22" height="22" rx="5"/>`;
      if (no) s += `<path class="x" d="M${x - 7} ${y(i) - 7}l14 14m0-14l-14 14"/>`;
      const tx = side === "L" ? x - 22 : x + 22, a = side === "L" ? "end" : "start";
      s += `<text class="pn${u ? " on" : ""}" x="${tx}" y="${y(i) + 4}" text-anchor="${a}">${names[i]}</text>`;
      if (u) s += `<text class="wl" x="${side === "L" ? 10 : 390}" y="${y(i) + 4}" text-anchor="${side === "L" ? "start" : "end"}">${u.n} ${u.job}</text>`;
    }
    s += `<text class="rn" x="200" y="${y(i) + 4}" text-anchor="middle">${i + 1}</text>`;
  }
  return `<svg class="wire-art" viewBox="0 0 400 300" role="img" aria-label="The screen board's sockets, face down, USB end up. Wire 1 GND in the right row's 3rd, 2 3V3 right 5th, 3 SDA left 6th, 4 SCL left 7th. Never the right 4th.">
    <rect class="usb" x="170" y="6" width="60" height="22" rx="6"/><text class="usbt" x="200" y="21" text-anchor="middle">USB</text>
    <rect class="strip" x="132" y="38" width="36" height="252" rx="9"/><rect class="strip" x="232" y="38" width="36" height="252" rx="9"/>
    ${s}</svg>`;
})();

// Steps /assemble/3d leaves out: most Picos don't need them (Austin, 10-19).
export const NO_3D = ["Snap off extra board", "Cut off plastic guards (Pico 2 W only)"];

export const STEPS: Step[] = [
  { t: "Cable and tools",
    p: `In your kit: the STEMMA QT / Qwiic cable (4-pin JST-SH plug). You need: a wire stripper (it cuts near the hinge and strips near the tip), electrical tape, a stiff breadboard jumper wire, and tweezers.`,
    d: "01", ph: ["01-cable-and-strippers"] },
  { t: "Cut and strip the wires",
    p: `Keep one plug. Cut the wires about <b>2 in (5 cm)</b> from it, near the stripper's hinge. Strip with the notches near its tip. Strip off as much as a socket is deep, about <b>5 mm</b> (between 1/8 and 1/4 in), so the bare wire goes all the way down.`,
    d: "03", ph: ["03-cut-and-stripped-a", "03-cut-and-stripped-b"] },
  { t: "Number the wires",
    p: `Lay the Trust M <b>chip side up</b>, words readable. Plug the cable into the <b>left</b> socket. The wires are <b>1 to 4, top to bottom</b>. Mark them with a pen. Go by place, never by color: cables differ. Unplug it.`,
    d: "02", ph: ["02-trust-m-plug"], art: PLUG,
    tip: `In our photos: 1 white, 2 yellow, 3 black, 4 red.`,
    warn: `Count only this way. Chip side down or in the right socket, the order reads backwards.` },
  { t: "Lay out the screen board",
    p: `Turn the screen board face down, sockets up, USB mark at the top. Each wire pushes into a socket, no solder. Count sockets from the USB end:`,
    d: "04", ph: ["04-board-and-guide"], art: HEADER,
    warn: `Never put anything in the 4th socket on the right row.` },
  { t: "Push in wires 1 and 2",
    p: `Twist the strands at each tip tight, so each acts like one solid wire. On the right row: <b>1 (GND) into the 3rd</b>, <b>2 (3V3) into the 5th</b>.`,
    d: "05", ph: ["05-white-yellow-in-header"] },
  { t: "Tape over the wires",
    p: `A small piece of electrical tape over those sockets, right on top of the wires, holds them in.`,
    d: "06", ph: ["06-tape-over-wires"] },
  { t: "Poke the holes open",
    p: `Push the stiff jumper wire through the tape into each covered socket. This opens the holes for the Pico's pins. The tape still holds the wires.`,
    d: "06t", ph: ["08-black-red-taped", "07-poke-holes-through-tape"] },
  { t: "Wires 3 and 4, same way",
    p: `On the left row: <b>3 (SDA) into the 6th</b>, <b>4 (SCL) into the 7th</b>. Tape over them. Poke the holes open.`,
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
  { t: "Cut off plastic guards (Pico 2 W only)",
    p: `We don't recommend a Pico 2 W: a hardware wallet shouldn't have WiFi. Got one anyway? Flip it over. It probably has 3 black plastic guards across the back. Cut off the middle one and one of the end ones with clippers. Keep the plastic along the pins.`,
    d: "11g", ph: ["11-guards", "11-guards-end", "11-guards-cut", "11-guards-cut-parts"],
    warn: `On a Pico 2 W you have to. With the guards on, the Trust M can't wedge in.` },
  { t: "Stack the boards",
    p: `Push the Pico into the sockets, <b>USB port at the same end as the screen board's USB mark</b>, the Pico's chips and BOOTSEL button facing out. Push straight, all the way in, until it's flush. The Trust M ends up wedged between the two boards.`,
    d: "10", ph: ["11-pico-going-on", "10-stacked-top", "10-chip-wedged", "10-headers-flush", "11-stacked-usb"],
    warn: `No pin, wire or chip sticking out. If anything does, do it again: it won't fit the case.` },
  { t: "Test the boards",
    p: `Hold the Pico's <b>BOOTSEL</b> button (tweezers help) and plug in a USB data cable (USB-C or micro USB, whichever your Pico has). Always hold it: many Picos come with software on them and won't show up without it. Open <a href="/test">wedgie.dev/test</a> in Chrome and click <b>Test it</b>. Don't unplug while it runs. Wait for <b>Board, Firmware, Chip</b> to go green, then unplug. Shake, Buttons and Colors come after the case is on.`,
    d: "11", ph: ["11-bootsel", "11-test-page", "11-test-wiping", "11-test-firmware"],
    tip: `First time on this computer? The test page has a one-time setup so Chrome stops asking about every new Pico.`,
    warn: `Chip fails? A wire is in the wrong socket, a wire came out, or the Trust M touches a Pico pin. Take it apart and check.` },
  { t: "The black base",
    p: `Your kit has a <b>black</b> base. Black means a Trust M chip is inside. (Red is a Pico W with a battery, gray is the ATECC608.)`,
    d: "12", ph: ["13-bases"] },
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
  { t: "Full test",
    p: `Plug it in: it shows <b>wedgie.dev</b> and the underwear. On <a href="/test">wedgie.dev/test</a> click <b>Test only</b>. The wedgie shows a red FULL CONTROL warning: press green on the wedgie. Then the chip check, then <b>shake</b> it (tap, squeeze, light drops on each side) until the counter stops, press each button it asks for, and check each color for scratches or dead pixels. <b>PASS</b> on the wedgie and the page: done.`,
    d: "20", ph: ["20-no-software", "20-test-only", "20-full-control", "20-press-green", "20-shake", "20-buttons", "20-colors", "20-pass", "20-pass-page"],
    tip: `Need to wipe it after the case is closed? Press BOOTSEL through the small hole in the base with a paperclip while you plug it in.` },
  { t: "Done",
    p: `It's ready. Go to <a href="/connect">wedgie.dev/connect</a> to set it up.`,
    d: "21", ph: ["21-box"], end: `<div class="row"><a class="btn btn-green" href="/connect">Go to Connect</a></div>` },
];

// "If something's off", on the page and in the printed manual.
export const TROUBLE: [string, string][] = [
  ["It doesn't show up on USB", "A charge-only cable, or BOOTSEL wasn't held while plugging in."],
  ["The screen stays black", "The Pico isn't fully seated. Press it straight in until it's flush."],
  ["No chip found", "A wire in the wrong socket, a wire that came out, or the chip board touching a Pico pin."],
  ["A wire keeps coming out", "Twist the bare end tighter, push it all the way down, and tape it before the Pico goes in."],
];

const IMG = "/img/assemble/";

export function assemble(main: HTMLElement) {
  main.innerHTML = `
  <section class="sec asm">
    <div class="sec-head">
      <span class="kicker">Assembly</span>
      <h2>Put a wedgie together.</h2>
      <p>No soldering. ${STEPS.length} steps. Take your time on the wires (3 to 9); the rest just clicks. <a href="/assemble.pdf" download>Print the manual (PDF)</a></p>
      <p class="row"><a class="btn btn-green" href="/assemble/3d">Every step in 3D →</a></p>
    </div>
    <ol class="asm-steps">
      ${STEPS.map((s, i) => `
      <li class="card asm-step" id="step-${i + 1}">
        <div class="asm-copy">
          <div class="asm-head"><span class="num">${i + 1}</span><h3>${s.t}</h3>${NO_3D.includes(s.t) ? "" : `<a class="asm-3d" href="/assemble/3d#${i + 1}">See it in 3D →</a>`}</div>
          <p>${s.p}</p>
          ${s.art ? `<div class="asm-art recess">${s.art}</div>` : ""}
          ${s.tip ? `<p class="note">${s.tip}</p>` : ""}
          ${s.warn ? `<p class="note bad">${s.warn}</p>` : ""}
          ${s.end || ""}
        </div>
        <figure class="draw">
          <img src="${s.d ? `${IMG}d${s.d}.webp` : `${IMG}p/${s.ph[0]}.webp`}" alt="Step ${i + 1}: ${s.t}" loading="lazy">
          <figcaption class="photos">${s.ph.map((f) => `<button type="button" data-ph="${f}" aria-label="Photo"><img src="${IMG}t/${f}.webp" alt="" loading="lazy"></button>`).join("")}</figcaption>
        </figure>
      </li>`).join("")}
    </ol>

    <div class="card asm-trouble">
      <h3>If something's off</h3>
      <dl>
        ${TROUBLE.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join("")}
      </dl>
    </div>
    <dialog class="asm-big"><img alt=""><button type="button" class="btn">Close</button></dialog>
  </section>`;

  const big = main.querySelector<HTMLDialogElement>(".asm-big")!, bigImg = big.querySelector("img")!;
  main.querySelectorAll<HTMLButtonElement>("[data-ph]").forEach((b) => b.addEventListener("click", () => {
    bigImg.src = `${IMG}p/${b.dataset.ph}.webp`; big.showModal();
  }));
  big.addEventListener("click", () => big.close());
}
