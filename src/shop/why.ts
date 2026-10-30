// Why the price moves: one box, opened by the green * after a price or the green surge amount (front page, order page).
// While there's a surge, a red Email alert in it: one mail the next time it's back to list (api/alert.ts).
import { BUMP, ITEMS } from "./catalog";

const usd = (c: number) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
export const WHY = `<div class="why" hidden>
  <p><b>Built by hand</b> by Austin and Gus Griffith, so we can only make so many a day.</p>
  <p><b>Surge pricing.</b> Each sale adds ${usd(BUMP)}. Then it slides back down: a day with no sales and it's ${usd(ITEMS.wedgie.cents)} again.</p>
  <p class="fine">It's a <a href="https://www.paradigm.xyz/2022/08/vrgda" target="_blank" rel="noopener">VRGDA</a> (variable rate gradual Dutch auction),
    the pricing rule onchain projects use to sell at a steady pace: sell faster than we can build and the price climbs, slower and it falls.</p>
  <div class="why-alert" hidden>
    <p class="why-ask-row"><button class="btn btn-sm why-ask">Email alert</button></p>
    <form class="why-form row" hidden><input name="email" type="email" autocomplete="email" maxlength="100" placeholder="you@email.com" required>
      <button class="btn btn-sm">Email me</button></form>
    <p class="fine why-say" hidden></p>
  </div>
</div>`;
/** The green * after a price: opens the box. */
export const STAR = `<button class="star" aria-label="why the price moves">*</button>`;
/** surge: is the price over list right now (then the alert shows). The green amount (.why-open) opens the box too. */
export function wire(root: HTMLElement, surge = false) {
  const box = root.querySelector<HTMLElement>(".why");
  if (!box) return;
  root.querySelectorAll<HTMLElement>(".star, .why-open").forEach((b) => (b.onclick = () => { box.hidden = !box.hidden; }));
  box.querySelector<HTMLElement>(".why-alert")!.hidden = !surge;
  const ask = box.querySelector<HTMLButtonElement>(".why-ask")!, form = box.querySelector<HTMLFormElement>(".why-form")!;
  const say = box.querySelector<HTMLElement>(".why-say")!, input = form.querySelector("input")!;
  ask.onclick = () => {
    ask.parentElement!.hidden = true; form.hidden = false;
    try { input.value ||= localStorage.getItem("wedgie-email") || ""; } catch {}
    input.focus();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const go = form.querySelector<HTMLButtonElement>("button")!;
    go.disabled = true;
    let r: any = {};
    try { r = await (await fetch("/api/alert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: input.value }) })).json(); }
    catch { r = { error: "Couldn't reach the shop. Try again." }; }
    go.disabled = false;
    say.hidden = false;
    if (r.ok) { form.hidden = true; say.textContent = `We'll email you when it's ${usd(ITEMS.wedgie.cents)} again.`; }
    else say.innerHTML = `<b class="bad"></b>`, say.firstElementChild!.textContent = r.error || "That didn't work.";
  };
}
