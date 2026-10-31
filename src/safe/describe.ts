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

/** The calls in a MultiSend batch: operation, to, value, data each. */
export function unbatch(data: string): { operation: number; to: string; value: bigint; data: string }[] {
  const b = E.bytes(data), n = Number(BigInt(E.hex(b.slice(36, 68))));
  const p = b.slice(68, 68 + n), out = [];
  for (let o = 0; o + 85 <= p.length;) {
    const len = Number(BigInt(E.hex(p.slice(o + 53, o + 85))));
    out.push({ operation: p[o], to: E.checksum(E.hex(p.slice(o + 1, o + 21))), value: BigInt(E.hex(p.slice(o + 21, o + 53))), data: E.hex(p.slice(o + 85, o + 85 + len)) });
    o += 85 + len;
  }
  return out;
}

/** One call (to, value, data) in words. method: the name Safe's API decoded, if any. */
export function describe(t: { to: string; value: string | bigint; data?: string | null; operation?: number | string; nonce?: number | string },
  ctx: Ctx, method?: string): Said {
  const d = (t.data || "0x").slice(2).toLowerCase(), v = BigInt(t.value || 0), to = E.checksum(t.to), self = eq(to, ctx.safe);
  const s = d.slice(0, 8);
  if (!d) {
    if (self && !v) return { title: `Cancel${t.nonce !== undefined ? ` #${t.nonce}` : ""}`, kind: "cancel" };
    return { title: `Send ${amount(v, null, ctx)} to ${ctx.addr(to)}`, kind: "send" };
  }
  if (+(t.operation || 0) === 1 && s === S.multiSend) {
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
