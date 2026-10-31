// Better words for what describe.ts could only call "Call 0x…", from /api/explain (api/explain.ts):
//   1. the contract's own words (clear signing, ERC-7730), as the title and its fields under it
//   2. else 🤖: one line a model wrote after seeing a simulation. A guess, so it always shows the 🤖.
// Asked once per transaction (kept for the page's life); repaint() runs when an answer lands.
import { unbatch, type Said } from "./describe";

type Field = { label: string; value: string; address?: string };
type Told = { calls: ({ what: string; fields: Field[]; who?: string } | null)[]; bot: string | null };
type Call = { to: string; value: string | bigint; data?: string | null };

const got = new Map<string, Told | "asking" | "failed">();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Clear signing's words and who it's with: "Deposit · Steakhouse Financial". */
const words = (c: { what: string; who?: string }) => esc(c.what) + (c.who && !c.what.includes(c.who) ? ` · ${esc(c.who)}` : "");
const RELAY = "4cfab32186e65e2a39ec0e882e11380cbf2f8a2f";   // Instant Wallet's relay: a call paying it is the network fee

/** One ask per body, kept for the page's life; repaint() once it lands. */
function ask(body: object, repaint: () => void) {
  const k = JSON.stringify(body), t = got.get(k);
  if (!t) {
    got.set(k, "asking");
    fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: k })
      .then((r) => r.ok ? r.json() : Promise.reject()).then((v) => got.set(k, v), () => got.set(k, "failed")).finally(repaint);
  }
  return t;
}

/** The calls a Safe transaction makes: a MultiSend batch's, or the one. */
export const callsOf = (t: { to: string; value: string | bigint; data?: string | null; operation?: number | string }, s: Said): Call[] =>
  s.subs && +(t.operation || 0) === 1 ? unbatch(t.data!) : [t];

/** s with better words where it had none. Not known yet: s with a 🤖 … line, and repaint() once it is. */
export function explain(s: Said, calls: Call[], chain: number, safe: string, addr: (a: string) => string, repaint: () => void): Said {
  const subs = s.subs || [s], need = subs.flatMap((x, i) => x.kind === "call" ? [i] : []);
  if (!need.length || subs.length !== calls.length) return s;
  const t = ask({ chain, safe, calls: calls.map((c) => ({ to: c.to, value: String(c.value || 0), data: c.data || "0x" })), need }, repaint);
  if (!t || t === "asking") return { ...s, more: `<p class="sx-bot sx-bot-wait">🤖 …</p>` };
  if (t === "failed") return s;
  const fields = (f: Field[]) => f.length ? `<dl class="sx-dl sx-cs">${f.map((x) =>
    `<dt>${esc(x.label)}</dt><dd>${x.address ? addr(x.address) : esc(x.value)}</dd>`).join("")}</dl>` : "";
  const bot = t.bot ? `🤖 ${esc(t.bot)}` : "";
  if (!s.subs) {
    const c = t.calls[0];
    return c ? { ...s, title: words(c), more: fields(c.fields) } : bot ? { ...s, title: bot } : s;
  }
  return { ...s, subs: s.subs.map((x, i) => t.calls[i] ? { ...x, title: words(t.calls[i]!) + fields(t.calls[i]!.fields) } : x),
    more: bot ? `<p class="sx-bot">${bot}</p>` : "" };
}

/**
 * Activity: what a past transaction was for, one line (HTML). describe.ts's words, clear signing's (with who it's
 * with) where it had only "Call 0x…"; never 🤖. The relay's fee is left out, an approval too when another step follows
 * (it only feeds that step). null: nothing to say yet, or nothing it can say (the row leads with the coins).
 */
export function intent(s: Said, calls: Call[], chain: number, safe: string, usdc: string | undefined, repaint: () => void): string | null {
  const subs = s.subs || [s];
  if (subs.length !== calls.length) return s.kind === "call" ? null : s.title;
  const need = subs.flatMap((x, i) => x.kind === "call" ? [i] : []);
  const t = need.length ? ask({ chain, safe, calls: calls.map((c) => ({ to: c.to, value: String(c.value || 0), data: c.data || "0x" })), need, nobot: true }, repaint) : null;
  if (t === "asking" || (need.length && !t)) return null;
  const fee = (c: Call) => {
    const d = (c.data || "0x").toLowerCase(), to = c.to.toLowerCase().slice(2);
    if (to === RELAY) return d === "0x";
    return !!usdc && to === usdc.toLowerCase().slice(2) && d.startsWith("0xa9059cbb") && d.slice(34, 74) === RELAY;
  };
  const lines = subs.flatMap((x, i) => {
    if (fee(calls[i])) return [];
    if (x.kind !== "call") return [{ text: x.title, approve: x.kind === "approve" }];
    const c = t && t !== "failed" ? t.calls[i] : null;
    return c ? [{ text: words(c), approve: c.what === "Approve" }] : [];
  });
  const keep = lines.some((l) => !l.approve) ? lines.filter((l) => !l.approve) : lines;
  return keep.map((l) => l.text).join(" · ") || null;
}
