// /batt: ours, for testing a wedgie's battery. Not linked from anywhere. It puts the battery firmware on
// (public/device/batt.py: never sleeps, burns all the power it can, logs the battery to its flash) the way
// /reset puts the wedgie firmware on: BOOTSEL, Find it, and /connect's set-up card (setup.ts, batt) wipes it,
// puts on MicroPython, then that one file as main.py. Read its log: the board's batt.csv comes back over the
// REPL (the battery firmware leaves it open) and each stretch on battery is drawn. /reset makes it a wedgie again.
import * as W from "../serial/wedgies";
import { usbSupported, bootDevices } from "../serial/picoboot";
import { setupCard } from "./setup";
import { download } from "../serial/files";
import { esc } from "../ui/device";
import "./batt.css";

type Row = { t: number; usb: boolean; mv: number; rest: number; temp: number; load: boolean };
/** One stretch on battery. ended: what stopped it. charged: seconds on USB just before it (same boot), or null. */
export type Run = { boot: number; rows: Row[]; ended: "usb" | "died" | "last"; charged: number | null };

/** batt.csv -> its stretches on battery, oldest first. */
export function runs(csv: string): Run[] {
  const out: Run[] = [];
  let boot = 0, cur: Run | null = null, usbFrom: number | null = null, lastT = 0;
  const end = (why: Run["ended"]) => { if (cur) { cur.ended = why; cur = null; } };
  for (const ln of csv.split(/\r?\n/)) {
    if (ln.startsWith("#boot")) { end("died"); boot = +ln.split(",")[1] || boot + 1; usbFrom = null; continue; }
    const p = ln.split(",").map(Number);
    if (p.length < 6 || p.some((x) => !Number.isFinite(x))) continue;
    const r: Row = { t: p[0], usb: !!p[1], mv: p[2], rest: p[3], temp: p[4], load: !!p[5] };
    lastT = r.t;
    if (r.usb) { end("usb"); usbFrom ??= r.t; continue; }
    if (!cur) { out.push(cur = { boot, rows: [], ended: "last", charged: usbFrom === null ? null : r.t - usbFrom }); usbFrom = null; }
    cur.rows.push(r);
  }
  void lastT;
  return out.filter((r) => r.rows.length);
}

const READ_PY = `for _n in ("batt.old.csv", "batt.csv"):
    try:
        _f = open(_n)
    except OSError:
        continue
    while True:
        _s = _f.read(512)
        if not _s:
            break
        print(_s, end="")
    _f.close()`;

const dur = (s: number) => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;

/** One run: mV under load (the line) and at rest (dots) against minutes. */
function chart(r: Run) {
  const W_ = 640, H = 240, L = 52, R = 26, T = 12, B = 30;
  const t0 = r.rows[0].t, span = Math.max(60, r.rows[r.rows.length - 1].t - t0);
  const all = r.rows.flatMap((x) => (x.rest ? [x.mv, x.rest] : [x.mv]));
  const lo = Math.floor((Math.min(...all) - 20) / 100) * 100, hi = Math.ceil((Math.max(...all) + 20) / 100) * 100;
  const x = (t: number) => L + (W_ - L - R) * (t - t0) / span, y = (mv: number) => T + (H - T - B) * (hi - mv) / (hi - lo);
  const step = hi - lo > 800 ? 200 : 100;
  let grid = "";
  for (let v = lo; v <= hi; v += step) grid += `<line class="g" x1="${L}" x2="${W_ - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const mins = span / 60, mstep = [1, 2, 5, 10, 15, 30, 60, 120, 240].find((m) => mins / m <= 8) || 480;
  for (let m = 0; m <= mins; m += mstep) grid += `<text class="ax" x="${x(t0 + m * 60)}" y="${H - 8}" text-anchor="middle">${m >= 60 && mstep >= 60 ? m / 60 + " h" : m + " min"}</text>`;
  const line = r.rows.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.mv).toFixed(1)}`).join(" ");
  const dots = r.rows.filter((p) => p.rest).map((p) => `<circle class="rest" cx="${x(p.t).toFixed(1)}" cy="${y(p.rest).toFixed(1)}" r="3"><title>${dur(p.t - t0)}: ${p.rest} mV at rest</title></circle>`).join("");
  return `<svg class="batt-chart" viewBox="0 0 ${W_} ${H}" role="img" aria-label="Battery mV over time">${grid}<path class="load" d="${line}"/>${dots}</svg>`;
}

export function runCard(r: Run, n: number) {
  const a = r.rows[0], z = r.rows[r.rows.length - 1], secs = z.t - a.t;
  const sags = r.rows.filter((p) => p.rest && p.load).map((p) => p.rest - p.mv);
  const sag = sags.length ? Math.round(sags.reduce((s, v) => s + v, 0) / sags.length) : null;
  const temp = Math.max(...r.rows.map((p) => p.temp));
  const loaded = r.rows.filter((p) => p.load).length / r.rows.length;
  const stat = (k: string, v: string) => `<div class="batt-stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`;
  return `<div class="card batt-run">
    <h3>Run ${n}: ${esc(dur(secs))}${r.ended === "died" ? " until it died" : r.ended === "usb" ? " until USB" : " so far"}</h3>
    <div class="batt-stats">
      ${stat("start", a.mv + " mV")}${stat("end", z.mv + " mV")}${stat("lowest", Math.min(...r.rows.map((p) => p.mv)) + " mV")}
      ${stat("sag under load", sag === null ? "not read" : sag + " mV")}${stat("hottest", temp + " °C")}
      ${stat("on USB before", r.charged === null ? "not known" : dur(r.charged))}
    </div>
    ${chart(r)}
    <p class="fine">Line: mV under load. Dots: mV with the load off for 0.3 s (once a minute).${loaded < 0.95 ? ` The load was on ${Math.round(loaded * 100)}% of the time.` : ""} Logged every 30 s, so the end can be up to 30 s later than shown.</p>
  </div>`;
}

export function batt(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page batt-page">
    <h1>Battery test</h1>
    <p class="test-safe">A special firmware for testing a wedgie's battery. It never sleeps and uses all the power it can.</p>
    <p class="fine">It replaces the wedgie firmware: no apps, no signing. The chip and its keys aren't touched. Back to normal: <a href="/reset">wedgie.dev/reset</a>.</p>
    <div class="boot-hint card">
      <div class="boot-hint-3d" id="b-3d"></div>
      <div><h3>Hold BOOTSEL, plug it in</h3>
      <p>1. Unplug it.</p>
      <p>2. Press the button through the hole in the back with a paperclip. Keep holding it.</p>
      <p>3. Plug in the USB cable. Let go once it's in. Its screen stays dark.</p></div>
    </div>
    <div class="test-actions" id="b-actions"></div>
    <div id="b-setup"></div>
    <div class="card batt-how">
      <h3>A test</h3>
      <p>1. Leave it on USB until it's full. On USB it can't read the battery.</p>
      <p>2. Unplug it. It shows the percent a wedgie would, the mV, the sag and the drop per minute, and logs them every 30 s.</p>
      <p>3. Let it run until it dies, or plug it back in. The green button turns the load off and on.</p>
      <p>4. Plug it in here and read its log.</p>
    </div>
    <div class="test-actions" id="b-read"></div>
    <div id="b-log"></div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  import("../ui/bootsel3d").then((m) => m.mountBootsel3D($("b-3d"), { install: true })).catch(() => {});
  if (!W.supported() || !usbSupported()) {
    $("b-actions").innerHTML = `<p class="fine">Can't see USB here. Open wedgie.dev/batt in Chrome or Edge on a computer.</p>`;
    return;
  }
  let card: ReturnType<typeof setupCard> | null = null;
  $("b-actions").innerHTML = `<button class="btn btn-green" id="b-find">Find it</button>
    <p class="fine">Chrome lists it as <b>RP2 Boot</b> or <b>RP2350 Boot</b>.</p>`;
  $("b-find").onclick = async () => {
    W.arm();                      // the tap: now the page may look at USB (it waits for the board after its wipe)
    W.start();
    card ??= setupCard($("b-setup"), { batt: true });
    if (!(await bootDevices().catch(() => [])).length) card.pickNew();
  };

  // Read its log. A board running the battery firmware answers as plain MicroPython with a batt.csv.
  $("b-read").innerHTML = `<button class="btn" id="b-get">Read its log</button><p class="fine" id="b-say"></p>`;
  const say = (s: string) => { $("b-say").textContent = s; };
  const has = (w: W.Wedgie) => w.state === "ready" && w.kind === "micropython" && (w.files || []).some((f) => f === "batt.csv" || f === "batt.old.csv");
  let csv = "";
  const show = () => {
    const rs = runs(csv);
    $("b-log").innerHTML = (rs.length ? rs.map((r, i) => runCard(r, i + 1)).reverse().join("") : `<p class="fine">No time on battery in its log yet. Unplug it for a while first.</p>`)
      + `<p><button class="btn btn-sm" id="b-csv">Save batt.csv</button></p>`;
    $("b-csv").onclick = () => download("batt.csv", csv, "text/csv");
  };
  $("b-get").onclick = async () => {
    try {
      W.arm(); W.start();
      say("Looking for it…");
      const found = async () => {
        for (let i = 0; i < 40; i++) {            // up to 10 s: a port just picked is still being asked who it is
          const w = W.wedgies().find(has);
          if (w) return w;
          if (i > 3 && !W.wedgies().some((x) => x.state === "identifying")) return null;
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      };
      let w = await found();
      if (!w) { await W.connectNew(); w = await found(); }
      if (!w) return say("No battery firmware answered. Install it above first.");
      say("Reading…");
      csv = await W.withRepl(w, async (r) => {
        await r.enter({ reset: false });
        try { return (await r.exec(READ_PY, 120000)).replace(/\r/g, ""); }
        finally { await r.leave({ reset: false }); }      // main.py again: it carries on
      });
      say(`${csv.split("\n").filter((l) => l && !l.startsWith("#")).length} lines.`);
      show();
    } catch (e: any) {
      if (e?.name !== "AbortError" && e?.name !== "NotFoundError") say(`Didn't read it: ${e?.message || e}`);
      else say("");
    }
  };
}
