// /assemble: the whole build, one step per card: the words, a drawing made from Austin's photo of that
// step, and the real photos under it (tap one to see it big). Source of truth for the steps:
// clawd-pico-case/assembly/ASSEMBLY.md. Drawings and photos: public/img/assemble/ (tools/asmimg.py).
import "./assemble.css";

type Step = { t: string; p: string; d?: string; ph: string[]; art?: string; tip?: string; warn?: string; end?: string };

// The screen board's sockets seen from above (board face down, USB end up): the top 8 holes of each
// row. The four the chip uses are filled with their wire's color; the 4th on the right is struck out.
export const HEADER = (() => {
  const L = ["GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND"];
  const R = ["VBUS", "VSYS", "GND", "3V3_EN", "3V3", "VREF", "GP28", "AGND"];
  const use: Record<string, [string, string]> = { "L5": ["Black", "black"], "L6": ["Red", "red"], "R2": ["White", "white"], "R4": ["Yellow", "yellow"] };
  const y = (i: number) => 58 + i * 30;
  let s = "";
  for (let i = 0; i < 8; i++) {
    for (const [side, x, names] of [["L", 150, L], ["R", 250, R]] as const) {
      const u = use[side + i], no = side === "R" && i === 3;
      s += `<rect class="hole${u ? " w-" + u[1] : ""}${no ? " no" : ""}" x="${x - 11}" y="${y(i) - 11}" width="22" height="22" rx="5"/>`;
      if (no) s += `<path class="x" d="M${x - 7} ${y(i) - 7}l14 14m0-14l-14 14"/>`;
      const tx = side === "L" ? x - 22 : x + 22, a = side === "L" ? "end" : "start";
      s += `<text class="pn${u ? " on" : ""}" x="${tx}" y="${y(i) + 4}" text-anchor="${a}">${names[i]}</text>`;
      if (u) s += `<text class="wl" x="${side === "L" ? 10 : 390}" y="${y(i) + 4}" text-anchor="${side === "L" ? "start" : "end"}">${u[0]}</text>`;
    }
    s += `<text class="rn" x="200" y="${y(i) + 4}" text-anchor="middle">${i + 1}</text>`;
  }
  return `<svg class="header-art" viewBox="0 0 400 300" role="img" aria-label="The screen board's sockets, face down, USB end up. White in the right row's 3rd, yellow right 5th, black left 6th, red left 7th. Never the right 4th.">
    <rect class="usb" x="170" y="6" width="60" height="22" rx="6"/><text class="usbt" x="200" y="21" text-anchor="middle">USB</text>
    <rect class="strip" x="132" y="38" width="36" height="252" rx="9"/><rect class="strip" x="232" y="38" width="36" height="252" rx="9"/>
    ${s}</svg>`;
})();

export const STEPS: Step[] = [
  { t: "Cable and tools",
    p: `A STEMMA QT / Qwiic cable (4-pin JST-SH plug, white, yellow, black, red), wire cutters and strippers, electrical tape, a stiff breadboard jumper wire, and tweezers.`,
    d: "01", ph: ["01-cable-and-strippers"] },
  { t: "Cut and strip the wires",
    p: `Keep one plug. Cut the wires about <b>2 in (5 cm)</b> from it. Strip off as much as a socket is deep, about <b>5 mm</b> (between 1/8 and 1/4 in), so the bare wire goes all the way down.`,
    d: "03", ph: ["03-cut-and-stripped-a", "03-cut-and-stripped-b"] },
  { t: "Lay out the screen board",
    p: `Turn the screen board face down, sockets up, USB mark at the top. Each wire pushes into a socket, no solder. Count sockets from the USB end:`,
    d: "04", ph: ["04-board-and-guide"], art: HEADER,
    warn: `Never put anything in the 4th socket on the right row. Your own cable? Its colors may differ: go by the wire's place in the plug (step 9), not its color.` },
  { t: "Push in white and yellow",
    p: `Twist the strands at each tip tight, so each acts like one solid wire. Push <b>white into the 3rd</b> and <b>yellow into the 5th</b> socket on the right row.`,
    d: "05", ph: ["05-white-yellow-in-header"] },
  { t: "Tape over the wires",
    p: `A small piece of electrical tape over those sockets, right on top of the wires, holds them in.`,
    d: "06", ph: ["06-tape-over-wires"] },
  { t: "Poke the holes open",
    p: `Push the stiff jumper wire through the tape into each covered socket. This opens the holes for the Pico's pins. The tape still holds the wires.`,
    d: "06t", ph: ["08-black-red-taped", "07-poke-holes-through-tape"] },
  { t: "Black and red, same way",
    p: `On the left row: <b>black into the 6th</b>, <b>red into the 7th</b>. Tape over them. Poke the holes open.`,
    d: "08", ph: ["08-black-red-guide", "08-black-red-in-header", "08-black-red-taped"] },
  { t: "Header ready",
    p: `All 4 wires in, taped, holes open. Ready for the Pico.`,
    d: "09h", ph: ["09-header-ready"] },
  { t: "How the plug fits the chip",
    p: `The plug goes into the Trust M chip board. Only 4 wires. Top to bottom: <b>white, yellow, black, red</b>.`,
    d: "02", ph: ["02-trust-m-plug"] },
  { t: "Plug in the chip",
    p: `Plug the cable into the Trust M. It only fits one way. Lay the Trust M face up on the back of the screen board, over the wires. The Pico goes on top of it next.`,
    d: "10p", ph: ["10-chip-laid-down", "10-chip-plugged", "10-chip-plugged-side", "10-ready-for-pico"] },
  { t: "Snap off extra board",
    p: `Some Picos have a little extra board left on the end, away from the USB port. Pinch it with pliers and snap it off. Otherwise it won't fit the case.`,
    d: "11p", ph: ["11-snap-off-tab", "11-picos-with-tabs"] },
  { t: "Cut off plastic guards",
    p: `We don't recommend a Pico 2 W: a hardware wallet shouldn't have WiFi. Got one anyway? Flip it over. It probably has 3 black plastic guards across the back. Cut off the middle one and one of the end ones with clippers. Keep the plastic along the pins.`,
    d: "11g", ph: ["11-guards", "11-guards-end", "11-guards-cut", "11-guards-cut-parts"],
    warn: `You have to. With the guards on, the Trust M can't wedge in.` },
  { t: "Stack the boards",
    p: `Push the Pico into the sockets, <b>USB port at the same end as the screen board's USB mark</b>, the Pico's chips and BOOTSEL button facing out. Push straight, all the way in, until it's flush. The Trust M ends up wedged between the two boards.`,
    d: "10", ph: ["11-pico-going-on", "10-stacked-top", "10-chip-wedged", "10-headers-flush", "11-stacked-usb"],
    warn: `No pin, wire or chip sticking out. If anything does, do it again: it won't fit the case.` },
  { t: "Test the boards",
    p: `Hold the Pico's <b>BOOTSEL</b> button (tweezers help) and plug in a USB data cable (USB-C or micro USB, whichever your Pico has). Always hold it: many Picos come with software on them and won't show up without it. Open <a href="/test">wedgie.dev/test</a> in Chrome and click <b>Test it</b>. Don't unplug while it runs. Wait for <b>Board, Firmware, Chip</b> to go green, then unplug. Shake, Buttons and Colors come after the case is on.`,
    d: "11", ph: ["11-bootsel", "11-test-page", "11-test-wiping", "11-test-firmware"],
    tip: `First time on this computer? The test page has a one-time setup so Chrome stops asking about every new Pico.`,
    warn: `Chip fails? A wire is in the wrong socket, a wire came out, or the Trust M touches a Pico pin. Take it apart and check.` },
  { t: "Pick the base",
    p: `The base color says what's inside: <b>red</b> is a Pico W with a battery, <b>black</b> is the Trust M chip, <b>gray</b> is the ATECC608. This build is Trust M, so black.`,
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
  { t: "Box it",
    p: `Put it in the box. Build the next one.`,
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
    </div>
    <ol class="asm-steps">
      ${STEPS.map((s, i) => `
      <li class="card asm-step" id="step-${i + 1}">
        <div class="asm-copy">
          <div class="asm-head"><span class="num">${i + 1}</span><h3>${s.t}</h3></div>
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
