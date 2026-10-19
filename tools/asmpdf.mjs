// The printed assembly manual: node tools/asmpdf.mjs  ->  public/assemble.pdf (linked from /assemble). 4 pages.
// Words, steps and drawings come from src/pages/assemble.ts, same as the web page: edit there.
// Print layout: tools/manual/manual.css. The cover and last page: below.
import { createServer } from "vite";
import { ROOT, css, qr as qrSvg, img as jpg, pdf } from "./manual/pdf.mjs";

const URL = "https://wedgie.dev/assemble";
const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { STEPS, TROUBLE, NO_3D } = await vite.ssrLoadModule("/src/pages/assemble.ts");
await vite.close();

const img = (f) => jpg("public/img/assemble/" + f);
const qr = await qrSvg(URL);
// links print as plain bold text: "wedgie.dev/test"
const plain = (h) => h.replace(/<a [^>]*>(.*?)<\/a>/g, "<b>$1</b>");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body>
<section class="cover">
  <div class="top">
    <div><div class="kick">wedgie.dev</div><h1>Put a wedgie together.</h1>
      <p class="lede">No soldering. ${STEPS.length} steps. Take your time on the wires (3 to 9); the rest just clicks.</p></div>
    <div class="qr">${qr}<p>Latest version, with photos:<br><span class="url">wedgie.dev/assemble</span><br>Every step in 3D:<br><a class="url" href="https://wedgie.dev/assemble/3d">wedgie.dev/assemble/3d</a></p></div>
  </div>
  <div class="need"><h2>You need</h2><ul>
    <li>RP2040 Pico with headers (USB-C or micro USB)</li><li>Screen board: Waveshare Pico-LCD-1.3</li><li>Chip board: Adafruit OPTIGA Trust M (4351)</li><li>STEMMA QT / Qwiic cable (4-pin JST-SH)</li>
    <li>Case: lid, base, joystick cap, 4 buttons</li><li>Wire cutters and strippers</li><li>Pliers</li><li>Electrical tape</li>
    <li>A stiff breadboard jumper wire</li><li>Tweezers</li><li>USB data cable that fits your Pico</li><li>A computer with Chrome</li>
  </ul></div>
</section>
<div class="steps">
${STEPS.map((s, i) => `<section class="step${s.art ? " wide" : ""}">
  <div class="draw"><img src="${img(s.d ? `d${s.d}.webp` : `p/${s.ph[0]}.webp`)}"></div>
  <div class="copy">
    <div class="head"><span class="num c${i % 3}">${i + 1}</span><h3>${s.t}</h3>${NO_3D.includes(s.t) ? "" : `<a class="in3d" href="https://wedgie.dev/assemble/3d#${i + 1}">3D</a>`}</div>
    <p>${plain(s.p)}</p>
    ${s.art ? `<div class="art">${s.art}</div>` : ""}
    ${s.tip ? `<p class="note">${plain(s.tip)}</p>` : ""}
    ${s.warn ? `<p class="note bad">${plain(s.warn)}</p>` : ""}
  </div>
</section>`).join("")}
<section class="trouble">
  <h2>If something's off</h2>
  <dl>${TROUBLE.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join("")}</dl>
</section>
</div></body></html>`;

await pdf(html, "public/assemble.pdf", "Put a wedgie together · latest version: wedgie.dev/assemble");
