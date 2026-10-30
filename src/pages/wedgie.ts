// /connect/<ID>: one wedgie, one page, no tabs. The 3D wedgie shows its real screen (a shot every
// ~0.7 s) and pressing its buttons presses the real ones. Then Hardware (is the chip proven working),
// Firmware (the version, one Update button), Software (the one app it runs: tap another and it
// restarts into that), Saves (each game's, download / put back / delete), and a folded Developer
// section (screen and button tests, code, files, console).
// The page holds the wedgie's USB port while it's open, so nothing else (another tab, wedgie.py,
// mpremote) can talk to it meanwhile.
//
// USB and resets: nothing here soft-resets a wedgie, except the firmware update's final reboot. Wedgie
// firmware 0.1.1+ adds its WEDGIE USB drive at power-up, which disconnects and reconnects USB; after
// that reboot the wedgie comes back as a NEW port (a new W.Wedgie, same ID), and this page picks it up
// by its ID. Raw-REPL work (tests, code, installs) stops its app with Ctrl-C and starts it again by
// running main.py (Repl.leave({ reset: false })), which keeps the port. Picking another app ends with
// a soft reset (a fresh heap for it); 0.1.3+ keeps the port through that too.
import { esc, KEYS, type Screen } from "../ui/device";
import { place3D, idScreen as idCanvas, colorScreen, baseColor } from "../ui/place3d";
import type { Wedgie3D } from "../ui/wedgie3d";
import * as W from "../serial/wedgies";
import { pyStr, traceStart, traceEnd, type Repl } from "../serial/repl";
import { answerNet, answerTcp } from "../serial/net";
import { installCore, useApp, appVer, removeApp, takeOver, setAskHint, askHint, firmwareManifest, lastAsk, type Cart, type Manifest } from "../serial/install";
import * as FS from "../serial/files";
import { cartHtml } from "../ui/cart";
import { compare, githubHead, verLink, type Ver } from "../apps/version";
import { bootScreen } from "../ui/bootscreen";
import { askScreen } from "../ui/askmodal";
import { ASK_TEXT } from "../serial/install";
import * as F from "../ui/facts";
import { cmpVersion } from "../apps/appjson.mjs";
import { loadRepo, savedRepos, saveRepo, forgetRepo, withRepos, type Repo } from "../apps/repos";
import { bugReport, readLog } from "../ui/report";

const APP_SAMPLE = `# A wedgie app: draw with lcd, read the buttons, tick on a Timer so USB stays free.
# Every button is yours. "Make it its app" puts it on as the one app the wedgie boots into.
# Saves: import save; save.store("best", 12); save.load("best", 0)  (its own folder, kept across apps)
from machine import Timer
from lcd import LCD, Keys, color, WHITE, BLACK

lcd = LCD()
keys = Keys()
GREEN, RED, INK = color(34, 196, 82), color(227, 49, 44), color(26, 27, 26)
x, y, dx, dy = 40, 60, 3, 2
timer = None


def tick(_):
    global x, y, dx, dy
    for k in keys.pressed():
        if k == "A":
            dx, dy = -dx, -dy
    x += dx; y += dy
    if not 0 < x < 204: dx = -dx
    if not 0 < y < 204: dy = -dy
    lcd.fill(WHITE)
    lcd.center_text("my wedgie app", 8, INK)
    lcd.fill_rect(x, y, 36, 36, RED if keys.held("B") else GREEN)
    lcd.show()


def start():
    global timer
    timer = Timer(period=33, mode=Timer.PERIODIC, callback=tick)


def stop():
    if timer:
        timer.deinit()


start()
`;

const PROBE_SAMPLE = `# No wedgie firmware on this board yet, so the wedgie.dev probe is loaded first:
#   ident(big, small)   col(r, g, b)   _LCD()   KEYS (pin numbers)   Pin
# Install the firmware to get lcd, Keys and saves.
import time
ident("HI!", "from wedgie.dev")
time.sleep(2)
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
// apps with their own page on wedgie.dev: a button to it on the app's card once it's on the wedgie
const PAGES: Record<string, { href: string; label: string }> = { safe: { href: "/safe", label: "Manage Safes" } };
/** How long the last question took to show: the site's part, then the wedgie's (0.3.11+ reports it). */
const askTime = () => lastAsk ? ` <span class="fine">Question on its screen in ${lastAsk.wedgie != null ? `${lastAsk.site + lastAsk.wedgie} ms (site ${lastAsk.site}, wedgie ${lastAsk.wedgie})` : `${lastAsk.site} ms + the wedgie's part`}.</span>` : "";

export function wedgiePage(main: HTMLElement, id: string, go: (path: string) => void): () => void {
  main.innerHTML = `
  <section class="sec wd">
    <a class="back" href="/connect">‹ All wedgies</a>
    <div class="wd-col">
      <div class="wd-dev"><div class="wd-3d"></div>
        <div class="wd-tags"><span class="light" id="d-light"></span><a class="vtag" id="d-virtual" href="/virtual" target="_blank" hidden title="Not hardware: a virtual wedgie running in a wedgie.dev/virtual tab">virtual</a></div>
        <p class="fine wd-hint" id="d-hint"></p></div>
      <div class="wd-main">
        <div class="beta-warn"><b>Beta.</b> We're making it delightful, and it changes every day, often every few hours. Keep only small amounts on your wedgie for now.</div>
        <div class="wd-job card" id="d-job" hidden><p><b id="d-job-h"></b></p><div class="meter"><div class="meter-track"><div class="meter-fill"></div></div><span id="d-job-w"></span></div><div class="status recess" id="d-job-t" hidden></div></div>
        <div class="wd-missing card" id="d-missing" hidden></div>
        <div id="d-body">
          <div class="card wd-sec">
            <h3>Hardware</h3>
            <dl class="kv" id="d-hw"></dl>
            <div class="status recess" id="d-status" hidden></div>
          </div>
          <div class="card wd-sec wd-fw">
            <h3>Firmware</h3>
            <div id="d-fw"></div>
          </div>
          <div class="card wd-sec carts">
            <h3>Software</h3>
            <p class="fine" id="d-carts-note"></p>
            <div class="shelf" id="d-shelf"></div>
            <div class="row build"><a class="btn btn-sm" href="/code">Build</a><span class="fine">your own software for it.</span></div>
            <details class="repo-add" id="d-repo-box">
              <summary>Apps from a GitHub repo</summary>
              <p class="fine">Anyone can make apps for a wedgie (<a href="/code">how</a>). Add a repo here and its apps join the shelf, on this browser only.
                <b>Nobody has reviewed them:</b> an app can use everything on the wedgie, its chip too. Add repos you trust.</p>
              <form class="row" id="d-repo-form"><input id="d-repo" class="recess name" placeholder="owner/repo" autocomplete="off" spellcheck="false"><button class="btn btn-sm">Add</button></form>
              <p class="fine" id="d-repo-note"></p>
              <ul class="repo-list" id="d-repos"></ul>
            </details>
          </div>
          <div class="card wd-sec saves">
            <h3>Saves</h3>
            <p class="fine" id="d-saves-note"></p>
            <div id="d-saves"></div>
            <div class="row"><button class="btn btn-sm" data-sv="all">Download all</button><label class="btn btn-sm file-btn">Put saves back<input type="file" id="d-saves-in" accept=".json,application/json" hidden></label></div>
          </div>
          <details class="card wd-sec dev">
            <summary>Developer</summary>
            <div class="row"><button class="btn btn-sm" data-act="mirror">Show its screen here</button></div>
            <div class="row"><button class="btn btn-sm" data-act="screen">Test the screen</button><button class="btn btn-sm" data-act="keys">Test the buttons</button><button class="btn btn-sm" data-act="chip">Check the chip again</button></div>
            <div class="status recess" id="d-tstatus" hidden></div>
            <textarea class="recess editor" spellcheck="false"></textarea>
            <div class="row">
              <button class="btn btn-sm btn-red" data-act="stop">Stop</button>
              <button class="btn btn-sm" data-act="run">Run on it</button>
              <input id="d-appname" class="recess name" placeholder="app name" maxlength="12" value="My app">
              <button class="btn btn-sm" data-act="saveapp">Make it its app</button>
            </div>
            <pre class="recess out" id="d-out"></pre>
            <h4>Files <span class="fine" id="d-fs-free"></span></h4>
            <div class="row"><button class="btn btn-sm" data-fs="refresh">Show files</button><label class="btn btn-sm file-btn">Upload a file<input type="file" id="d-fs-in" hidden></label></div>
            <div class="fs recess" id="d-fs" hidden></div>
            <div class="fs-view" id="d-fs-view" hidden></div>
            <h4>Console</h4>
            <pre class="recess out log" id="d-log"></pre>
          </details>
          <div class="wd-report"><p class="crash-q">Something wrong?</p><button class="btn btn-lg" id="d-report">Send a bug report</button></div>
        </div>
      </div>
    </div>
  </section>`;
  const $ = <T extends Element = HTMLElement>(s: string) => main.querySelector(s) as T;
  $<HTMLAnchorElement>(".back").onclick = (e) => { e.preventDefault(); go("/connect"); };
  // The bug report reads its log over live USB while we hold the port; busy or not live: the page's side only.
  $<HTMLButtonElement>("#d-report").onclick = (e) => {
    e.preventDefault();
    const r = link;
    bugReport(w || undefined, r && liveFs() && !busy ? () => readLog((p) => FS.get(r, p, true)) : undefined);
  };
  let m: Manifest | undefined;
  firmwareManifest().then((x) => { m = x; paint(); loadRepos(); }).catch(() => {});
  // Repos this browser added: their apps join the shelf (view()), marked as not reviewed.
  let repos: Repo[] = [];
  const repoErr: Record<string, string> = {};
  const view = () => m && withRepos(m, repos);
  async function addRepo(spec: string, fresh = false) {
    if (!m) return;
    try {
      const r = await loadRepo(spec, m, fresh);
      repos = [...repos.filter((x) => x.repo.toLowerCase() !== r.repo.toLowerCase()), r];
      delete repoErr[spec];
      saveRepo(r.repo);
      return r;
    } catch (e: any) { repoErr[spec] = e?.message || String(e); throw e; }
    finally { paint(); }
  }
  function loadRepos() {
    const list = savedRepos();
    if (list.length) ($("#d-repo-box") as HTMLDetailsElement).open = true;
    for (const s of list) addRepo(s).catch(() => {});
  }
  function paintRepos() {
    const ul = $("#d-repos");
    const sig = JSON.stringify([repos.map((r) => [r.repo, r.sha, r.carts.length]), repoErr]);
    if (ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.innerHTML = repos.map((r) => `<li><a href="https://github.com/${esc(r.repo)}/tree/${esc(r.sha)}" target="_blank" rel="noopener">${esc(r.repo)}</a>
        <span class="fine">${r.carts.length} app${r.carts.length === 1 ? "" : "s"} · ${esc(r.sha.slice(0, 7))}</span>
        <button class="btn btn-sm" data-repo-re="${esc(r.repo)}">Reload</button><button class="btn btn-sm btn-red" data-repo-rm="${esc(r.repo)}">Remove</button></li>`).join("") +
      Object.entries(repoErr).map(([s, e]) => `<li class="bad"><b>${esc(s)}</b>: ${esc(e)} <button class="btn btn-sm btn-red" data-repo-rm="${esc(s)}">Remove</button></li>`).join("");
    ul.querySelectorAll<HTMLButtonElement>("[data-repo-rm]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.repoRm!.toLowerCase();
      forgetRepo(b.dataset.repoRm!);
      repos = repos.filter((r) => r.repo.toLowerCase() !== k);
      for (const s of Object.keys(repoErr)) if (s.toLowerCase() === k) delete repoErr[s];
      paint();
    }));
    ul.querySelectorAll<HTMLButtonElement>("[data-repo-re]").forEach((b) => (b.onclick = () => { addRepo(b.dataset.repoRe!, true).catch(() => {}); }));
  }
  $<HTMLFormElement>("#d-repo-form").onsubmit = async (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>("#d-repo"), note = $("#d-repo-note"), spec = inp.value.trim();
    if (!spec) return;
    note.textContent = `Reading ${spec}…`;
    try {
      const r = await addRepo(spec, true);
      inp.value = "";
      note.innerHTML = r ? `Added ${r.carts.map((c) => `<b>${esc(c.name)}</b>`).join(", ")}. Tap one on the shelf to put it on.` : "";
    } catch (err: any) { note.innerHTML = `<b class="bad">Couldn't add it:</b> ${esc(err?.message || err)}`; }
  };

  let w: W.Wedgie | null = null;   // the wedgie with this ID right now (a new object after each replug)
  let link: Repl | null = null;    // its open port, while we hold it
  let busy = "";                   // what raw-REPL work is under way ("" = none)
  let alive = true;
  let release: (() => void) | null = null;
  let stopFn: (() => void) | null = null;
  // Its USB drops for a few seconds whenever it restarts (an install, an update, on its own), and at page
  // open it takes a moment to be found. Till it's back (or the time runs out) the page shows a bar
  // ("Restarting" / "Looking for"), never "isn't plugged in".
  const BACK_MS = 30000, FIND_MS = 6000;
  let backBy = 0, backTimer = 0, wasHere = false, seenOnce = false;
  const expectBack = (ms = BACK_MS) => {
    backBy = Date.now() + ms;
    clearInterval(backTimer);
    backTimer = setInterval(() => { if (Date.now() > backBy) clearInterval(backTimer); paint(); }, 500) as unknown as number;
  };
  const wedgie = () => w?.kind === "wedgie";
  // its app's wedgie.json "net": the sites this page fetches for it (serial/net.ts), by the version it has
  const netOf = () => {
    const have = w?.carts?.find((c) => c.mod === w?.running), cs = view()?.carts.filter((c) => c.mod === w?.running) || [];
    return (cs.find((c) => have?.v && c.v === have.v) || cs[0])?.net;
  };
  let netUsed = "";                // the last site this page fetched for its app
  const carts = () => (w?.carts || []);
  const newCarts = () => !!w?.carts;                // firmware 0.1.4+: cartridges come and go

  // ---- the 3D wedgie: the real screen (mirrored), and its buttons press the real ones ---------------
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  let w3: Wedgie3D | null = null, shown: Screen = { kind: "off" }, live = false;
  const tex = (s: Screen): HTMLCanvasElement | string => {
    switch (s.kind) {
      case "live": return canvas;
      case "id": return idCanvas(s.id, s.sub);
      case "color": return colorScreen(s.css);
      case "ask": return askScreen(s.job, true, "", s.ver);           // what the wedgie asks, as it asks it
      case "loading": return bootScreen(s.title || "Installing", s.what || "", s.p, s.sub);   // the wedgie's own boot bar
      case "text": return idCanvas(s.text);
      default: return colorScreen("#101012");
    }
  };
  const setScreen = (s: Screen) => { shown = s; live = s.kind === "live"; w3?.setScreen(tex(s)); };
  const idScreen = (): Screen => ({ kind: "id", id, sub: w?.board || "" });
  // Its app runs on its own: the page shows its ID, not its screen. Mirroring the real screen (a shot
  // every ~0.7 s, each ties the wedgie up a moment) and pressing its buttons from here are opt-in, in
  // Developer. A wallet shouldn't feel driven by the computer it's plugged into.
  let mirrorOn = false;
  const home = (): Screen => (mirrorOn && wedgie() ? { kind: "live" } : idScreen());
  setScreen(idScreen());
  place3D($(".wd-3d"), {
    screen: tex(shown),
    onKey: (k, down) => { if (down && mirrorOn && wedgie() && link && !busy) link.request({ type: "press", key: k }).catch(() => {}); },
  }).then((x) => { w3 = x; x?.setScreen(tex(shown)); x?.setColor("base", baseColor(w?.chip?.type)); });

  const cx = canvas.getContext("2d")!, img = cx.createImageData(240, 240);
  async function mirror() {
    while (alive) {
      if (link && wedgie() && live && !busy && !document.hidden) {
        try {
          const s = await link.request({ type: "shot" }, 4000);
          if (s.type === "error") {             // 0.3.54+ locked: its screen never leaves it without a yes
            mirrorOn = false; setScreen(home()); paint();
            $("#d-hint").textContent = "Locked: its screen stays on the wedgie. Give this computer full control to see it here.";
            throw 0;                            // (the catch below; the loop still sleeps)
          }
          const raw = atob(s.data);
          for (let i = 0, j = 0; i < raw.length; i += 2, j += 4) {
            const v = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
            img.data[j] = ((v >> 11) & 31) * 255 / 31; img.data[j + 1] = ((v >> 5) & 63) * 255 / 63; img.data[j + 2] = (v & 31) * 255 / 31; img.data[j + 3] = 255;
          }
          cx.putImageData(img, 0, 0);
        } catch {}
      }
      await sleep(700);
    }
  }

  // ---- finding it, and holding its port -------------------------------------------------------------
  function attach() {
    // An install has it: a checked install's yes restarts it, the port may drop, and the install finds it
    // again by its ID and goes on (install.ts job()). Holding its new port here would stall that.
    if (busy) { paint(); return; }
    const found = W.wedgies().find((x) => x.short === id && x.state !== "gone") || null;
    if (found !== w) {
      release?.(); release = null; link = null; w = found;
      if (w?.state === "ready") open(w);
    } else if (w && w.state === "ready" && !link && !release) open(w);
    paint();
  }
  function open(x: W.Wedgie) {
    let done!: () => void;
    const held = new Promise<void>((r) => (done = r));
    release = () => done();
    W.withRepl(x, async (r) => {
      if (x !== w) return;
      link = r;
      r.onJson = (v) => {
        const seen = (what: string) => { netUsed = what; paint(); };
        if (v?.type === "net") answerNet(r, v, netOf(), seen);
        else if (v?.type === "tcp") answerTcp(r, v, netOf(), seen);
      };
      // 0.3.69+: we carry its net now; what its app asked before we had it goes out again (net.ready)
      if (x.kind === "wedgie" && x.version && cmpVersion(x.version, "0.3.69") >= 0) r.write('{"type":"net"}\n').catch(() => {});
      setScreen(home());
      paint();
      if (liveFs()) loadSaves();
      if (x.proofLater) W.reprove(x, r).then(paint);   // its app had the chip busy when found: now, while we carry its net
      await held;
    }).catch((e) => { status(`<b class="bad">Can't open it:</b> ${esc(e?.message || e)}`); })
      .finally(() => { if (x === w) { link = null; } });
  }

  // ---- painting --------------------------------------------------------------------------------------
  const status = (s: string, at = "#d-status") => {
    if (at === "#d-status") { const t = $("#d-job-t"); t.hidden = !s; t.innerHTML = s; }   // a job hides the body: its card says it
    const el = $(at); if (!el) return; el.hidden = !s; el.innerHTML = s; if (/Question on its screen/.test(s)) el.dataset.ask = el.textContent || "";   // data-ask: for the probes
  };
  const tstatus = (s: string) => status(s, "#d-tstatus");   // the Developer section's own line (tests, Run, Save)
  setAskHint((s) => status(s && `<b>${esc(s)}.</b> It asks on its screen.`));
  // One bar per job (an install, an update, an uninstall), start to finish: the install fills it to 70%, the
  // restart after it runs on toward 97%, and it fills green once the wedgie is back for good. The drops in
  // between (a checked install's yes restarts it; its USB blinks again ~1 s after power-up) never start it over.
  const INSTALL_PART = 0.7, SETTLE_MS = 2000;
  let job = "", jobAt = 0, jobRestarting = false, jobBack = 0, jobTimer = 0;
  const jobTo = (p: number, ms = 250, ease = "linear") => {
    if (p <= jobAt) return;
    jobAt = p;
    const f = $<HTMLElement>("#d-job .meter-fill");
    f.style.transition = `width ${ms}ms ${ease}`; f.style.width = `${8 + 92 * p}%`;
  };
  const jobStart = (title: string) => {
    job = title; jobAt = 0; jobRestarting = false; jobBack = 0;
    const f = $<HTMLElement>("#d-job .meter-fill"); f.style.transition = "none"; f.style.width = "8%";
    $("#d-job .meter").classList.remove("done"); $("#d-job-h").textContent = title; $("#d-job-w").textContent = ""; status("");
    paint();
    // the question, the restart into the install and the signature check say no progress: creep meanwhile
    setTimeout(() => { if (job === title) jobTo(0.3, 30000, "cubic-bezier(.2,.7,.4,1)"); }, 50);
  };
  const meter = (p: number, what = "") => { jobTo(INSTALL_PART * p); $("#d-job-w").textContent = what; };
  const jobRestart = () => {       // the install is done; the wedgie restarts. The bar slows as it nears the end.
    jobRestarting = true; jobBack = 0;
    jobTo(0.97, BACK_MS, "cubic-bezier(.25,.7,.45,1)");
    clearInterval(jobTimer); jobTimer = setInterval(paint, 400) as unknown as number;
  };
  const jobEnd = () => { job = ""; jobRestarting = false; clearInterval(jobTimer); paint(); };
  function paintJob(here: boolean, coming: boolean) {
    if (!job || !jobRestarting || jobBack < 0) return;
    if (!here) { jobBack = 0; if (!coming) { status(""); jobEnd(); } return; }   // past the time: the missing card says so
    if (!jobBack) jobBack = Date.now();
    if (Date.now() - jobBack < SETTLE_MS) return;     // back, but it may blink once more
    jobBack = -1;
    $("#d-job .meter").classList.add("done"); jobTo(1, 400);
    $("#d-job-w").textContent = "Back.";
    const t = job;
    setTimeout(() => { if (job === t && jobBack < 0) { status(""); jobEnd(); } }, 1500);
  }
  function paint() {
    if (!alive) return;                 // left the page while something was still finishing
    const there = !!w && w.state !== "gone";
    if (there && w!.state !== "identifying") { backBy = 0; clearInterval(backTimer); wasHere = seenOnce = true; }
    else if (!there && wasHere) { wasHere = false; expectBack(); }      // it dropped: give it time to come back
    const coming = backBy > Date.now(), late = !!backBy && !coming && seenOnce;
    const here = there && !coming;
    paintJob(here, coming);
    $("#d-job").hidden = !job;
    $("#d-missing").hidden = !!job || (here && w!.state !== "error");
    $("#d-body").hidden = !!job || !here || w!.state === "error";
    if (job && !here) { $("#d-light").className = "light wait"; $("#d-hint").textContent = ""; return; }
    if (!here || w!.state === "error") {
      const html = coming ? `<p><b>${seenOnce ? "Restarting" : "Looking for"} ${esc(id)}</b></p><div class="meter back-meter" style="--back:${backBy - Date.now()}ms"><div class="meter-track"><div class="meter-fill"></div></div></div>`
        : w?.state === "error" ? `<p class="bad">${esc(w.error || "Can't talk to it.")}</p>`
        : `<p><b>${esc(id)} ${late ? "didn't come back" : "isn't plugged in"}.</b> ${late ? "Unplug it and plug it back in." : "Plug it in and it shows up here by itself."} ${busy ? "" : `<a href="/connect" data-back>See all wedgies</a>`}</p>`;
      const box = $("#d-missing");
      const k = coming ? `back ${backBy} ${seenOnce}` : html;   // the bar's fill runs on its own; don't restart it every frame
      if (box.dataset.k !== k) {
        box.dataset.k = k;
        box.innerHTML = html;
        box.querySelector<HTMLElement>("[data-back]")?.addEventListener("click", (e) => { e.preventDefault(); go("/connect"); });
      }
      $("#d-light").className = "light wait";
      $("#d-hint").textContent = "";
      return;
    }
    const x = w!;
    w3?.setColor("base", baseColor(x.chip?.type));
    $("#d-light").className = `light ${F.overall(x, m)}`;
    $("#d-virtual").hidden = !x.virtual;
    $("#d-hint").textContent = mirrorOn && wedgie() && link ? "Its real screen. Click its buttons (or press arrows, Enter, A, B, X, Y) to press the real ones."
      : netUsed && link ? `Its app gets the internet through this tab (${netUsed}). Keep it open.` : "";
    const mb = $<HTMLButtonElement>('[data-act="mirror"]');
    if (mb) mb.textContent = mirrorOn ? "Stop showing its screen" : "Show its screen here";
    paintHw(x); paintFw(x); paintCarts(x); paintSaves();
    main.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.disabled = !link || (!!busy && b.dataset.act !== "stop") || (b.dataset.act === "chip" && !newCarts())));
  }

  function paintHw(x: W.Wedgie) {
    const p = x.proof;
    const chip = !p ? (x.chip?.type ? esc(x.chip.type) : "not checked")
      : p.state === "checking" ? "checking…"
      : p.state === "done" ? `${p.pass ? `<b class="good">✓ ${esc(F.chipName(x))} working</b>` : `<b class="bad">✗ ${esc(F.chipName(x) || "No chip")}</b>`}<br><span class="fine">${esc(p.detail)}</span>`
      : `${x.chip?.type ? esc(x.chip.type) + "<br>" : ""}<span class="fine">${esc(p.detail)}</span>`;
    const facts = p?.state === "done" && p.facts.length ? `<details class="fine"><summary>How we know</summary>${p.facts.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}</details>` : "";
    const rows = [
      ["Board", `${esc(x.board || "?")} <span class="fine">${esc(x.cpu || "")}</span>`],
      ["Chip", chip + facts],
      ["Board ID", `<span class="mono">${esc(x.uid || "?")}</span>`],
      ...(x.free != null ? [["Room", `${kb(x.free)} free`]] : []),
      ...(x.ram != null ? [["Memory", `${kb(x.ram)} free`]] : []),
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const hw = $("#d-hw");
    if (hw.dataset.html !== rows) { hw.dataset.html = rows; hw.innerHTML = rows; }   // a repaint must not snap "How we know" shut
  }

  // The last update's failure, drawn in the firmware box itself: the status line got wiped when the wedgie came back
  // and the page showed a plain Update button, as if nothing had happened (10-27).
  let fwErr = "";
  function paintFw(x: W.Wedgie) {
    const box = $("#d-fw");
    if (!m) { box.innerHTML = ""; return; }
    const cur = x.kind === "wedgie" ? x.version : null, fresh = !!cur && (cmpVersion(cur, m.version) >= 0
      || (!m.signed && cmpVersion(cur, "0.3.12") >= 0));   // newer (a test build) is never "updated" back; an unsigned release isn't offered to one that only takes signed
    const what = x.kind === "wallet" ? "The Wallet is running, so its firmware version isn't known here. Update puts on the latest; the Wallet stays."
      : fresh ? "Up to date." : cur ? `wedgie ${esc(m.version)} is ready.` : `This board has MicroPython but no wedgie firmware yet.`;
    // Behind (or none): the update is all the page shows, one big button. Apps can't go on till then (0.3.66+
    // takes the app list on its own; older firmware sees no apps in today's signed list: install.ts APP_LIST).
    const need = !fresh && (x.kind === "wedgie" || x.kind === "micropython");
    main.querySelector(".wd")!.classList.toggle("need-fw", need);
    const sig = `${cur}|${m.version}|${x.kind}|${!!link}|${!!busy}|${fwErr}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = `<div class="fwrow"><div><h4>${cur ? `wedgie ${esc(cur)}` : x.kind === "wallet" ? "wedgie" : "No wedgie firmware"}</h4><p>${what}</p></div>` +
      `<div class="fwbtns"><button class="btn ${need ? "btn-lg btn-pulse" : "btn-sm"} ${fresh ? "" : "btn-green"}" data-fw ${!link || busy ? "disabled" : ""}>${fresh ? "Reinstall" : cur || x.kind === "wallet" ? "Update" : "Install"}</button>` +
      (fresh ? "" : `<button class="btn btn-xs fwask" data-fwask>Let your agent check it first</button>`) + `</div></div>` +
      (fresh ? "" : `<p class="fine">Takes a minute. Its app and its saves stay on it.</p>`) +
      (fwErr && !fresh ? `<p class="fwerr"><b class="bad">The update failed:</b> ${esc(fwErr)}. Its app is back. It's safe to try again.</p>` : "");
    box.querySelector<HTMLButtonElement>("[data-fw]")?.addEventListener("click", updateFw);
    const ask = box.querySelector<HTMLButtonElement>("[data-fwask]");
    if (ask) ask.onclick = () => navigator.clipboard.writeText(agentCheck(m!, cur)).then(
      () => { ask.textContent = "Copied. Paste it to your agent."; setTimeout(() => (ask.textContent = "Let your agent check it first"), 4000); },
      () => { ask.textContent = "Couldn't copy. Try again."; });
  }

  /** What the grey button copies: an agent reads the whole firmware for the five ways it could hurt you,
   *  then checks the files the page would install are that same code (hashes, the signed list, the keys). */
  function agentCheck(m: Manifest, cur: string | null | undefined) {
    const site = location.origin, gh = "https://github.com/clawdbotatg/wedgie-dev";
    return `Please check this wedgie firmware before I install it.

I'm on ${location.href}. It offers wedgie firmware ${m.version}${cur ? ` (mine is ${cur})` : ""}.
The wedgie is a small open source signing device. What it is and how it's kept safe: https://wedgie.dev/skill.md and https://wedgie.dev/security.md

First: if ${site} is not https://wedgie.dev, stop and tell me.

1. Read all of the firmware, not just what changed: every .py in the firmware/ folder of ${gh} (MIT), at the commit that sets VERSION in firmware/wedgie.py to ${m.version}. Answer each:
   - Can it leak keys or secrets off the wedgie?
   - Can it sign or install anything without a real press of the green button?
   - Can the computer control it without asking?
   - Can it reach the internet on its own?
   - Are there hidden commands, or ways to run code it was sent?
   Point to the file and line for anything you find.

2. Check that what you read is what goes on the device:
   - ${site}/fw/manifest.json lists every file with its sha256 ("core" = the firmware). Fetch each from ${site}/fw/<name> and check the hashes.
   - Each one matches the repo. .mpy files rebuild from the .py next to them: uv run --with mpy-cross==1.29.0.post2 python3 tools/mpy.py --check
   - ${site}/fw/release.sig signs ${site}/fw/release.txt with one of RELEASE_KEYS (firmware/wedgie.py), and release.txt lists the same hashes. Say if this version is signed yet.

Not covered: apps and MicroPython itself.

3. Tell me in plain words: safe to update, or not, and why.

4. Then ask me: "Want me to check Safe Signer too?" If yes, do the same review on it:
   - Source: https://github.com/clawdbotatg/wedgie-safe (all safe_*.py and safe.py), at the commit pinned for clawdbotatg/wedgie-safe in community.json in ${gh}.
   - What goes on the device: the "Safe Signer" @app line in ${site}/fw/apps.txt lists each file's sha256; fetch them from ${site}/fw/<name> and check. release.txt signs apps.txt by its hash (@apps).
   Other apps work the same way: each is a clawdbotatg/wedgie-<name> repo, pinned in community.json.`;
  }

  // ---- software: the one app it runs ------------------------------------------------------------------
  const inserting: Record<string, number> = {};   // mod -> progress while it goes on
  const heads: Record<string, Ver | null> = {};   // shelf repo -> GitHub's newest commit (null: not known)
  let confirmChip = "";                            // an app for another chip, tapped once
  // The chip this wedgie has, once known ("ATECC608", "OPTIGA Trust M", "none"); null: not checked yet.
  const chipType = () => (w?.chip?.type as string | undefined) || null;
  const chipLabel = (t: string | null) => (t === "OPTIGA Trust M" ? "a Trust M" : t === "none" || !t ? "no chip" : `an ${t}`);
  /** Why this app won't work here ("" if it will, or the chip isn't known yet). */
  const wrongChip = (c: Cart) => (c.chip && chipType() && chipType() !== c.chip ? `${c.name} needs an ${c.chip} chip. This wedgie has ${chipLabel(chipType())}.` : "");
  const oldFw = (c: Cart) => (c.fw && w?.version && cmpVersion(w.version, c.fw) < 0 ? `${c.name} needs wedgie ${c.fw} or newer. Update the firmware above first.` : "");
  const active = () => (w?.carts || [])[0]?.mod || null;
  const slot = () => !!w?.slot;                    // 0.2+: one app, no menu
  const canPick = () => slot() || w?.kind === "wallet";   // the Wallet as its app: it stops on Ctrl-C
  function paintCarts(x: W.Wedgie) {
    const m = view();
    if (!m) return;
    paintRepos();
    const note = $("#d-carts-note");
    const a = m.carts.find((c) => c.mod === active());
    if (x.kind === "micropython") note.innerHTML = "Apps run on wedgie firmware. Install it above first.";
    else if (x.kind === "wedgie" && !slot()) note.innerHTML = "Update the firmware above first. From 0.2 a wedgie runs one app: it boots straight into it, and the app gets every button.";
    else note.innerHTML = a ? `It runs <b>${esc(a.name)}</b>. Tap another to switch. Saves stay.` : "Nothing on it yet. Tap one: it goes on and the wedgie restarts into it.";
    const shelf = $("#d-shelf");
    const mods = new Set(m.carts.map((c) => c.mod));
    shelf.querySelectorAll<HTMLElement>(".cart-slot").forEach((el) => { if (!mods.has(el.dataset.mod!)) el.remove(); });
    m.carts.forEach((c, i) => {
      let slotEl = shelf.querySelector<HTMLElement>(`.cart-slot[data-mod="${c.mod}"]`);
      if (slotEl && slotEl.dataset.v !== c.v) { slotEl.remove(); slotEl = null; }   // a reloaded repo: a new cart
      if (!slotEl) {
        slotEl = document.createElement("div");
        slotEl.dataset.v = c.v;
        slotEl.className = "cart-slot";
        slotEl.dataset.mod = c.mod;
        slotEl.innerHTML = `<button class="cart" title="${esc(c.about || "")}">${cartHtml(c)}</button><p class="cart-about">${esc(c.about || "")}</p>${c.repo ? `<p class="cart-from${c.unreviewed ? " unreviewed" : ""}">${c.unreviewed ? "not reviewed · " : "by "}<a href="https://github.com/${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.repo)}</a>${c.sha && /^[0-9a-f]{40}$/.test(c.sha) ? ` · ${verLink(c.repo, { sha: c.sha, at: c.at, version: c.version }, esc)}` : ""}</p>` : ""}<p class="cart-needs" hidden></p><p class="cart-ver" hidden></p><div class="cart-acts">${PAGES[c.mod] ? `<a class="btn btn-xs btn-green" data-cart="page" href="${PAGES[c.mod].href}" hidden>${esc(PAGES[c.mod].label)}</a>` : ""}<button class="btn btn-xs btn-green" data-cart="update" hidden>Update</button><button class="btn btn-xs btn-red" data-cart="uninstall" hidden>Uninstall</button></div>`;
        // A tap on the cart puts it on (or updates it). The app on it comes off only by its Uninstall button.
        slotEl.querySelector<HTMLButtonElement>(".cart")!.onclick = () => (active() === c.mod && (w?.carts || [])[0]?.v === c.v ? undefined : pick(c));
        slotEl.querySelector<HTMLButtonElement>('[data-cart="update"]')!.onclick = () => pick(c);
        slotEl.querySelector<HTMLButtonElement>('[data-cart="uninstall"]')!.onclick = () => eject();
      }
      if (shelf.children[i] !== slotEl) shelf.insertBefore(slotEl, shelf.children[i] || null);
      const on = active() === c.mod;
      const cmp = on ? compare(m, c, (x.carts || [])[0]?.v) : null;
      const outdated = !!cmp && cmp.is !== "same";
      const older = cmp?.is === "older";
      const playing = on && x.running === c.mod;
      const p = inserting[c.mod];
      const btn = slotEl.querySelector<HTMLButtonElement>(".cart")!;
      btn.classList.toggle("playing", on);
      btn.classList.toggle("absent", !on);
      btn.classList.toggle("busy", p !== undefined);
      btn.disabled = !link || !!busy || !canPick() || (on && !outdated && !slot());
      const off = !link || !!busy || !canPick();
      const upd = slotEl.querySelector<HTMLButtonElement>('[data-cart="update"]')!, rm = slotEl.querySelector<HTMLButtonElement>('[data-cart="uninstall"]')!;
      upd.hidden = !outdated || p !== undefined; upd.disabled = off;
      upd.textContent = older ? "Update" : "Replace";        // never "Update" to an older or unknown version
      rm.hidden = !on || !slot() || p !== undefined; rm.disabled = off;
      const pg = slotEl.querySelector<HTMLElement>('[data-cart="page"]');
      if (pg) pg.hidden = !on || outdated || p !== undefined;
      btn.style.setProperty("--p", String(p ?? 0));
      const st = slotEl.querySelector(".cart-state")!;
      st.innerHTML = p !== undefined ? "installing" : older ? "update" : outdated ? "other version" : playing ? "▶ running" : on ? "on it" : kb(c.size);
      // Which version: the one on the wedgie when it isn't this one, and GitHub's newest when wedgie.dev is behind it.
      if (c.repo && !c.unreviewed && !(c.repo in heads)) { heads[c.repo] = null; githubHead(c.repo).then((h) => { heads[c.repo!] = h; paint(); }); }
      const head = c.repo ? heads[c.repo] : null, repo = c.repo || "";
      const lines = [
        older ? `This wedgie has ${verLink(repo, cmp!.has!, esc)}. Update puts on the newer one above.`
          : cmp?.is === "newer" ? `This wedgie has ${verLink(repo, cmp.has!, esc)}, newer than wedgie.dev's.`
          : outdated ? "This wedgie has a version that isn't on wedgie.dev (put on from GitHub, /code or wedgie.py). Replace puts on wedgie.dev's." : "",
        head && c.sha && head.sha !== c.sha && c.at && head.at && head.at > c.at ? `GitHub has a newer commit, ${verLink(repo, head, esc)}, not on wedgie.dev yet.` : "",
      ].filter(Boolean).map((l) => `<span>${l}</span>`).join(" ");
      const ver = slotEl.querySelector<HTMLElement>(".cart-ver")!;
      if (ver.dataset.html !== lines) { ver.dataset.html = lines; ver.innerHTML = lines; ver.hidden = !lines; }
      st.className = `cart-state${on && !outdated ? " on" : outdated || !on ? " soft" : ""}`;
      const why = wrongChip(c) || oldFw(c);
      slotEl.classList.toggle("nochip", !!why);
      const needs = slotEl.querySelector<HTMLElement>(".cart-needs")!;
      needs.hidden = !why;
      needs.innerHTML = why ? (confirmChip === c.mod ? `<b>${esc(why)}</b> Tap it again to put it on anyway.` : esc(why)) : "";
    });
  }

  // Tap one: it goes on (the old app's files come off, saves stay) and the wedgie restarts into it.
  async function pick(c: Cart) {
    if (!link || busy || !w) return;
    const x = w, r = link;
    // An app for another chip: the first tap says so; a second puts it on anyway (it's their wedgie).
    if ((wrongChip(c) || oldFw(c)) && confirmChip !== c.mod) { confirmChip = c.mod; paint(); return; }
    confirmChip = "";
    busy = "cart"; inserting[c.mod] = 0; jobStart(`Installing ${c.name}`);
    traceStart(`install ${c.mod} on ${x.short} ${x.version} running ${x.running}`);
    const T = `Installing ${c.name}`, sub = appVer(c);
    setScreen({ kind: "loading", p: 0, title: T, sub });
    try {
      const res = await useApp(r, c, (p, what) => { inserting[c.mod] = p; meter(p, what === ASK_TEXT ? "" : what); setScreen(what === ASK_TEXT ? { kind: "ask", job: `Install ${c.name}`, ver: sub } : { kind: "loading", p, title: T, what, sub }); paint(); }, { manifest: view() });
      delete inserting[c.mod];
      status(`Restarting it into <b>${esc(c.name)}</b>…${askTime()}`);
      // The soft reset: a fresh heap for the new app (a checked install restarts itself). The port may drop;
      // attach() finds it by ID either way.
      if (!res.restarted) await r.leave();
      expectBack(); jobRestart();
      W.reidentify(x);
      release?.(); release = null; link = null;
      traceEnd("ok");
    } catch (e: any) {
      traceEnd("FAILED: " + (e?.message || e));
      delete inserting[c.mod];
      jobEnd();
      status(`<b class="bad">${esc(c.name)} didn't go on:</b> ${esc(e?.message || e)}`);
      await backToApp(r).catch(() => {});
      setScreen(home());
    }
    busy = ""; paint(); W.touch();
  }

  async function eject() {
    if (!link || busy || !w) return;
    const r = link;
    busy = "cart"; jobStart("Uninstalling");
    const x = w;
    let restarted = false;
    try { restarted = (await removeApp(r, { manifest: view() })).restarted; } catch (e: any) { status(`<b class="bad">Couldn't uninstall it:</b> ${esc(e?.message || e)}`); }
    if (restarted) { meter(1); expectBack(); jobRestart(); W.reidentify(x); release?.(); release = null; link = null; }   // it restarted itself (a checked job)
    else { jobEnd(); await backToApp(r).catch(() => {}); }
    busy = ""; paint(); W.touch();
  }

  // ---- saves and files --------------------------------------------------------------------------------
  // live: the slot answers ls/get/rm while the app runs. Otherwise (the Wallet has USB to itself) the
  // raw REPL, which stops the app for a moment.
  const liveFs = () => slot() && w?.kind === "wedgie";
  async function withFiles<T>(what: string, fn: (r: Repl, live: boolean) => Promise<T>, write = false): Promise<T | undefined> {
    if (!link || busy || !w) return;
    const r = link, lv = liveFs() && !write;
    busy = what; paint();
    try {
      if (!lv) await takeOver(r, askHint, what);
      return await fn(r, lv);
    } catch (e: any) {
      tstatus("");
      $("#d-saves-note").innerHTML = `<b class="bad">${esc(what)} failed:</b> ${esc(e?.message || e)}`;
    } finally {
      if (!lv) { await backToApp(r).catch(() => {}); setScreen(home()); }
      busy = ""; paint(); W.touch();
    }
  }

  let savesList: FS.Entry[] | null = null, savesFor = "";
  let confirmSave = "";
  const gameName = (g: string) => view()?.carts.find((c) => c.mod === g)?.name || g;
  async function loadSaves() {
    const got = await withFiles("Reading saves", (r, lv) => FS.ls(r, "/saves", lv));
    if (got) { savesList = got.files; savesFor = id; paintSaves(); }
  }
  function paintSaves() {
    const box = $("#d-saves"), note = $("#d-saves-note");
    const games = new Map<string, { size: number; files: number }>();
    for (const f of savesList || []) {
      const g = f.path.split("/")[2];
      if (!g || f.dir) continue;
      const e = games.get(g) || { size: 0, files: 0 };
      e.size += f.size; e.files++;
      games.set(g, e);
    }
    if (!note.querySelector(".bad")) {
      note.innerHTML = savesList === null ? (w?.kind === "wallet" ? `The Wallet has USB to itself. <a href="#" data-sv="load">Show saves</a> (stops it for a moment).` : "")
        : games.size ? "Each game keeps its own. Switching apps or updating the firmware never touches them." : "No saves yet. Games that save keep them here, across apps and firmware updates.";
      note.querySelector<HTMLElement>('[data-sv="load"]')?.addEventListener("click", (e) => { e.preventDefault(); loadSaves(); });
    }
    const html = [...games].map(([g, e]) => `<div class="save-row"><div><b>${esc(gameName(g))}</b> <span class="fine">${e.files} file${e.files > 1 ? "s" : ""} · ${kb(e.size)}</span></div>
      <div class="row"><button class="btn btn-sm" data-sv-dl="${esc(g)}">Download</button><button class="btn btn-sm btn-red" data-sv-rm="${esc(g)}">${confirmSave === g ? "Delete them?" : "Delete"}</button></div></div>`).join("");
    if (box.dataset.html !== html) {
      box.dataset.html = html; box.innerHTML = html;
      box.querySelectorAll<HTMLButtonElement>("[data-sv-dl]").forEach((b) => (b.onclick = () => downloadSaves(b.dataset.svDl!)));
      box.querySelectorAll<HTMLButtonElement>("[data-sv-rm]").forEach((b) => (b.onclick = () => deleteSaves(b.dataset.svRm!)));
    }
    main.querySelectorAll<HTMLButtonElement>("[data-sv]").forEach((b) => (b.disabled = !link || !!busy || !games.size));
    const inp = $<HTMLInputElement>("#d-saves-in");
    inp.disabled = !link || !!busy || !(slot() || w?.kind === "wallet");
    inp.parentElement!.classList.toggle("disabled", inp.disabled);
  }
  async function downloadSaves(game?: string) {
    const b = await withFiles("Downloading saves", (r, lv) => FS.saves(r, lv, game));
    if (!b) return;
    b.id = id; b.at = new Date().toISOString();
    FS.download(`wedgie-${id}-saves${game ? "-" + game : ""}.json`, JSON.stringify(b), "application/json");
  }
  async function deleteSaves(game: string) {
    if (confirmSave !== game) { confirmSave = game; paintSaves(); return; }
    confirmSave = "";
    await withFiles("Deleting saves", (r, lv) => FS.rm(r, `/saves/${game}`, lv));
    await loadSaves();
  }
  $<HTMLInputElement>("#d-saves-in").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!f) return;
    let b: FS.Bundle;
    try { b = JSON.parse(await f.text()); if (!b || b["wedgie-saves"] !== 1) throw new Error(); }
    catch { $("#d-saves-note").innerHTML = `<b class="bad">That isn't a saves file.</b> It's the .json that Download gives you.`; return; }
    const n = await withFiles("Putting saves back", (r) => FS.restore(r, b), true);
    if (n !== undefined) { await loadSaves(); $("#d-saves-note").innerHTML = `${n} save file${n === 1 ? "" : "s"} put back.`; }
  };
  main.querySelector<HTMLButtonElement>('[data-sv="all"]')!.onclick = () => downloadSaves();

  // Developer: every file on it.
  let fsList: FS.Listing | null = null, fsOpen = "", confirmFs = "";
  async function loadFiles() {
    const got = await withFiles("Listing files", (r, lv) => FS.ls(r, "/", lv));
    if (got) { fsList = got; paintFiles(); }
  }
  function paintFiles() {
    const box = $("#d-fs");
    box.hidden = !fsList;
    if (!fsList) return;
    $("#d-fs-free").textContent = fsList.free != null ? `${kb(fsList.free)} free` : "";
    box.innerHTML = fsList.files.map((f) => {
      const depth = f.path.split("/").length - 2;
      const name = f.path.split("/").pop();
      return f.dir ? `<div class="fs-row dir" style="--d:${depth}">${esc(name)}/</div>`
        : `<div class="fs-row${fsOpen === f.path ? " open" : ""}" style="--d:${depth}"><a href="#" data-fs-open="${esc(f.path)}">${esc(name)}</a><span class="fine">${f.size < 1024 ? f.size + " B" : kb(f.size)}</span>
          <button class="btn btn-xs" data-fs-dl="${esc(f.path)}">Download</button><button class="btn btn-xs btn-red" data-fs-rm="${esc(f.path)}">${confirmFs === f.path ? "Delete it?" : "Delete"}</button></div>`;
    }).join("") || `<p class="fine">No files.</p>`;
    box.querySelectorAll<HTMLElement>("[data-fs-open]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); viewFile(a.dataset.fsOpen!); }));
    box.querySelectorAll<HTMLButtonElement>("[data-fs-dl]").forEach((b) => (b.onclick = async () => {
      const bytes = await withFiles("Reading it", (r, lv) => FS.get(r, b.dataset.fsDl!, lv), !FS.isSave(b.dataset.fsDl!));
      if (bytes) FS.download(b.dataset.fsDl!.split("/").pop()!, bytes);
    }));
    box.querySelectorAll<HTMLButtonElement>("[data-fs-rm]").forEach((b) => (b.onclick = async () => {
      const p = b.dataset.fsRm!;
      if (confirmFs !== p) { confirmFs = p; paintFiles(); return; }
      confirmFs = "";
      await withFiles("Deleting it", (r, lv) => FS.rm(r, p, lv), !FS.isSave(p));
      if (fsOpen === p) { fsOpen = ""; $("#d-fs-view").hidden = true; }
      await loadFiles();
    }));
  }
  async function viewFile(p: string) {
    const bytes = await withFiles("Reading it", (r, lv) => FS.get(r, p, lv), !FS.isSave(p));
    if (!bytes) return;
    fsOpen = p;
    const v = $("#d-fs-view");
    const text = /\.(py|json|txt|log|md|csv)$/.test(p) || !bytes.some((b) => b === 0) ? new TextDecoder().decode(bytes.subarray(0, 64 * 1024)) : null;
    v.hidden = false;
    v.innerHTML = `<div class="row"><b class="mono">${esc(p)}</b> <span class="fine">${bytes.length} bytes</span><button class="btn btn-xs btn-red" id="d-fs-close">Close</button></div>` +
      (text !== null ? `<pre class="recess out">${esc(text)}</pre>` : `<p class="fine">Not text. Download it to look inside.</p>`);
    $("#d-fs-close").onclick = () => { fsOpen = ""; v.hidden = true; paintFiles(); };
    paintFiles();
  }
  main.querySelector<HTMLButtonElement>('[data-fs="refresh"]')!.onclick = () => { $<HTMLButtonElement>('[data-fs="refresh"]').textContent = "Refresh"; loadFiles(); };
  $<HTMLInputElement>("#d-fs-in").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!f) return;
    const name = f.name.replace(/[^\w.\-]/g, "_");
    await withFiles("Uploading", async (r) => FS.put(r, "/" + name, new Uint8Array(await f.arrayBuffer())), true);
    await loadFiles();
  };

  /** Raw REPL → its app again, same port (main.py, no reset), then its hello refreshes what we know. */
  async function backToApp(r: Repl) {
    await r.leave({ reset: false });
    let h: any = null;
    for (let i = 0; i < 12 && !h; i++) h = await r.hello(700).catch(() => null);
    if (h && w) { if (String(h.fw || "").startsWith("wedgie-")) w.kind = "wedgie"; w.slot = !!h.slot; w.version = h.version; w.apps = h.apps; w.carts = h.carts; w.free = h.free ?? w.free; w.ram = h.ram ?? w.ram; w.running = h.running ?? null; w.firmware = `wedgie ${h.version}`; }
  }

  // ---- firmware ---------------------------------------------------------------------------------------
  async function updateFw() {
    if (!link || busy || !w) return;
    const r = link, x = w;
    busy = "fw"; fwErr = ""; jobStart(`Updating firmware to ${m?.version || ""}`); meter(0, "starting");
    traceStart(`update ${x.short} ${x.version} -> ${m?.version} running ${x.running}`);
    try {
      if (x.kind === "micropython") { await r.enter({ reset: true }); }   // bare MicroPython: no drive, a reset is safe
      setScreen({ kind: "loading", p: 0, title: "Updating firmware" });
      let drawn = 0;
      const res = await installCore(r, (p, what) => { meter(p, what); if (what === ASK_TEXT || p - drawn >= 0.05 || p === 1) { drawn = p; setScreen(what === ASK_TEXT ? { kind: "ask", job: `Update firmware to ${m?.version || ""}` } : { kind: "loading", p, title: "Updating firmware", what }); } });
      if (res.untouched) { jobEnd(); status("Already up to date."); setScreen(home()); busy = ""; paint(); setTimeout(() => status(""), 4000); return; }
      meter(1, res.written ? `wedgie ${res.version} installed. Restarting it…` : "Already up to date. Restarting it…");
      // The one soft reset: the new firmware only runs after one. The port drops and the wedgie comes back as a
      // new port (the drive re-enumerates USB on firmware older than 0.1.3); attach() finds it by its ID.
      // A checked install (0.3.0+) restarts itself.
      if (!res.restarted) await r.leave();
      expectBack(); jobRestart();
      status("Restarting it on the new firmware. It comes back here in a few seconds." + askTime());
      // Identify it again (queued behind this session, so it starts once the port is let go). On 0.1.3+ the
      // port survives a soft reset; if it doesn't, the disconnect marks it gone and the replug is a new one.
      W.reidentify(x);
      release?.(); release = null; link = null;
      traceEnd("ok");
    } catch (e: any) {
      traceEnd("FAILED: " + (e?.message || e));
      fwErr = String(e?.message || e);
      jobEnd();
      setScreen(home());                // never left on "Updating firmware" (10-27: it looked stuck, nothing said why)
      status(`<b class="bad">Update failed:</b> ${esc(e?.message || e)}. It's safe to try again.`);
      busy = ""; paint();               // said now: backToApp on a port that's gone can take a long time
      await Promise.race([backToApp(r).catch(() => {}), new Promise((res) => setTimeout(res, 15000))]);
    }
    busy = ""; paint(); W.touch();      // attach() again (it waited while the update had it)
  }

  // ---- hardware tests (raw REPL: stop its app, run, start it again) ------ ------------------------------
  const act = async (name: string, fn: (r: Repl) => Promise<void>, opts: { probe?: boolean; keep?: boolean } = {}) => {
    if (busy || !link) return;
    busy = name; paint();
    const r = link;
    try {
      if (wedgie()) await takeOver(r, askHint, name); else await r.enter({ reset: true });   // bare MicroPython: no drive, a reset is safe
      if (opts.probe !== false) await r.exec(await W.probe(), 10000);
      await fn(r);
    } catch (e: any) {
      tstatus(`<b class="bad">${esc(name)} failed:</b> ${esc(e?.message || e)}`);
    }
    if (!opts.keep) await restart(r);
  };
  const restart = async (r: Repl) => {
    if (wedgie()) await backToApp(r).catch(() => {}); else await r.leave({ reset: true });
    setScreen(home());
    busy = ""; stopFn = null;
    paint(); W.touch();
  };

  const out = $("#d-out"), editor = $<HTMLTextAreaElement>(".editor"), logEl = $("#d-log");
  editor.value = APP_SAMPLE;
  let sampleFor = "wedgie";
  const logTimer = setInterval(() => {
    if (w && !wedgie() && sampleFor === "wedgie" && editor.value === APP_SAMPLE) { editor.value = PROBE_SAMPLE; sampleFor = "probe"; }
    if ((logEl.closest("details") as HTMLDetailsElement).open && w) { logEl.textContent = w.log; logEl.scrollTop = 1e9; }
  }, 400);

  const handlers: Record<string, () => void> = {
    mirror: () => { mirrorOn = !mirrorOn; setScreen(home()); paint(); },
    chip: async () => {
      if (!link || busy || !w) return;
      busy = "chip"; paint();
      await W.reprove(w, link);
      busy = ""; paint();
    },
    screen: () => act("Screen test", async (r) => {
      await r.exec("screen()", 10000);
      for (const [name, css] of [["red", "#f00"], ["green", "#0f0"], ["blue", "#00f"]]) {
        await r.exec(`screen("${name}")`, 10000);
        setScreen({ kind: "color", css });
        tstatus(`Its screen should be <b>${name.toUpperCase()}</b> edge to edge.`);
        await sleep(1100);
      }
      tstatus("Red, green, blue. If one looked wrong or patchy, reseat the screen board on the Pico.");
    }),
    keys: () => act("Button test", async (r) => {
      setScreen(idScreen());
      KEYS.forEach((k) => w3?.keyVisual(k, false));
      const seen = new Set<string>();
      tstatus(`Press every button on the wedgie: joystick up, down, left, right, push it in, then the four buttons, green to red. <span id="d-left"></span>`);
      const left = () => { const l = KEYS.filter((k) => !seen.has(k)); const e = main.querySelector("#d-left"); if (e) e.textContent = l.length ? `Left: ${l.join(" ")}` : ""; };
      left();
      r.onLine = (t, v) => {
        if (t === "stuck" && v.length) tstatus(`<b class="bad">Held down from the start:</b> ${esc(v.join(", "))}`);
        if (t === "key") { if (!v.down) seen.add(v.key); w3?.keyVisual(v.key, v.down); left(); }
      };
      stopFn = () => r.interrupt();
      try { await r.exec("keys(180)", 190000); } catch {}
      const miss = KEYS.filter((k) => !seen.has(k));
      tstatus(miss.length ? `<b class="bad">Never pressed:</b> ${esc(miss.join(" "))}` : `<b class="good">All nine buttons work.</b>`);
    }),
    run: () => act("Run", async (r) => {
      out.textContent = "";
      r.onText = ((prev) => (s: string) => { prev?.(s); out.textContent = (out.textContent + s.replace(/[\x00-\x08]/g, "")).slice(-20000); out.scrollTop = 1e9; })(r.onText);
      stopFn = () => { r.interrupt(); restart(r); };
      setScreen(home());
      try {
        await r.exec(editor.value, 10 * 60 * 1000);
        out.textContent += "\n[returned; timers keep running until Stop]";
      } catch (e: any) { out.textContent += "\n" + (e?.message || e); }
    }, { probe: !wedgie(), keep: true }),
    stop: () => stopFn?.(),
    saveapp: () => {
      if (!wedgie() || !slot()) { out.textContent = "Install or update the wedgie firmware first (0.2+ runs one app)."; return; }
      const name = ($<HTMLInputElement>("#d-appname").value || "").trim() || "sketch";
      const mod = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]/, "_$&").slice(0, 20);
      act("Save", async (r) => {
        const enc = new TextEncoder();
        await FS.writeFile(r, mod + ".py", enc.encode(editor.value), { span: [0, 0.9] });
        await FS.writeFile(r, "apps.json", enc.encode(JSON.stringify([{ mod, name: name.slice(0, 12), about: "yours" }])), { span: [0.9, 1], what: "" });
        await r.exec(`import sys\nsys.modules.pop(${pyStr(mod)}, None)`);
        out.textContent = `Saved as ${mod}.py; it's the wedgie's app now, and it boots into it.`;
      }, { probe: false });
    },
  };
  main.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => (b.onclick = () => handlers[b.dataset.act!]?.()));

  // Last: attach() paints, and painting reads everything declared above.
  const off = W.onChange(attach);
  expectBack(FIND_MS);
  attach();
  mirror();

  return () => {
    alive = false;
    off();
    clearInterval(backTimer);
    clearInterval(logTimer);
    stopFn?.();
    release?.();
    w3?.destroy();
  };
}
