// "Send a bug report": everything we'd want to see, shown to the person first, then POSTed to /api/report
// (it mails wedgie@buidlguidl.com). What's in it: the page and browser, this page's last errors, and for a
// plugged-in wedgie its hello facts, the log it keeps (firmware 0.3.52+, wedgie.py log: power-ons, app
// starts, crashes, installs; no keys) and the page's own conversation with it. Works with no wedgie too.
import { esc } from "./device";
import type { Wedgie } from "../serial/wedgies";

const errors: string[] = [];
const keep = (s: string) => { errors.push(new Date().toISOString().slice(11, 19) + " " + s.slice(0, 600)); errors.splice(0, errors.length - 20); };
addEventListener("error", (e) => keep(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
addEventListener("unhandledrejection", (e) => keep("unhandled: " + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

const FACTS: (keyof Wedgie)[] = ["short", "uid", "board", "cpu", "micropython", "kind", "version", "running", "apps", "free", "ram", "chip", "state", "error"];

/** The report's text. log: the wedgie's own log (or why there's none). */
export function reportText(w?: Wedgie, log?: string) {
  const out = [`page: ${location.href}`, `when: ${new Date().toISOString()}`, `browser: ${navigator.userAgent}`, `screen: ${screen.width}x${screen.height}`];
  if (w) {
    out.push("", "== wedgie");
    for (const k of FACTS) if (w[k] !== undefined && w[k] !== "") out.push(`${k}: ${typeof w[k] === "object" ? JSON.stringify(w[k]) : w[k]}`);
    out.push("", "== its log", log || "(none)");
    out.push("", "== what the page and it said (last part)", (w.log || "").slice(-8000) || "(nothing)");
  } else out.push("", "== no wedgie plugged in");
  out.push("", "== page errors", errors.join("\n") || "(none)");
  return out.join("\n");
}

/** Open it. readLog: the wedgie's log, read by the page that holds its port. */
export function bugReport(w?: Wedgie, readLog?: () => Promise<string>) {
  const el = document.createElement("div");
  el.className = "panel-wrap";
  el.innerHTML = `<div class="card report" role="dialog" aria-label="Send a bug report">
    <h3>Send a bug report</h3>
    <p class="fine">What went wrong? We read every one.</p>
    <textarea class="recess note" rows="4" placeholder="What happened, and what you were doing"></textarea>
    <input class="recess email" type="email" placeholder="Your email, if you want an answer (optional)" autocomplete="email">
    <details><summary class="fine">What gets sent</summary><pre class="recess out log">Reading…</pre></details>
    <p class="fine said" hidden></p>
    <div class="row"><button class="btn btn-green send" disabled>Send</button><button class="btn close">Cancel</button></div>
  </div>`;
  document.body.appendChild(el);
  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const close = () => el.remove();
  $(".close").onclick = close;
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  let text = "";
  const read = w && readLog ? readLog().catch((e) => `(couldn't read it: ${e?.message || e})`) : Promise.resolve(undefined);
  read.then((log) => { text = reportText(w, log); $(".out").textContent = text; $<HTMLButtonElement>(".send").disabled = false; });
  $(".note").focus();
  $<HTMLButtonElement>(".send").onclick = async () => {
    const b = $<HTMLButtonElement>(".send"), said = $(".said");
    b.disabled = true; b.textContent = "Sending…"; said.hidden = true;
    try {
      const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: $<HTMLTextAreaElement>(".note").value, email: $<HTMLInputElement>(".email").value, report: text }) });
      const v = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(v.error || `HTTP ${r.status}`);
      el.querySelector(".report")!.innerHTML = `<h3>Sent. Thank you.</h3><p>${v.n ? `Report #${esc(String(v.n))}. ` : ""}We'll look at it.</p><div class="row"><button class="btn btn-green close">Done</button></div>`;
      $(".close").onclick = close;
    } catch (e: any) {
      said.hidden = false; said.innerHTML = `<b class="bad">Didn't send:</b> ${esc(e?.message || String(e))}`;
      b.disabled = false; b.textContent = "Send";
    }
  };
}

/** A wedgie's log over live USB (the slot lets a locked wedgie hand out its log, 0.3.52+): the older half first. */
export async function readLog(get: (path: string) => Promise<Uint8Array>) {
  const dec = new TextDecoder();
  const part = (p: string) => get(p).then((b) => dec.decode(b), () => "");
  const [a, b] = [await part("/log1.txt"), await part("/log.txt")];
  return a + b || "(no log on it: firmware older than 0.3.52, or nothing has happened yet)";
}
