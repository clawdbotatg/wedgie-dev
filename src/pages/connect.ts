// /connect: every wedgie plugged into this computer, one row each: its hardware (chip proven working?),
// its firmware (update ready?), its software (what it has, what it plays). Tap a row for that wedgie's own page,
// /connect/<ID> (pages/wedgie.ts): hardware, firmware update, its app, saves. Both are one page app, so
// going between them never reloads (a reload would close every port and identify every wedgie again).
// Above the rows: a board with no wedgie firmware yet (a new Pico in boot mode, ...) and its Set up (setup.ts).
import { esc } from "../ui/device";
import { place3D, idScreen, baseColor } from "../ui/place3d";
import * as W from "../serial/wedgies";
import { firmwareManifest, type Manifest } from "../serial/install";
import * as F from "../ui/facts";
import { wedgiePage } from "./wedgie";
import { setupCard, needsSetup } from "./setup";

let manifest: Manifest | undefined;

export function connect(main: HTMLElement) {
  let cleanup: (() => void) | null = null;
  const route = () => {
    cleanup?.();
    const m = location.pathname.replace(/\/+$/, "").match(/^\/connect\/([^/]+)$/);
    cleanup = m ? wedgiePage(main, decodeURIComponent(m[1]).toUpperCase(), go) : list(main, go);
    scrollTo(0, 0);
  };
  const go = (path: string) => { history.pushState(null, "", path); route(); };
  addEventListener("popstate", route);
  // The header's Connect (once it counts wedgies it's a plain link to /connect): stay in this page app.
  document.getElementById("connect-btn")?.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || location.pathname === "/connect") return;
    e.preventDefault(); go("/connect");
  });
  route();
  W.start();
}

function list(main: HTMLElement, go: (path: string) => void) {
  main.innerHTML = `
  <section class="sec connect">
    <div class="sec-head">
      <span class="kicker">Connect</span>
      <h2>Your wedgies</h2>
    </div>
    <div id="setup"></div>
    <div class="rows" id="rows"></div>
    <div class="row center" id="plug-actions"></div>
  </section>`;
  const rows = main.querySelector<HTMLElement>("#rows")!;
  const actions = main.querySelector<HTMLElement>("#plug-actions")!;
  const setup = setupCard(main.querySelector<HTMLElement>("#setup")!);
  firmwareManifest().then((m) => { manifest = m; draw(); }).catch(() => {});

  const screenFor = (w: W.Wedgie) => w.state === "identifying" ? idScreen("...", "finding it") : w.state === "error" ? idScreen("?", "can't talk") : idScreen(w.short || "", w.board);

  // Repaint by key: frames change several times while a wedgie identifies; keep nodes stable (each row
  // holds a 3D wedgie that must not be rebuilt).
  function draw() {
    const ws = W.wedgies().filter((w) => !needsSetup(w));
    if (!W.supported()) {
      rows.innerHTML = `<div class="empty"><p><b>This browser can't see USB devices.</b><br>Open wedgie.dev in Chrome or Edge on a computer to plug in a wedgie.</p></div>`;
      actions.innerHTML = "";
      return;
    }
    if (!ws.length) {
      if (!rows.querySelector(".empty")) {
        rows.replaceChildren();
        rows.insertAdjacentHTML("beforeend", `<div class="empty"><div class="empty-dev"></div><p>No wedgies yet. Plug one in with a USB cable and press <b>Connect</b>. After the first time, it shows up by itself.</p></div>`);
        place3D(rows.querySelector<HTMLElement>(".empty-dev")!, { demo: "PLUGIN", side: -1 });
      }
    } else {
      rows.querySelector(".empty")?.remove();
      const keep = new Set(ws.map((w) => String(w.key)));
      rows.querySelectorAll<HTMLElement>(".wrow").forEach((el) => { if (!keep.has(el.dataset.key!)) { (el as any)._w3d?.then((x: any) => x?.destroy()); el.remove(); } });
      for (const w of ws) {
        let el = rows.querySelector<HTMLAnchorElement>(`.wrow[data-key="${w.key}"]`);
        const hw = F.hardware(w), fw = F.firmware(w, manifest), pl = F.playing(w, manifest);
        const sig = [w.state, w.short, w.chip?.type, hw.html, fw.html, pl.html].join("|");
        if (!el) {
          el = document.createElement("a");
          el.className = "wrow";
          el.dataset.key = String(w.key);
          el.innerHTML = `<div class="wrow-dev"></div>
            <div class="wrow-body"><div class="wrow-head"><span class="light"></span><span class="idtag"></span></div>
            <dl class="facts"><dt>Hardware</dt><dd data-f="hw"></dd><dt>Firmware</dt><dd data-f="fw"></dd><dt>Software</dt><dd data-f="pl"></dd></dl></div>
            <span class="chev" aria-hidden="true">›</span>`;
          el.addEventListener("click", (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || !el!.dataset.id) return; e.preventDefault(); go(el!.getAttribute("href")!); });
          rows.appendChild(el);
          (el as any)._w3d = place3D(el.querySelector<HTMLElement>(".wrow-dev")!, { interactive: false, screen: screenFor(w), side: w.key % 2 ? 1 : -1 });
        }
        if (el.dataset.sig === sig) continue;
        el.dataset.sig = sig;
        if (w.short) { el.href = `/connect/${w.short}`; el.dataset.id = w.short; }
        el.classList.toggle("off", w.state !== "ready");
        (el as any)._w3d.then((x: any) => { x?.setScreen(screenFor(w)); x?.setColor("base", baseColor(w.chip?.type)); });
        el.querySelector(".idtag")!.innerHTML = w.state === "identifying" ? "finding…" : w.state === "error" ? "can't talk" : esc(w.short);
        el.querySelector(".light")!.className = `light ${F.overall(w, manifest)}`;
        el.querySelector('[data-f="hw"]')!.innerHTML = hw.html;
        el.querySelector('[data-f="fw"]')!.innerHTML = fw.html;
        el.querySelector('[data-f="pl"]')!.innerHTML = pl.html;
      }
    }
    actions.innerHTML = `<button class="btn ${ws.length ? "" : "btn-green"}" id="connect">${ws.length ? "Connect another" : "Connect a wedgie"}</button>` +
      (ws.length ? `<p class="fine unplug-tip">If your wedgie is acting weird, unplug it and plug it back in.</p>` : "") +
      ("usb" in navigator ? `<p class="fine unplug-tip">A brand-new Pico doesn't show up? <a href="#" id="pick-new">Pick it</a> (it's called RP2 Boot or RP2350 Boot).</p>` : "");
    document.getElementById("connect")!.onclick = () => W.connectNew().catch(() => {});
    const pn = document.getElementById("pick-new");
    if (pn) pn.onclick = (e) => { e.preventDefault(); setup.pickNew(); };
  }

  const off = W.onChange(draw);
  draw();
  return () => {
    off();
    setup.stop();
    rows.querySelectorAll<HTMLElement>(".wrow").forEach((el) => (el as any)._w3d?.then((x: any) => x?.destroy()));
  };
}
