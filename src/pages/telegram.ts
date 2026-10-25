// /telegram: the wedgie Telegram group. Without ?t= it says how to get in (the link to share). With the
// bot's ?t= (bot/telegram.mjs), Connect: Safe Signer shows "Join Telegram" and on green signs it with the bot's
// token (safe_prove: its key, vouched for by the chip's factory key); /api/telegram checks both and hands back
// a one-person invite. One chip, one account.
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
      <p>3. Open Safe Signer on your wedgie. Plug it in. Tap Connect.</p>
      <p>4. Press green.</p>
    </div>
    <div class="test-actions" id="tg-actions"></div>
    <p class="fine">Needs a Trust M chip and a Safe Signer key. One wedgie, one account.</p>
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
  const tried = new Set<number>();      // each wedgie is asked on its own once; after that, Try again
  const ask = () => say(`<button class="btn btn-green" id="tg-go">Connect</button>`);
  ask();
  box.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id !== "tg-go" || busy) return;
    const w = ready();
    if (w && w.running !== "safe") { tried.clear(); W.reidentify(w); }      // they may have opened Safe Signer since
    else if (w) void prove(w); else W.connectNew().catch(() => {});
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
    try {
      if (w.running !== "safe") throw new Error("Open Safe Signer on your wedgie.");
      say(`<p class="fine"><b>Press green on your wedgie.</b></p>`);
      const d = await W.withRepl(w, (r) => r.request({ type: "safe_prove", text: "Join Telegram", code: t }, 130000));
      if (d.type === "refused") throw new Error("You said no.");
      if (d.type !== "safe_proof") throw new Error(d.error || "Update Safe Signer.");
      say(`<p class="fine">Checking</p>`);
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
