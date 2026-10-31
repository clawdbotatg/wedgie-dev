// "Cable not these colors?": the box at the top of /assemble and /assemble/3d. The kit cable's photo, then
// the mapper: your cable in 3D (ui/cable3d.ts) and one row per kit wire. onChange gets the new colors.
// Styles: assemble.css (.cbl).
import { KIT, PALETTE, hex, label, wires, setWires, isKit } from "./cablecolors";

const IMG = "/img/assemble/";
const PHOTO = "02-trust-m-plug";
export const sw = (c: string) => `<i class="sw" style="background:${hex(c)}"></i>`;

export const cableBox = () => `
  <div class="card cbl">
    <button type="button" class="cbl-ph" aria-label="Photo"><img src="${IMG}p/${PHOTO}.webp" alt="The kit's cable in the Trust M's left socket: white, yellow, black, red, top to bottom"></button>
    <div class="cbl-ask">
      <h3 class="cbl-title"></h3>
      <p class="cbl-now"></p>
      <button type="button" class="btn cbl-open">Map wire colors</button>
    </div>
    <div class="cbl-map" hidden>
      <div class="cbl-3d recess"></div>
      <ol class="cbl-rows">
        ${KIT.map((k, i) => `<li><span class="cbl-kit">${sw(k)}<b>${k}</b></span><span class="cbl-arrow">→</span>
          <span class="cbl-pick" data-i="${i}">${Object.keys(PALETTE).map((c) => `<button type="button" data-c="${c}" style="background:${hex(c)}" aria-label="${k} is ${c}" title="${c}"></button>`).join("")}<label class="cbl-own" title="Any color"><input type="color" aria-label="${k} is another color" value="#ff66aa"></label></span></li>`).join("")}
      </ol>
      <p class="note bad cbl-same" hidden>Two wires have the same color.</p>
      <div class="row cbl-btns"><button type="button" class="btn cbl-kitbtn">Kit colors</button><button type="button" class="btn cbl-done">Done</button></div>
    </div>
    <dialog class="asm-big"><img alt=""><button type="button" class="btn">Close</button></dialog>
  </div>`;

/** Wire up the box made by cableBox() inside `root`. */
export function mountCableBox(root: HTMLElement, onChange: (w: string[]) => void) {
  const box = root.querySelector<HTMLElement>(".cbl")!;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => box.querySelector<T>(s)!;
  const map = q(".cbl-map"), open = q(".cbl-open"), stage = q(".cbl-3d");
  let w = wires();

  function paint() {
    const kit = isKit(w);
    q(".cbl-title").textContent = kit ? "Cable not these colors?" : "Your cable";
    q(".cbl-now").innerHTML = kit ? "" : KIT.map((k, i) => `<span>${sw(k)}→${sw(w[i])}<b>${label(w[i])}</b></span>`).join("");
    map.querySelectorAll<HTMLElement>(".cbl-pick").forEach((p) => {
      const c = w[+p.dataset.i!], own = c.startsWith("#");
      p.querySelectorAll<HTMLElement>("button").forEach((b) => {
        const on = b.dataset.c === c;
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
      });
      const l = p.querySelector<HTMLElement>(".cbl-own")!;        // the picker: rainbow, or the color picked
      l.classList.toggle("on", own); l.style.background = own ? c : "";
      if (own) l.querySelector("input")!.value = c;
    });
    q(".cbl-same").hidden = new Set(w).size === 4;
  }
  paint();

  let c3d: import("../ui/cable3d").Cable3D | null = null;
  open.addEventListener("click", () => {
    map.hidden = false; open.hidden = true;
    if (!c3d) import("../ui/cable3d").then(async ({ mountCable3D }) => { c3d = await mountCable3D(stage, w.map(hex)); })
      .catch((err) => { console.error("cable 3D:", err); stage.hidden = true; });
  });
  const set = (nw: string[]) => { w = nw; setWires(w); c3d?.setColors(w.map(hex)); paint(); onChange(w); };
  map.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-c]");
    if (!b) return;
    const i = +b.closest<HTMLElement>(".cbl-pick")!.dataset.i!;
    set(w.map((c, j) => j === i ? b.dataset.c! : c));
  });
  map.addEventListener("change", (e) => {   // the picker: once it's closed
    const inp = e.target as HTMLInputElement;
    if (inp.type !== "color") return;
    const i = +inp.closest<HTMLElement>(".cbl-pick")!.dataset.i!;
    set(w.map((c, j) => j === i ? inp.value.toLowerCase() : c));
  });
  q(".cbl-kitbtn").addEventListener("click", () => set([...KIT]));
  q(".cbl-done").addEventListener("click", () => { map.hidden = true; open.hidden = false; c3d?.destroy(); c3d = null; stage.innerHTML = ""; });

  const big = q<HTMLDialogElement>(".asm-big");
  q(".cbl-ph").addEventListener("click", () => { big.querySelector("img")!.src = `${IMG}p/${PHOTO}.webp`; big.showModal(); });
  big.addEventListener("click", () => big.close());
}
