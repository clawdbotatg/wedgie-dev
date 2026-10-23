// Checkout counts: how many reach each step, and which error they hit. A number per day per key, nothing else:
// no cookie, no IP, no id, never what anyone typed. Only keys from this list are kept (api/count.ts).
// Read them: node tools/funnel.mjs. Counting can't break checkout: it never waits and never throws.

export const STEPS = [
  "view",         // opened /order
  "cart",         // changed how many
  "form",         // started the address
  "tap-card", "tap-usdc",      // tapped a pay button
  "made-card", "made-usdc",    // the order was made (card: off to Stripe)
  "wallet",       // tapped "Pay with this browser's wallet"
  "expired",      // saw "Time ran out"
  "renew",        // tapped Refresh price
  "why-price", "why-time", "why-pay", "why-looking",   // the "Why not?" answer on an expired order
] as const;

// Error messages (ours, or a wallet's) -> a short name. First match wins; anything else is "other".
const ERRS: [string, RegExp][] = [
  ["fill-name", /^Fill in your name/], ["fill-street", /^Fill in your street/], ["fill-city", /^Fill in your city/],
  ["fill-state", /^Fill in your state/], ["fill-zip", /ZIP/], ["fill-email", /^Fill in your email/],
  ["pick", /^Pick (at least one|what)/], ["only-left", /^Only \d+ .*(left|in stock)/], ["max", /^Up to \d+ per order/],
  ["sold-out", /sold out|took the last one/i], ["too-many", /orders waiting to be paid/], ["sealed", /sealed/],
  ["closed", /isn't open|didn't answer/], ["no-wallet", /^No wallet/], ["wallet-no", /reject|denied|cancel/i],
  ["not-tx", /transaction hash|already paid for another/], ["renew", /renewed|Try again/],
];
export const errKey = (msg: string) => "err-" + (ERRS.find(([, r]) => r.test(msg))?.[0] || "other");
export const KEYS = new Set<string>([...STEPS, ...ERRS.map(([k]) => "err-" + k), "err-other"]);

const sent = new Set<string>();
/** Count k once per page load. Fire and forget. */
export function count(k: string) {
  try {
    if (sent.has(k) || !KEYS.has(k)) return;
    sent.add(k);
    navigator.sendBeacon?.("/api/count", k);
  } catch {}
}
