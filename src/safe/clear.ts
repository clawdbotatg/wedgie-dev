// Clear signing: the ERC-7730 descriptors and tokens a Safe transaction calls, picked from /clear/<tag>/ (made by
// wire/release.py from the public registry) into the bundle the wedgie's Safe Signer checks and shows
// (clawdbotatg/wedgie-safe safe_7730.py). The page only chooses what to send: every structure carries its own Merkle
// proof to a root built into the app, so leaving one out is all a page could do wrong (the wedgie then says it
// can't read the call). The bundle is the wire format's eth-sign-request keys 8 (tokens) and 13 (descriptors).

export const CLEAR_MAX = 6000;          // bytes: what Safe Signer takes (its CLEAR_MAX)
const MULTISEND = "8d80ff0a";
const files = new Map<string, Promise<Record<string, string> | null>>();

type Load = (path: string) => Promise<Record<string, string> | null>;
const fromSite: Load = (p) => fetch(`/clear/${p}.json`).then((r) => r.ok ? r.json() : null).catch(() => null);
let load = fromSite;
/** Where the files come from (tests: the disk). */
export const loadFrom = (l: Load) => { load = l; files.clear(); };

function file(tag: string, chain: number, name: string) {
  const k = `${tag}/${chain}/${name}`;
  if (!files.has(k)) files.set(k, load(k));
  return files.get(k)!;
}

/** The calls in a MultiSend batch (its calldata, hex without 0x): operation, to, data each (describe.ts's unbatch, kept here so
 *  the chip test can load this file in Node). */
function unbatch(hex: string) {
  const n = parseInt(hex.slice(72, 136), 16) * 2, p = hex.slice(136, 136 + n), out = [];
  for (let o = 0; o + 170 <= p.length;) {
    const len = parseInt(p.slice(o + 106, o + 170), 16) * 2;
    out.push({ operation: parseInt(p.slice(o, o + 2), 16), to: "0x" + p.slice(o + 2, o + 42), data: p.slice(o + 170, o + 170 + len) });
    o += 170 + len;
  }
  return out;
}

/** Every 20-byte word the calldata holds the way ABI holds an address (12 zero bytes, then 20), lowercase hex. */
function addresses(hex: string) {
  const out = new Set<string>();
  for (let i = 8; i + 64 <= hex.length; i += 2) if (/^0{24}/.test(hex.slice(i, i + 24))) out.add(hex.slice(i + 24, i + 64));
  return out;
}

const head = (n: number) => n < 24 ? (0x80 + n).toString(16) : n < 256 ? "98" + n.toString(16).padStart(2, "0") : "99" + n.toString(16).padStart(4, "0");

/**
 * The bundle for a Safe tx (hex, no 0x), or null when the registry has nothing for any call in it. tag: the data the
 * wedgie's app trusts (its hello's safe_clear).
 */
export async function bundle(tag: string, chain: number, t: { to: string; data?: string | null; operation?: number | string }) {
  const data = (t.data || "0x").slice(2).toLowerCase();
  const calls = +(t.operation || 0) === 1 && data.startsWith(MULTISEND)
    ? unbatch(data).filter((c) => c.operation === 0)
    : [{ to: t.to, data }];
  const top: string[] = [], inner: string[] = [], seen = new Set<string>();
  for (const c of calls) {
    if (c.data.length < 8) continue;
    const to = c.to.toLowerCase().slice(2), f = await file(tag, chain, "0x" + to);
    const d = f?.["0x" + c.data.slice(0, 8)];
    if (d && !seen.has(d)) { seen.add(d); top.push(d); }
    // a call inside the call (multicall, permitAndCall, a Safe setup): any contract the calldata names, or this one
    // (a multicall into itself), whose selector the calldata carries
    for (const a of new Set([to, ...addresses(c.data)])) {
      const g = await file(tag, chain, "0x" + a);
      if (!g) continue;
      for (const [sel, s] of Object.entries(g)) if (!seen.has(s) && c.data.slice(8).includes(sel.slice(2))) { seen.add(s); inner.push(s); }
    }
  }
  if (!top.length && !inner.length) return null;
  // the tokens the calldata or a descriptor names (a constant token is only in the descriptor)
  const toks = await file(tag, chain, "tokens");
  const named = (calls.map((c) => c.data).join("") + top.join("") + inner.join("")).toLowerCase();
  const tk = Object.entries(toks || {}).filter(([a]) => named.includes(a.slice(2))).map(([, s]) => s);
  // as much as fits, most needed first: the calls' own descriptors, the tokens, then the calls inside
  let size = 8;
  const take = (l: string[]) => l.filter((s) => (size + s.length / 2 <= CLEAR_MAX) && (size += s.length / 2, true));
  const d = take(top), k = take(tk), i = take(inner);
  if (!d.length && !i.length) return null;
  return "a2" + "08" + head(k.length) + k.join("") + "0d" + head(d.length + i.length) + d.join("") + i.join("");
}
