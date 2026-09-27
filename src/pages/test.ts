// /test: the assembly-line check. Plug a wedgie in and it runs chip, screen and buttons by itself;
// the screen needs a person's yes/no because the Pico can't see whether a panel is attached.
// Each unit is tested once per plug-in; the last result stays up until the next unit starts.
import * as W from "../serial/wedgies";
import type { Repl } from "../serial/repl";

type State = "waiting" | "running" | "pass" | "fail";
type Result = { pass: boolean; detail: string };

const KEYS = ["up", "down", "left", "right", "press", "A", "B", "X", "Y"];
const KEYS_TIMEOUT_S = 90;
const ICON: Record<State, string> = { waiting: "", running: "…", pass: "✓", fail: "✗" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function test(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Wedgie QA</h1>
    <div class="test-status">
      <div class="status-text" id="t-text">Plug in a wedgie</div>
      <div class="status-detail" id="t-detail">USB-C. The tests start by themselves.</div>
    </div>
    <div class="test-grid" id="t-grid"></div>
    <div class="test-ask" id="t-ask" hidden>
      <p>Did its screen flash <b>red, green, blue</b>, edge to edge?</p>
      <div class="row center"><button class="btn btn-green" data-ans="1">Yes</button><button class="btn" data-ans="0">No</button></div>
    </div>
    <div class="test-actions" id="t-actions"></div>
    <div class="test-id" id="t-id" hidden></div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const text = $("t-text"), detail = $("t-detail"), grid = $("t-grid"), ask = $("t-ask"), actions = $("t-actions"), idEl = $("t-id");

  const tests: { name: string; state: State; detail: string }[] = [
    { name: "Chip", state: "waiting", detail: "" },
    { name: "Screen", state: "waiting", detail: "" },
    { name: "Buttons", state: "waiting", detail: "" },
  ];
  const draw = () => {
    grid.innerHTML = tests.map((t) =>
      `<div class="test-card ${t.state}"><div class="test-icon">${ICON[t.state]}</div><div class="test-name">${t.name}</div><div class="test-detail">${esc(t.detail)}</div></div>`).join("");
  };
  const set = (i: number, state: State, d = "") => { tests[i].state = state; tests[i].detail = d; draw(); };
  const status = (t: string, d: string, tone: "" | "good" | "bad" = "") => {
    text.textContent = t; detail.textContent = d;
    main.querySelector(".test-status")!.className = `test-status ${tone}`;
  };

  let testing = false;
  const tested = new Set<number>();   // wedgie keys already run this plug-in

  async function run(w: W.Wedgie) {
    testing = true;
    tested.add(w.key);
    tests.forEach((_, i) => set(i, "waiting"));
    idEl.hidden = false;
    idEl.innerHTML = `<span class="mono">${esc(w.short || "??????")}</span> · ${esc(w.board || "unknown board")}`;
    status("Testing…", "Don't unplug it.");
    actions.innerHTML = "";
    let step = 0;
    try {
      await W.withRepl(w, async (r) => {
        try {
          await r.enter();
          await r.exec(await W.probe(), 10000);
          set(0, "running", "Looking for it");
          let res = await chip(r, w); set(0, res.pass ? "pass" : "fail", res.detail); step = 1;
          set(1, "running", "Look at its screen");
          res = await screen(r); set(1, res.pass ? "pass" : "fail", res.detail); step = 2;
          set(2, "running", "Press every button");
          res = await keys(r, (left) => set(2, "running", left.length ? `Left: ${left.join(" ")}` : "Done"));
          set(2, res.pass ? "pass" : "fail", res.detail); step = 3;
        } finally {
          ask.hidden = true;
          await r.leave();   // soft reset: its own firmware starts again
        }
      });
    } catch (e: any) {
      if (step < 3) set(step, "fail", e?.message || String(e));
    }
    const failed = tests.filter((t) => t.state !== "pass").map((t) => t.name);
    if (failed.length) status("FAIL", `${failed.join(", ")} failed`, "bad");
    else status("PASS", `${w.short} is good`, "good");
    actions.innerHTML = `<button class="btn" id="t-again">Test it again</button><p class="fine">Or unplug it and plug in the next one.</p>`;
    $("t-again").onclick = () => { if (!testing && w.state === "ready") run(w); };
    testing = false;
    pick();
  }

  async function chip(r: Repl, w: W.Wedgie): Promise<Result> {
    let c: any = null;
    r.onLine = (t, v) => { if (t === "chip") c = v; };
    await r.exec("chip()", 20000);
    if (!c) return { pass: false, detail: "No answer from the chip check" };
    // A Trust M acks its address even when the wiring is half right; only its UID proves it talks.
    const ok = (c.found || []).filter((f: any) => !f.error && (f.type !== "OPTIGA Trust M" || f.uid));
    if (ok.length) {
      w.chip = ok[0];
      return { pass: true, detail: ok.map((f: any) => f.type === "ATECC608" ? `ATECC608 ${f.serial.slice(-6)}` : "Trust M, ID read").join(", ") };
    }
    const tm = (c.found || []).find((f: any) => f.type === "OPTIGA Trust M");
    if (tm) return { pass: false, detail: "Trust M there but won't give its ID. Check the wires." };
    if (!c.lines.sda || !c.lines.scl) return { pass: false, detail: "No power on SDA/SCL. Check the wires." };
    return { pass: false, detail: "Lines have power but no chip answered. A wire is swapped." };
  }

  // Cycle red/green/blue on the device until the person answers.
  async function screen(r: Repl): Promise<Result> {
    await r.exec("screen()", 10000);
    let answer: boolean | null = null;
    ask.hidden = false;
    ask.querySelectorAll<HTMLButtonElement>("[data-ans]").forEach((b) => (b.onclick = () => (answer = b.dataset.ans === "1")));
    for (let i = 0; answer === null; i++) {
      await r.exec(`screen("${["red", "green", "blue"][i % 3]}")`, 5000);
      await new Promise((res) => setTimeout(res, 600));
    }
    ask.hidden = true;
    return answer ? { pass: true, detail: "Red, green, blue" } : { pass: false, detail: "Colors wrong. Reseat the hat." };
  }

  async function keys(r: Repl, onLeft: (left: string[]) => void): Promise<Result> {
    const seen = new Set<string>();
    let stuck: string[] = [];
    r.onLine = (t, v) => {
      if (t === "stuck") { stuck = v; if (stuck.length) r.interrupt(); }   // held from the start: no point waiting
      if (t === "key" && !v.down) { seen.add(v.key); onLeft(KEYS.filter((k) => !seen.has(k))); }
    };
    onLeft(KEYS);
    try { await r.exec(`keys(${KEYS_TIMEOUT_S})`, (KEYS_TIMEOUT_S + 10) * 1000); } catch {}   // Ctrl-C shows up as an error
    if (stuck.length) return { pass: false, detail: `Stuck down: ${stuck.join(" ")}` };
    const miss = KEYS.filter((k) => !seen.has(k));
    return miss.length ? { pass: false, detail: `Never pressed: ${miss.join(" ")}` } : { pass: true, detail: "All 9 work" };
  }

  // The next untested, identified wedgie, if nothing is running.
  function pick() {
    if (testing) return;
    const ws = W.wedgies();
    for (const k of [...tested]) if (!ws.some((w) => w.key === k)) tested.delete(k);
    const next = ws.find((w) => w.state === "ready" && !tested.has(w.key));
    if (next) return void run(next);
    const bad = ws.find((w) => w.state === "error" && !tested.has(w.key));
    if (bad) {
      tested.add(bad.key);
      tests.forEach((_, i) => set(i, "waiting"));
      status("FAIL", bad.error || "Can't talk to it", "bad");
      return;
    }
    if (ws.some((w) => w.state === "identifying")) status("Found one…", "Checking what it is.");
    drawAllow();
  }
  function drawAllow() {
    if (testing || actions.querySelector("#t-again")) return;
    actions.innerHTML = `<button class="btn btn-green" id="t-allow">Allow wedgie connection</button><p class="fine">Only needed once per computer.</p>`;
    $("t-allow").onclick = () => W.connectNew().catch(() => {});
  }

  draw();
  if (!W.supported()) {
    status("Can't see USB here", "Open wedgie.dev/test in Chrome or Edge on a computer.", "bad");
    return;
  }
  W.onChange(pick);
  W.start();
  pick();
}
