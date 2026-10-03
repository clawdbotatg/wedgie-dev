// wedgie.dev/debug: a report on a wedgie for when something broke. The wedgie asks "Debug and read
// logs?" on its own screen (a yes is full access, for this one job), the page runs /device/debug.py in
// its raw REPL (the same script `wedgie.py debug` runs), then starts its app again, locked. The report
// is the wedgie's answer plus this page's own serial log, to copy or download.
import * as W from "../serial/wedgies";
import { takeOver } from "../serial/install";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export function debug(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Debug a wedgie</h1>
    <p id="g-text">Plug in the wedgie. The report needs you to press A on it: that gives this computer full access, for this one report.</p>
    <div id="g-list"></div>
    <div class="test-actions" id="g-actions"></div>
    <pre class="recess" id="g-out" hidden></pre>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  let busy = false, report = "";

  function paint() {
    const ws = W.wedgies();
    $("g-list").innerHTML = ws.length ? ws.map((w) => `<p><button class="btn btn-green" data-k="${w.key}"${busy || w.state !== "ready" ? " disabled" : ""}>Debug ${esc(w.short || "…")}</button>
      <span class="fine">${esc(w.state === "ready" ? `${w.board || ""} · ${w.firmware || ""} · runs ${w.running || "nothing"}` : w.state === "error" ? w.error || "error" : w.state)}</span></p>`).join("")
      : `<p class="fine">No wedgie yet. <a href="/connect">Connect</a> one first if this browser hasn't.</p>`;
    $("g-list").querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.onclick = () => run(ws.find((w) => w.key === +b.dataset.k!)!));
  }

  async function run(w: W.Wedgie) {
    busy = true; paint();
    $("g-text").innerHTML = "<b>Press A on the wedgie.</b> It asks: Debug and read logs?";
    let got: any = null, err = "";
    try {
      const code = await fetch("/device/debug.py", { cache: "no-cache" }).then((r) => r.text());
      await W.withRepl(w, async (r) => {
        r.onLine = (t, v) => { if (t === "debug") got = v; };
        await takeOver(r, (s) => { if (s) $("g-text").innerHTML = `<b>${esc(s)}.</b> It asks: Debug and read logs?`; }, "Debug and read logs", "Debugging");
        $("g-text").textContent = "Reading it…";
        await r.exec(code, 30000);
        await r.leave({ reset: false });       // its app again; main.py locks it
      });
    } catch (e: any) { err = e?.message || String(e); }
    report = JSON.stringify({ at: new Date().toISOString(), wedgie: w.short, page: location.origin, browser: navigator.userAgent,
      error: err || undefined, report: got, hello: { board: w.board, firmware: w.firmware, running: w.running, chip: w.chip, proof: w.proof?.state },
      serial_log: w.log.slice(-8000) }, null, 1);
    $("g-text").innerHTML = err ? `<b class="bad">No report:</b> ${esc(err)}. The page's own log is below.` : "Done. It's locked again.";
    const out = $("g-out"); out.hidden = false; out.textContent = report;
    $("g-actions").innerHTML = `<button class="btn" id="g-copy">Copy</button> <button class="btn" id="g-dl">Download</button>`;
    $("g-copy").onclick = () => navigator.clipboard.writeText(report);
    $("g-dl").onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([report], { type: "application/json" }));
      a.download = `wedgie-${w.short}-debug.json`; a.click();
    };
    busy = false; paint();
  }

  W.onChange(paint);
  if (W.armed()) W.start();
  paint();
}
