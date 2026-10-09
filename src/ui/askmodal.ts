// While a wedgie waits for its person to say yes (install.ts letIn), the page says so: a 3D wedgie
// showing the question its real screen shows, the green A button pressing itself, and the words.
// The page can't answer for them (only a real press counts), so this is all it can do, and it must be
// impossible to miss: a yes that nobody knows to give looks like a hung install.
import { P } from "./palette";
import { place3D } from "./place3d";
import type { Wedgie3D } from "./wedgie3d";

function wrap(s: string, n: number) {
  const out = [""];
  for (const w of s.split(/\s+/)) {
    if (out[out.length - 1] && out[out.length - 1].length + 1 + w.length > n) out.push("");
    out[out.length - 1] = (out[out.length - 1] + " " + w).trim();
  }
  return out;
}

/** The wedgie's own question screen (firmware/slot.py ask), drawn the same way. */
export function askScreen(job: string, checked = false, version = "") {
  const c = document.createElement("canvas");
  c.width = c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = P.WHITE; g.fillRect(0, 0, 240, 240);
  [[P.GREEN, 10], [P.GREY, 19], [P.RED, 28]].forEach(([col, y]) => { g.fillStyle = col as string; g.fillRect(0, y as number, 240, 5); });
  g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = P.INK;
  if (checked) {                                  // the job, its version for an update, a small green check
    const [head, to = ""] = (job || "Install").split(" to ");
    const v = head.startsWith("Update") ? version || to || "?" : "";
    const t = wrap(head, 15).slice(0, 2), y = Math.max(64 + t.length * 24 + 12, 108);
    g.font = "16px Silkscreen, monospace";
    t.forEach((s, i) => g.fillText(s, 120, 64 + i * 24));
    const sc = v.length <= 8 ? 3 : 2, w = 8 * sc * v.length + (v ? 8 : 0), x = (240 - w - 16) / 2;
    g.textAlign = "left"; g.font = `${8 * sc}px Silkscreen, monospace`;
    if (v) g.fillText(v, x, y + 8 + (24 - 8 * sc) / 2);
    const cy = v ? y + 14 : y + 8;
    g.strokeStyle = P.GREEN_D; g.lineWidth = 3; g.lineCap = "square";
    g.beginPath(); g.moveTo(x + w + 1, cy + 6); g.lineTo(x + w + 5, cy + 10); g.lineTo(x + w + 15, cy + 1); g.stroke();
    g.textAlign = "center";
  } else {
    const title = job ? wrap(job + "?", 15).slice(0, 2) : ["LET THIS", "COMPUTER IN?"];
    g.font = "16px Silkscreen, monospace";
    title.forEach((s, i) => g.fillText(s, 120, 48 + i * 24));
    g.font = "9px Silkscreen, monospace";
    ["The computer gets full", "access for this one job.", "", "Didn't ask for this? Y."].forEach((s, i) => g.fillText(s, 120, 108 + i * 14));
  }
  g.fillStyle = P.GREEN; g.fillRect(0, 184, 240, 26);
  g.fillStyle = P.RED; g.fillRect(0, 214, 240, 26);
  g.fillStyle = P.WHITE; g.font = "16px Silkscreen, monospace";
  g.fillText("A  yes", 120, 189); g.fillText("Y  no", 120, 219);
  return c;
}

/** Show it; returns close(). */
export function askModal(job: string, checked = false, version = ""): () => void {
  const el = document.createElement("div");
  el.className = "panel-wrap";
  el.innerHTML = `<div class="card bt-ask ask-a" role="dialog" aria-live="assertive" aria-label="Press A on your wedgie">
    <h3>Press <span class="ask-key">A</span> on your wedgie</h3>
    <div class="ask-3d"></div>
  </div>`;
  document.body.appendChild(el);
  let w: Wedgie3D | null = null, t = 0, closed = false;
  place3D(el.querySelector<HTMLElement>(".ask-3d")!, { interactive: false, eager: true, screen: askScreen(job, checked, version) }).then((x) => {
    w = x;
    if (closed) return w?.destroy();
    let down = false;
    t = window.setInterval(() => { down = !down; w?.keyVisual("A", down); }, 450);
  });
  return () => { closed = true; clearInterval(t); w?.destroy(); el.remove(); };
}
