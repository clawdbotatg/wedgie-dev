// /api/stripe: Stripe's webhook. A paid Checkout marks its order paid. (The order page also asks Stripe
// directly, so a missed webhook only delays the "paid" until the buyer looks.)
// Stripe dashboard -> Developers -> Webhooks: https://wedgie.dev/api/stripe, events
// checkout.session.completed and checkout.session.async_payment_succeeded; its secret is STRIPE_WEBHOOK_SECRET.
import { db, env, hmac, same, json, oops, markPaid, siteOf } from "./_shop.js";
import { mailPaid } from "./_mail.js";

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") || "";
  const t = /(?:^|,)t=(\d+)/.exec(sig)?.[1];
  const v1s = [...sig.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map((m) => m[1]);
  if (!t || !env("STRIPE_WEBHOOK_SECRET") || Math.abs(Date.now() / 1000 - Number(t)) > 300) return oops("bad signature", 400);
  const want = await hmac(env("STRIPE_WEBHOOK_SECRET"), `${t}.${raw}`);
  if (!v1s.some((v) => same(v, want))) return oops("bad signature", 400);
  const ev = JSON.parse(raw);
  const s = ev?.data?.object;
  if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded")
    && s?.payment_status === "paid" && s?.metadata?.order) {
    const sql = await db();
    await markPaid(sql, s.metadata.order, s.id);
    await mailPaid(sql, s.metadata.order, siteOf(req));
  }
  return json({ ok: true });
}
