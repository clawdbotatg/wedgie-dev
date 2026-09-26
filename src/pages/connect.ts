// /connect: what you do once you have the hardware. Every plugged-in wedgie, with its ID; click one
// to open its panel (apps, firmware, tests, code, console).
import { esc } from "../ui/device";
import { place3D, idScreen } from "../ui/place3d";
import * as W from "../serial/wedgies";
import { openPanel } from "../ui/panel";
import { firmwareManifest } from "../serial/install";

let latest = "";
function badge(w: W.Wedgie) {
  if (w.state !== "ready") return "";
  if (w.kind === "wedgie") return latest && w.version !== latest ? `<span class="badge">update</span>` : "";
  return `<span class="badge grey">needs firmware</span>`;
}

export function connect(main: HTMLElement) {
  main.innerHTML = `
  <section class="sec connect">
    <div class="sec-head">
      <span class="kicker">Connect</span>
      <h2>Your wedgies</h2>
      <p>Plug a wedgie into USB-C. It shows up here with its ID. Click it to install software, test it, or send it code.</p>
    </div>
    <div class="tray" id="tray"></div>
    <div class="row center" id="plug-actions"></div>
  </section>`;
  const tray = main.querySelector<HTMLElement>("#tray")!;
  const actions = main.querySelector<HTMLElement>("#plug-actions")!;
  firmwareManifest().then((m) => { latest = m.version; drawTray(); }).catch(() => {});


  function screenFor(w: W.Wedgie) {
    if (w.state === "identifying") return idScreen("...", "finding it");
    if (w.state === "error") return idScreen("?", "can't talk");
    return idScreen(w.short || "", w.board);
  }

  // Repaint by key: frames change several times while a wedgie identifies; keep nodes stable (each slot
  // holds a 3D wedgie that must not be rebuilt).
  function drawTray() {
    const ws = W.wedgies();
        if (!W.supported()) {
      tray.innerHTML = `<div class="empty"><p><b>This browser can't see USB devices.</b><br>Open wedgie.dev in Chrome or Edge on a computer to plug in a wedgie.</p></div>`;
      actions.innerHTML = "";
      return;
    }
    if (!ws.length) {
      if (!tray.querySelector(".empty")) {
        tray.replaceChildren();
        tray.insertAdjacentHTML("beforeend", `<div class="empty"><div class="empty-dev"></div><p>No wedgies yet. Plug one in and press <b>Connect</b>. After the first time, it shows up by itself.</p></div>`);
        place3D(tray.querySelector<HTMLElement>(".empty-dev")!, { demo: "PLUGIN", side: -1 });
      }
    } else {
      tray.querySelector(".empty")?.remove();
      const keep = new Set(ws.map((w) => String(w.key)));
      tray.querySelectorAll<HTMLElement>(".slot").forEach((el) => { if (!keep.has(el.dataset.key!)) { (el as any)._w3d?.then((x: any) => x?.destroy()); el.remove(); } });
      for (const w of ws) {
        let el = tray.querySelector<HTMLElement>(`.slot[data-key="${w.key}"]`);
        const sig = `${w.state}|${w.short}|${w.board}|${w.error}|${w.kind}|${w.version}|${latest}`;
        if (!el) {
          el = document.createElement("button");
          el.className = "slot";
          el.dataset.key = String(w.key);
          el.onclick = () => openPanel(w);
          el.innerHTML = `<div class="dev"></div><span class="idtag"></span><span class="meta"></span>`;
          tray.appendChild(el);
          (el as any)._w3d = place3D(el.querySelector<HTMLElement>(".dev")!, { interactive: false, screen: screenFor(w), side: w.key % 2 ? 1 : -1 });
        }
        if (el.dataset.sig === sig) continue;
        el.dataset.sig = sig;
        (el as any)._w3d.then((x: any) => x?.setScreen(screenFor(w)));
        el.querySelector(".idtag")!.innerHTML = w.state === "identifying" ? "finding…" : w.state === "error" ? "can't talk" : esc(w.short);
        el.querySelector(".meta")!.innerHTML = `${w.state === "error" ? esc(w.error) : esc([w.board, w.kind === "wedgie" ? "wedgie " + w.version : w.chip?.type].filter(Boolean).join(" · "))}${badge(w)}`;
      }
    }
    actions.innerHTML = `<button class="btn btn-green" id="connect">${ws.length ? "Connect another" : "Connect a wedgie"}</button>`;
    document.getElementById("connect")!.onclick = () => W.connectNew().catch(() => {});
  }

  W.onChange(drawTray);
  drawTray();
  W.start();
}
