// A yes/no in the site's own sheet look. Never the browser's confirm() (Austin, 10-21: "javascript alert garbage").
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Resolves true on yes; no, Escape or a tap outside is false. yes is red: it's for something you can't take back. */
export function askYes(q: string, yes: string, no = "Cancel"): Promise<boolean> {
  return new Promise((done) => {
    const el = document.createElement("div");
    el.className = "sx-sheet sx-ask";
    el.innerHTML = `<div class="sx-sheet-card" role="alertdialog" aria-modal="true"><p class="sx-ask-q">${esc(q)}</p>
      <p class="sx-row"><button class="btn" type="button" data-no>${esc(no)}</button><button class="btn btn-red sx-end" type="button" data-yes>${esc(yes)}</button></p></div>`;
    const end = (v: boolean) => { el.remove(); removeEventListener("keydown", key, true); done(v); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); end(false); } };
    el.onclick = (e) => { if (e.target === el) end(false); };
    el.querySelector<HTMLElement>("[data-no]")!.onclick = () => end(false);
    el.querySelector<HTMLElement>("[data-yes]")!.onclick = () => end(true);
    addEventListener("keydown", key, true);
    document.body.append(el);
    el.querySelector<HTMLElement>("[data-no]")!.focus();
  });
}
