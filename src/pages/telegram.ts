// /telegram: the wedgie Telegram group. Without ?t= it says how to get in (the link to share). With the
// bot's ?t= (bot/telegram.mjs), Connect: the wedgie's Trust M signs ({"type":"chip"}, no yes needed, like
// /connect's chip check) and /api/telegram checks it and hands back a one-person invite. One chip, one account.
// Nothing looks at USB until Connect is tapped.
import * as W from "../serial/wedgies";
import { esc } from "../ui/device";

const BOT = "wedgiechatbot";

export function telegram(main: HTMLElement) {
  const t = new URLSearchParams(location.search).get("t");
  main.innerHTML = `
  <section class="test-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>wedgie Telegram</h1>
    <p class="test-safe">Plug in your wedgie to get in.</p>
    <div class="card">
      <p>1. Message <a href="https://t.me/${BOT}" target="_blank" rel="noopener"><b>@${BOT}</b></a>.</p>
      <p>2. Open its link in Chrome on a computer.</p>
      <p>3. Plug in your wedgie. Tap Connect.</p>
    </div>
    <div class="test-actions" id="tg-actions"></div>
    <p class="fine">Needs a Trust M chip. One wedgie, one account.</p>
  </section>`;
  const box = main.querySelector<HTMLElement>("#tg-actions")!;
  if (!t) {
    box.innerHTML = `<a class="btn btn-green" href="https://t.me/${BOT}" target="_blank" rel="noopener">Message @${BOT}</a>`;
    return;
  }
  if (!W.supported()) {
    box.innerHTML = `<p class="fine">Open this in Chrome on a computer.</p>`;
    return;
  }
  const say = (html: string) => { box.innerHTML = html; };
  let busy = false, done = false;
  const tried = new Set<number>();      // each wedgie signs on its own once; after that, Try again
  const ask = () => say(`<button class="btn btn-green" id="tg-go">Connect</button>`);
  ask();
  box.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id !== "tg-go" || busy) return;
    const w = ready();
    if (w) void prove(w); else W.connectNew().catch(() => {});
  });
  const ready = () => W.wedgies().find((x) => x.state === "ready" && x.kind === "wedgie");
  W.start();
  W.onChange(() => {
    const w = ready();
    if (w && !busy && !done && !tried.has(w.key)) { tried.add(w.key); void prove(w); }
    else if (!busy && !done && W.wedgies().some((x) => x.state === "identifying")) say(`<p class="fine">Finding your wedgie</p>`);
  });

  async function prove(w: W.Wedgie) {
    busy = true;
    say(`<p class="fine">Signing</p>`);
    try {
      const d = await W.withRepl(w, async (r) => {
        let d = await r.request({ type: "chip" }, 15000);
        for (let i = 0; d.busy && i < 40; i++) {      // its app is mid-command on the chip
          await new Promise((res) => setTimeout(res, 250));
          d = await r.request({ type: "chip" }, 15000);
        }
        return d;
      });
      const res = await fetch("/api/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t, proof: d }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `The server said ${res.status}`);
      done = true;
      say(`<a class="btn btn-green" href="${esc(out.link)}" target="_blank" rel="noopener">Join the group</a>
        <p class="fine">Works once, for an hour.</p>`);
    } catch (e: any) {
      say(`<p class="fine"><b>${esc(e?.message || String(e))}</b></p><button class="btn btn-green" id="tg-go">Try again</button>`);
    } finally { busy = false; }
  }
}
