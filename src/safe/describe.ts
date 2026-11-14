// A Safe transaction in plain words: "Send 100 USDC to bob.eth", "Add owner 0x12…, then 2 of 3 sign",
// "Cancel #4". What it can't read it says so ("Call 0x12…"), and what changes how the Safe works is marked
// danger. Used by the queue, the Execute dock and Activity (src/pages/safe.ts).
import * as E from "./eth";
import type { Mark } from "clear-signing-safe-kit";

export type Token = { symbol: string; decimals: number };
export type Said = { title: string; kind: "send" | "approve" | "owners" | "cancel" | "batch" | "call" | "danger"; subs?: Said[];
  more?: string;     // more: HTML under the title (src/safe/explain.ts)
  src?: Mark };      // where the words came from (clear-signing-safe-kit MARKS); unset: describe.ts itself (markOf)
export type Ctx = {
  safe: string;
  addr: (a: string) => string;           // an address as HTML (the address component)
  token: (a: string) => Token | null;    // what's known about a token contract, or null (yet)
  owners: number;                        // how many owners the Safe has now
  native?: string;                       // the chain's coin (ETH, POL, …)
  past?: boolean;                        // history: today's owner count says nothing about then
  price?: (token: string | null) => number | null;   // a coin's dollar price, when already in hand (not for history)
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const sel = (sig: string) => E.selector(sig).slice(2);
const S = {
  transfer: sel("transfer(address,uint256)"), approve: sel("approve(address,uint256)"), transferFrom: sel("transferFrom(address,address,uint256)"),
  addOwner: sel("addOwnerWithThreshold(address,uint256)"), removeOwner: sel("removeOwner(address,address,uint256)"),
  swapOwner: sel("swapOwner(address,address,address)"), threshold: sel("changeThreshold(uint256)"), multiSend: sel("multiSend(bytes)"),
  enableModule: sel("enableModule(address)"), disableModule: sel("disableModule(address,address)"), setGuard: sel("setGuard(address)"),
  setFallback: sel("setFallbackHandler(address)"),
};
const MAX = 2n ** 256n - 1n;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (d: string, i: number) => d.slice(8 + 64 * i, 8 + 64 * (i + 1));
const wAddr = (d: string, i: number) => E.checksum("0x" + word(d, i).slice(24));
const wNum = (d: string, i: number) => BigInt("0x" + (word(d, i) || "0"));

/** How much of a token, in its own units when it's known ("100 USDC"), else raw. */
export function amount(v: bigint, token: string | null, ctx: Ctx) {
  const p = ctx.past ? null : ctx.price?.(token) ?? null;
  const inUsd = (d: number) => p !== null ? ` <span class="fine">(${dollars(Number(v) / 10 ** d * p)})</span>` : "";
  if (!token) return `${E.fmt(v, 18, 6)} ${esc(ctx.native || "ETH")}${inUsd(18)}`;
  const t = ctx.token(token);
  return t ? `${E.fmt(v, t.decimals, Math.min(6, t.decimals))} ${esc(t.symbol)}${inUsd(t.decimals)}` : `${v} of token ${ctx.addr(token)}`;
}
const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });

/** Safe's MultiSend contracts (1.3.0 and 1.4.1, both deployments), lowercase: the wedgie's own list (wedgie-safe
 * safe_read.py MULTISEND; tools/test_describe.mjs checks they're the same). A batch is a DELEGATECALL to one of these.
 * A DELEGATECALL anywhere else runs that contract's code as the Safe, whatever its data looks like (audit 11-13). */
export const MULTISENDS = ["0x9641d764fc13c8b624c04430c7356c1c7c8102e2", "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526",
  "0x40a2accbd92bca938b02010e17a5b8929b49130d", "0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b",
  "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761", "0x998739bfdaadde7c933b942a68053933098f9eda"];

/** The calls in a multiSend(bytes) calldata: operation, to, value, data each. Throws on anything that isn't a batch
 * written the one way they're always written: MultiSend follows the offset word, so calls read from a fixed place
 * could be a decoy while the chain runs the ones further on (audit 11-13). The offset is 0x20, the length exactly
 * what's there, the padding zeros, each call whole, each operation 0 or 1, never empty. */
export function unbatch(data: string): { operation: number; to: string; value: bigint; data: string }[] {
  const b = E.bytes(data);
  if (b.length < 68 || E.hex(b.slice(0, 4)) !== "0x" + S.multiSend) throw new Error("not a multiSend");
  if (BigInt(E.hex(b.slice(4, 36))) !== 32n) throw new Error("offset");
  const size = BigInt(E.hex(b.slice(36, 68)));
  if (size > BigInt(b.length)) throw new Error("length");
  const n = Number(size);
  if (b.length !== 68 + Math.ceil(n / 32) * 32) throw new Error("length");
  for (let i = 68 + n; i < b.length; i++) if (b[i]) throw new Error("padding");
  const p = b.slice(68, 68 + n), out = [];
  let o = 0;
  while (o < n) {
    if (o + 85 > n) throw new Error("short call");
    const len = BigInt(E.hex(p.slice(o + 53, o + 85)));
    if (p[o] > 1 || len > BigInt(n) || o + 85 + Number(len) > n) throw new Error("bad call");
    out.push({ operation: p[o], to: E.checksum(E.hex(p.slice(o + 1, o + 21))), value: BigInt(E.hex(p.slice(o + 21, o + 53))), data: E.hex(p.slice(o + 85, o + 85 + Number(len))) });
    o += 85 + Number(len);
  }
  if (!out.length) throw new Error("empty");
  return out;
}

/** One call (to, value, data) in words. method: the name Safe's API decoded, if any. */
export function describe(t: { to: string; value: string | bigint; data?: string | null; operation?: number | string; nonce?: number | string },
  ctx: Ctx, method?: string): Said {
  const d = (t.data || "0x").slice(2).toLowerCase(), v = BigInt(t.value || 0), to = E.checksum(t.to), self = eq(to, ctx.safe);
  const s = d.slice(0, 8);
  if (!d) {
    if (self && !v) return { title: `Cancel${t.nonce !== undefined ? ` #${String(t.nonce).replace(/\D/g, "")}` : ""}`, kind: "cancel" };
    return { title: `Send ${amount(v, null, ctx)} to ${ctx.addr(to)}`, kind: "send" };
  }
  if (+(t.operation || 0) === 1 && s === S.multiSend && MULTISENDS.includes(to.toLowerCase())) {
    try {
      const subs = unbatch(t.data!).map((c) => c.operation === 1 ? { title: `Delegate call to ${ctx.addr(c.to)}`, kind: "danger" as const } : describe(c, ctx));
      return { title: `${subs.length} actions in one`, kind: subs.some((x) => x.kind === "danger") ? "danger" : "batch", subs };
    } catch { return { title: `A batch the page can't read`, kind: "danger" }; }
  }
  if (+(t.operation || 0) === 1) return { title: `Delegate call to ${ctx.addr(to)}: it can do anything to the Safe`, kind: "danger" };
  const extra = v ? ` with ${amount(v, null, ctx)}` : "";
  const of = (n: number) => ctx.past ? "" : ` of ${n}`;
  if (self) {
    if (s === S.addOwner) return { title: `Add owner ${ctx.addr(wAddr(d, 0))}, then ${wNum(d, 1)}${of(ctx.owners + 1)} sign`, kind: "owners" };
    if (s === S.removeOwner) return { title: `Remove owner ${ctx.addr(wAddr(d, 1))}, then ${wNum(d, 2)}${of(Math.max(1, ctx.owners - 1))} sign`, kind: "owners" };
    if (s === S.swapOwner) return { title: `Replace owner ${ctx.addr(wAddr(d, 1))} with ${ctx.addr(wAddr(d, 2))}`, kind: "owners" };
    if (s === S.threshold) return { title: `${wNum(d, 0)}${of(ctx.owners)} must sign`, kind: "owners" };
    if (s === S.enableModule) return { title: `Add module ${ctx.addr(wAddr(d, 0))}: it can move everything without the owners`, kind: "danger" };
    if (s === S.disableModule) return { title: `Remove module ${ctx.addr(wAddr(d, 1))}`, kind: "owners" };
    if (s === S.setGuard) return { title: `Set a guard ${ctx.addr(wAddr(d, 0))}: it can block every transaction`, kind: "danger" };
    if (s === S.setFallback) return { title: `Change the fallback handler to ${ctx.addr(wAddr(d, 0))}`, kind: "danger" };
  }
  if (s === S.transfer && d.length >= 136) return { title: `Send ${amount(wNum(d, 1), to, ctx)} to ${ctx.addr(wAddr(d, 0))}${extra}`, kind: "send" };
  if (s === S.transferFrom && d.length >= 200) return { title: `Move ${amount(wNum(d, 2), to, ctx)} from ${ctx.addr(wAddr(d, 0))} to ${ctx.addr(wAddr(d, 1))}${extra}`, kind: "send" };
  if (s === S.approve && d.length >= 136) {
    const n = wNum(d, 1), what = ctx.token(to)?.symbol;
    return { title: n === 0n ? `Stop ${ctx.addr(wAddr(d, 0))} spending ${what ? esc(what) : "a token"}`
      : `Let ${ctx.addr(wAddr(d, 0))} spend ${n >= MAX / 2n ? `all your ${what ? esc(what) : "tokens"}` : amount(n, to, ctx)}${extra}`, kind: "approve" };
  }
  return { title: `${method ? `${esc(method)} on` : "Call"} ${ctx.addr(to)}${extra}`, kind: "call" };
}
