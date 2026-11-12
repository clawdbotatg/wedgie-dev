// The Telegram sticker (bottom left): shows once a real wedgie is plugged in and talking.
// Seen 3+ times: smaller, slower wiggle. Joined (tapped Join the chat on /telegram): smaller still, still.
export function tgSticker(main: HTMLElement) {
  main.insertAdjacentHTML("beforeend", `<a class="tg-sticker" href="/telegram" hidden><img src="/img/telegram-sticker.webp" alt="Join the Wedgies Telegram"></a>`);
  const tg = main.querySelector<HTMLElement>(".tg-sticker")!;
  let counted = false;
  return (on: boolean) => {
    tg.hidden = !on;
    if (!on || counted) return;
    counted = true;
    let seen = 0, joined = false;
    try { seen = +(localStorage.getItem("tg-seen") || 0) + 1; localStorage.setItem("tg-seen", String(seen)); joined = !!localStorage.getItem("tg-joined"); } catch {}
    tg.classList.toggle("calm", seen > 3);
    tg.classList.toggle("joined", joined);
  };
}
