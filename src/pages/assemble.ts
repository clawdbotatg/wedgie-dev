// /assemble: the whole build, one step per card, with the fiddly parts the front page skips
// (cutting, stripping, seating and taping the chip's wires). Each step has a photo slot.
import "./assemble.css";

type Step = { t: string; p: string; shot?: string; art?: string; tip?: string; warn?: string };

// The hat's header seen from the Pico side, USB end up: the top 8 holes of each row. The four
// the chip uses are lit; the 4th on the right (3V3_EN) is struck out.
const HEADER = (() => {
  const L = ["GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND"];
  const R = ["VBUS", "VSYS", "GND", "3V3_EN", "3V3", "VREF", "GP28", "AGND"];
  const use: Record<string, [string, string]> = { "L5": ["SDA", "wire 3"], "L6": ["SCL", "wire 4"], "R2": ["GND", "wire 1"], "R4": ["3.3 V", "wire 2"] };
  const y = (i: number) => 58 + i * 30;
  let s = "";
  for (let i = 0; i < 8; i++) {
    for (const [side, x, names] of [["L", 150, L], ["R", 250, R]] as const) {
      const u = use[side + i], no = side === "R" && i === 3;
      s += `<rect class="hole${u ? " lit" : ""}${no ? " no" : ""}" x="${x - 11}" y="${y(i) - 11}" width="22" height="22" rx="5"/>`;
      if (no) s += `<path class="x" d="M${x - 7} ${y(i) - 7}l14 14m0-14l-14 14"/>`;
      const tx = side === "L" ? x - 22 : x + 22, a = side === "L" ? "end" : "start";
      s += `<text class="pn${u ? " on" : ""}" x="${tx}" y="${y(i) + 4}" text-anchor="${a}">${names[i]}</text>`;
      if (u) s += `<text class="wl" x="${side === "L" ? 10 : 390}" y="${y(i) + 4}" text-anchor="${side === "L" ? "start" : "end"}">${u[0]}</text>`;
    }
    s += `<text class="rn" x="200" y="${y(i) + 4}" text-anchor="middle">${i + 1}</text>`;
  }
  return `<svg class="header-art" viewBox="0 0 400 300" role="img" aria-label="The hat's header from the Pico side, USB end up. SDA left 6th, SCL left 7th, GND right 3rd, 3.3 volts right 5th. Never the right 4th.">
    <rect class="usb" x="170" y="6" width="60" height="22" rx="6"/><text class="usbt" x="200" y="21" text-anchor="middle">USB</text>
    <rect class="strip" x="132" y="38" width="36" height="252" rx="9"/><rect class="strip" x="232" y="38" width="36" height="252" rx="9"/>
    ${s}</svg>`;
})();

const STEPS: Step[] = [
  { t: "Lay out the parts",
    p: `A Pico with headers, the Waveshare Pico-LCD-1.3 hat, the ATECC608 breakout, and a STEMMA QT / Qwiic cable with bare ends. For tools: small cutters or scissors, a wire stripper, a strip of tape, and one breadboard jumper pin.`,
    shot: "parts" },
  { t: "Cut the wires short",
    p: `The cable comes long. Keep the plug and cut all four wires <b>short and even</b>, just long enough to reach from the chip to the header when the chip lies flat between the boards. Long wires bunch up and push on the back of the screen.`,
    shot: "cut" },
  { t: "Strip the ends",
    p: `Strip a short piece of insulation off each wire, enough bare copper to go down into a header hole and no more. Twist each end tight so no stray strand can touch the next hole.`,
    shot: "strip", tip: `The wires are thin. Close the stripper gently so it takes the plastic, not the copper.` },
  { t: "Find the GND end of the plug",
    p: `The plug's four contacts run <b>GND, 3.3 V, SDA, SCL</b> from one end. Count from the GND end. <b>Trust the order, not the colors</b>: Adafruit uses black, red, blue, yellow, but other bags use other colors.`,
    shot: "plug" },
  { t: "Push the wires into the header",
    p: `Hold the hat screen down, joystick end at the top (that's where the Pico's USB will sit), and look at the empty header socket. Count holes down from the top:`,
    art: HEADER,
    tip: `Each wire shares its hole with a Pico pin: the wire goes in first, the pin goes in beside it, and the spring contact holds both.`,
    warn: `Never put anything in the 4th hole on the right. That's 3V3_EN: grounding it switches the 3.3 V supply off. And never use VBUS or VSYS, they're 5 V.` },
  { t: "Tape the wires down",
    p: `Once all four are in, lay a strip of tape across the header to hold them in place. Then pop a hole through the tape over each hole with a breadboard pin, so the Pico's pins can go straight through. The tape keeps the wires from pulling out while you do the rest.`,
    shot: "tape" },
  { t: "Plug the Pico in",
    p: `Press the Pico into the hat's header: <b>Pico parts toward the screen, the Pico's USB at the joystick end</b>. Push straight, never at an angle. Every pin goes in, none outside the socket. Then tug each wire lightly: none should come out.`,
    shot: "pico" },
  { t: "Wedge the chip in",
    p: `Slide the chip board flat into the gap between the Pico and the hat, wires lying flat, so nothing presses on the back of the screen and the chip touches no Pico pin. That's the wedgie.`,
    shot: "wedge" },
  { t: "Close the case",
    p: `Seat the Pico's USB connector into the base's port first, then lower the boards in; don't force them straight down. Put the joystick cap and the four button caps on, then press the lid on until the hidden catches click. To open it again, use the pry notch on one side.`,
    shot: "case" },
  { t: "Plug it in and test it",
    p: `Use a data USB-C cable (not a charge-only one). Press <b>Allow wedgie connection</b> at the top and pick it; it boots to the underwear. Open it on the Connect page and run <b>Test → Check the chip</b>, then the screen and button tests.`,
  },
];

const shot = (k: string) => `<figure class="shot" data-shot="${k}"><span>photo coming</span></figure>`;

export function assemble(main: HTMLElement) {
  main.innerHTML = `
  <section class="sec asm">
    <div class="sec-head">
      <span class="kicker">Assembly</span>
      <h2>Put a wedgie together.</h2>
      <p>No soldering. Ten steps, and the only fiddly one is the wires. Take your time on steps 2 to 6 and the rest just clicks.</p>
    </div>
    <ol class="asm-steps">
      ${STEPS.map((s, i) => `
      <li class="card asm-step${s.shot || s.art ? "" : " solo"}" id="step-${i + 1}">
        <div class="asm-copy">
          <div class="asm-head"><span class="num">${i + 1}</span><h3>${s.t}</h3></div>
          <p>${s.p}</p>
          ${s.art ? `<ul class="pins">
            <li><b>GND</b> right 3rd</li><li><b>3.3 V</b> right 5th</li><li><b>SDA</b> left 6th</li><li><b>SCL</b> left 7th</li></ul>` : ""}
          ${s.tip ? `<p class="note">${s.tip}</p>` : ""}
          ${s.warn ? `<p class="note bad">${s.warn}</p>` : ""}
          ${i === STEPS.length - 1 ? `<div class="row"><a class="btn btn-green" href="/connect">Go to Connect</a></div>` : ""}
        </div>
        ${s.art ? `<div class="asm-art recess">${s.art}</div>` : s.shot ? shot(s.shot) : ""}
      </li>`).join("")}
    </ol>

    <div class="card asm-trouble">
      <h3>If something's off</h3>
      <dl>
        <dt>It doesn't show up on USB</dt><dd>A charge-only cable, or the board is in BOOTSEL mode (it shows up as a drive instead).</dd>
        <dt>The screen stays black</dt><dd>The hat isn't fully seated. Press the Pico straight in until every pin is down.</dd>
        <dt>No chip found</dt><dd>Wires placed by color instead of plug order, a wire in the right 4th hole, or the chip board touching a Pico pin. If the chip's light is on but it isn't found, a data wire and the power wire are swapped: swap them.</dd>
        <dt>A wire keeps coming out</dt><dd>Twist the bare end tighter, push it all the way down, and tape before the Pico goes in.</dd>
      </dl>
    </div>
  </section>`;
}
