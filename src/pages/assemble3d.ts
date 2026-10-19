// /assemble/3d: the assembly manual as a 3D playground. Every step of /assemble (same words, same
// photos) with its own animation of the real parts (ui/playground3d.ts). Pick a step or use the
// arrows: it plays once and holds. Drag to look around, scroll or pinch to zoom. #7 opens step 7.
import "./assemble.css";
import "./assemble3d.css";
import { STEPS } from "./assemble";
import type { Playground } from "../ui/playground3d";

const IMG = "/img/assemble/";

export function assemble3d(main: HTMLElement) {
  main.innerHTML = `
  <section class="pg">
    <div class="pg-stage recess" id="pg-stage">
      <p class="pg-hint">${matchMedia("(pointer: coarse)").matches ? "Drag to turn · Pinch to zoom · Two fingers to move" : "Drag to turn · Scroll to zoom · Right-drag to move"}</p>
      <div class="pg-bar">
        <button type="button" class="btn btn-sm" id="pg-prev" aria-label="Previous step">←</button>
        <button type="button" class="btn btn-sm btn-green" id="pg-play" aria-label="Play">Play</button>
        <input type="range" id="pg-scrub" min="0" max="1000" value="0" aria-label="Scrub this step">
        <button type="button" class="btn btn-sm" id="pg-next" aria-label="Next step">→</button>
        <button type="button" class="btn btn-sm" id="pg-view" aria-label="Reset the view">⟲</button>
      </div>
    </div>
    <aside class="pg-side card">
      <div class="pg-now">
        <span class="kicker" id="pg-of"></span>
        <div class="asm-head"><span class="num" id="pg-num"></span><h2 id="pg-title"></h2></div>
        <div id="pg-copy"></div>
        <div class="photos" id="pg-photos"></div>
        <label class="pg-auto"><input type="checkbox" id="pg-all"> Play all steps</label>
      </div>
      <ol class="pg-list" id="pg-list">
        ${STEPS.map((s, i) => `<li><button type="button" data-i="${i}"><b>${i + 1}</b>${s.t}</button></li>`).join("")}
      </ol>
      <p class="fine pg-back"><a href="/assemble">The step-by-step page with photos</a> · <a href="/assemble.pdf" download>Print (PDF)</a></p>
    </aside>
    <dialog class="asm-big"><img alt=""><button type="button" class="btn">Close</button></dialog>
  </section>`;

  const $ = <T extends HTMLElement>(id: string) => main.querySelector<T>("#" + id)!;
  const stage = $("pg-stage"), play = $<HTMLButtonElement>("pg-play"), scrub = $<HTMLInputElement>("pg-scrub");
  const list = $("pg-list"), all = $<HTMLInputElement>("pg-all");
  const big = main.querySelector<HTMLDialogElement>(".asm-big")!, bigImg = big.querySelector("img")!;
  big.addEventListener("click", () => big.close());

  let pg: Playground | null = null;
  let step = Math.max(0, Math.min(STEPS.length - 1, (parseInt(location.hash.slice(1)) || 1) - 1));
  let t = 0, playing = false, last = 0, hold = 0;

  function paint() {
    const s = STEPS[step];
    $("pg-of").textContent = `Step ${step + 1} of ${STEPS.length}`;
    const num = $("pg-num");
    num.textContent = String(step + 1);
    num.style.background = ["var(--green-fill)", "var(--grey-fill)", "var(--red-fill)"][step % 3];
    $("pg-title").textContent = s.t;
    $("pg-copy").innerHTML = `<p>${s.p}</p>${s.art ? `<div class="asm-art recess">${s.art}</div>` : ""}${s.tip ? `<p class="note">${s.tip}</p>` : ""}${s.warn ? `<p class="note bad">${s.warn}</p>` : ""}`;
    $("pg-photos").innerHTML = s.ph.map((f) => `<button type="button" data-ph="${f}" aria-label="Photo"><img src="${IMG}t/${f}.webp" alt="" loading="lazy"></button>`).join("");
    list.querySelectorAll("button").forEach((b, i) => b.classList.toggle("here", i === step));
    const li = list.querySelector<HTMLElement>(`[data-i="${step}"]`)!.parentElement!;   // scroll the list only, never the page
    if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop - 8;
    else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight + 8;
    history.replaceState(null, "", `#${step + 1}`);
  }
  $("pg-photos").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ph]");
    if (b) { bigImg.src = `${IMG}p/${b.dataset.ph}.webp`; big.showModal(); }
  });

  function go(i: number) {
    step = (i + STEPS.length) % STEPS.length;
    t = 0; hold = 0;
    paint();
    setPlaying(true);
  }
  function setPlaying(on: boolean) {
    playing = on; last = performance.now();
    play.textContent = on ? "Pause" : t >= 1 ? "Replay" : "Play";
  }
  play.addEventListener("click", () => { if (!playing && t >= 1) t = 0; setPlaying(!playing); });
  $("pg-prev").addEventListener("click", () => go(step - 1));
  $("pg-next").addEventListener("click", () => go(step + 1));
  $("pg-view").addEventListener("click", () => pg?.resetView());
  scrub.addEventListener("input", () => { setPlaying(false); t = +scrub.value / 1000; play.textContent = t >= 1 ? "Replay" : "Play"; });
  list.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]"); if (b) go(+b.dataset.i!); });
  all.addEventListener("change", () => { if (all.checked && !playing) { if (t >= 1) go(step + 1); else setPlaying(true); } });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea") && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(step + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(step - 1); }
    else if (e.key === " " && !(e.target as HTMLElement).closest("button")) { e.preventDefault(); play.click(); }
  };
  addEventListener("keydown", onKey);
  addEventListener("hashchange", () => { const n = parseInt(location.hash.slice(1)) - 1; if (n >= 0 && n < STEPS.length && n !== step) go(n); });

  paint();
  // Drop the hint once they've touched it.
  stage.addEventListener("pointerdown", () => stage.classList.add("touched"), { once: true });

  import("../ui/playground3d").then(async ({ mountPlayground }) => {
    pg = await mountPlayground(stage);
    if (pg.steps !== STEPS.length) console.warn("playground: steps out of step", pg.steps, STEPS.length);
    stage.classList.add("live");
    setPlaying(true);
    const tick = () => {
      if (!stage.isConnected) { pg?.destroy(); removeEventListener("keydown", onKey); return; }
      requestAnimationFrame(tick);
      const now = performance.now(), dt = (now - last) / 1000;
      last = now;
      if (playing) {
        t = Math.min(1, t + dt / pg!.durations[step]);
        if (t >= 1) {
          if (all.checked && step < STEPS.length - 1) { hold += dt; if (hold > 1.4) go(step + 1); }
          else setPlaying(false);
        }
      }
      scrub.value = String(Math.round(t * 1000));
      pg!.show(step, t);
    };
    tick();
  }).catch((err) => {
    console.error("3D playground:", err);
    stage.innerHTML = `<p class="pg-fail">3D didn't load here. <a href="/assemble">The step-by-step page</a> has every step with photos.</p>`;
  });
}
