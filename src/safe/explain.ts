// Better words for what describe.ts could only call "Call 0x…", from /api/explain (api/explain.ts):
//   1. the contract's own words (clear signing, ERC-7730), as the title and its fields under it
//   2. else 🤖: one line a model wrote after seeing a simulation. A guess, so it always shows the 🤖.
// Asked once per transaction (kept for the page's life); repaint() runs when an answer lands.
import { unbatch, type Said } from "./describe";

type Field = { label: string; value: string; address?: string };
type Told = { calls: ({ what: string; fields: Field[] } | null)[]; bot: string | null };
type Call = { to: string; value: string | bigint; data?: string | null };

const got = new Map<string, Told | "asking" | "failed">();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The calls a Safe transaction makes: a MultiSend batch's, or the one. */
export const callsOf = (t: { to: string; value: string | bigint; data?: string | null; operation?: number | string }, s: Said): Call[] =>
  s.subs && +(t.operation || 0) === 1 ? unbatch(t.data!) : [t];

/** s with better words where it had none. Not known yet: s with a 🤖 … line, and repaint() once it is. */
export function explain(s: Said, calls: Call[], chain: number, safe: string, addr: (a: string) => string, repaint: () => void): Said {
  const subs = s.subs || [s], need = subs.flatMap((x, i) => x.kind === "call" ? [i] : []);
  if (!need.length || subs.length !== calls.length) return s;
  const body = { chain, safe, calls: calls.map((c) => ({ to: c.to, value: String(c.value || 0), data: c.data || "0x" })), need };
  const k = JSON.stringify(body), t = got.get(k);
  if (!t) {
    got.set(k, "asking");
    fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: k })
      .then((r) => r.ok ? r.json() : Promise.reject()).then((v) => got.set(k, v), () => got.set(k, "failed")).finally(repaint);
  }
  if (!t || t === "asking") return { ...s, more: `<p class="sx-bot sx-bot-wait">🤖 …</p>` };
  if (t === "failed") return s;
  const fields = (f: Field[]) => f.length ? `<dl class="sx-dl sx-cs">${f.map((x) =>
    `<dt>${esc(x.label)}</dt><dd>${x.address ? addr(x.address) : esc(x.value)}</dd>`).join("")}</dl>` : "";
  const bot = t.bot ? `🤖 ${esc(t.bot)}` : "";
  if (!s.subs) {
    const c = t.calls[0];
    return c ? { ...s, title: esc(c.what), more: fields(c.fields) } : bot ? { ...s, title: bot } : s;
  }
  return { ...s, subs: s.subs.map((x, i) => t.calls[i] ? { ...x, title: esc(t.calls[i]!.what) + fields(t.calls[i]!.fields) } : x),
    more: bot ? `<p class="sx-bot">${bot}</p>` : "" };
}
