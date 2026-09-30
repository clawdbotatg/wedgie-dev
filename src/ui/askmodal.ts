// While a wedgie waits for its person to say yes (install.ts letIn), the page says so: a 3D wedgie
// showing the question its real screen shows, the green A button pressing itself, and the words.
// The page can't answer for them (only a real press counts), so this is all it can do, and it must be
// impossible to miss: a yes that nobody knows to give looks like a hung install.
import { place3D } from "./place3d";
import type { Wedgie3D } from "./wedgie3d";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function wrap(s: string, n: number) {
  const out = [""];
  for (const w of s.split(/\s+/)) {
    if (out[out.length - 1] && out[out.length - 1].length + 1 + w.length > n) out.push("");
    out[out.length - 1] = (out[out.length - 1] + " " + w).trim();
  }
  return out;
}

/** The wedgie's own question screen (firmware/slot.py ask), drawn the same way. */
export function askScreen(job: string, checked = false) {
  const c = document.createElement("canvas");
  c.width = c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fefefe"; g.fillRect(0, 0, 240, 240);
  [["#22c452", 10], ["#a9aaab", 19], ["#e3312c", 28]].forEach(([col, y]) => { g.fillStyle = col as string; g.fillRect(0, y as number, 240, 5); });
  g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = "#1a1b1a";
  const title = job ? wrap(job + "?", 15).slice(0, 2) : ["LET THIS", "COMPUTER IN?"];
  g.font = "16px Silkscreen, monospace";
  title.forEach((s, i) => g.fillText(s, 120, 48 + i * 24));
  g.font = "9px Silkscreen, monospace";
  (checked ? ["Only those files change."] : ["The computer gets full", "access for this one job."]).concat(["", "Didn't ask for this? Y."])
    .forEach((s, i) => g.fillText(s, 120, 108 + i * 14));
  g.fillStyle = "#22c452"; g.fillRect(0, 184, 240, 26);
  g.fillStyle = "#e3312c"; g.fillRect(0, 214, 240, 26);
  g.fillStyle = "#fefefe"; g.font = "16px Silkscreen, monospace";
  g.fillText("A  yes", 120, 189); g.fillText("Y  no", 120, 219);
  return c;
}

/** Show it; returns close(). */
export function askModal(job: string, checked = false): () => void {
  const el = document.createElement("div");
  el.className = "panel-wrap";
  el.innerHTML = `<div class="card bt-ask ask-a" role="dialog" aria-live="assertive" aria-label="Press A on your wedgie">
    <h3>Press <span class="ask-key">A</span> on your wedgie</h3>
    <p>It's asking <b>${esc(job || "Let this computer in")}?</b> The green button says yes, the red one says no.</p>
    <div class="ask-3d"></div>
    <p class="fine">Only a press on the wedgie itself counts. No answer in a minute is a no.</p>
  </div>`;
  document.body.appendChild(el);
  let w: Wedgie3D | null = null, t = 0, closed = false;
  place3D(el.querySelector<HTMLElement>(".ask-3d")!, { interactive: false, eager: true, screen: askScreen(job, checked) }).then((x) => {
    w = x;
    if (closed) return w?.destroy();
    let down = false;
    t = window.setInterval(() => { down = !down; w?.keyVisual("A", down); }, 450);
  });
  return () => { closed = true; clearInterval(t); w?.destroy(); el.remove(); };
}
