// /api/admin: the shipping computer's door (wedgie-shipping orders.py on omen), Bearer SHOP_ADMIN_TOKEN.
//   GET                          every paid, unshipped order with its sealed address (only omen can open it)
//   POST {id, tracking}          shipped: the sealed address, payer, transaction and Stripe session are wiped, the buyer
//                                gets an email with the tracking number, and only once it's sent is their locked email
//                                wiped (mailed: false = it failed; the same POST again retries it)
//   POST {id, cancel: true}      canceled (refund by hand), wiped the same way; new, paid or expired
//   GET ?funnel=1                the checkout counts (api/count.ts) and orders by pay and status, last `days` (30); every canceled order
//   POST {stock: n, item?}       n left to sell from now on (_shop.ts stockLeft); item wedgie or kit, none = both; 0 = sold out
//   GET ?moving=1                shipped orders not delivered yet, 60 days back: {id, tracking, shipped_at, moving_at} (orders.py track)
//   POST {id, step, at}          step "moving" or "delivered" (the buyer's order page shows it), at = when USPS said so.
//                                Only the step and its time: never a place
// Each GET also marks paid the USDC orders made in the last 3 days, or with something sent, whose deposit address now
// holds their price (older empty ones settle when their buyer opens the order page), and deletes what's done with: shipped or canceled orders and
// unpaid or expired ones with nothing sent, 30 days on. GET ?stock=1: just the stock counts, {left: {wedgie, kit}}.
import { db, env, json, oops, same, settleDeposit, stockLeft, STOCK_ROW, endCard, type Order, crossSite } from "./_shop.js";
import type { Item } from "../src/shop/catalog.js";
import { unlock, shippedMail, mailPaid, sendAlerts } from "./_mail.js";

const allowed = (req: Request) => {
  const t = env("SHOP_ADMIN_TOKEN");
  return t.length >= 32 && same(req.headers.get("authorization") || "", "Bearer " + t);
};

export async function GET(req: Request) {
  if (!allowed(req)) return oops("no", 401);
  const sql = await db();
  const q = new URL(req.url).searchParams;
  if (env("SHOP_MAIL_KEY")) await sendAlerts(sql, new URL(req.url).origin).catch(() => {});   // omen's timer: alerts go out even on a quiet site
  if (q.get("funnel")) {
    const days = Math.max(1, Math.min(365, Number(q.get("days")) || 30));
    const counts = await sql`select day::text, k, n from counts where day > current_date - ${days}::int order by day, k`;
    const orders = await sql`select pay, status, count(*)::int as n from orders where created > now() - ${days + " days"}::interval group by pay, status order by pay, status`;
    const canceled = await sql`select id, pay, cents, cart, created, paid_at, shipped_at as canceled_at from orders where status = 'canceled' order by created`;
    return json({ days, counts, orders, canceled });
  }
  if (q.get("stock")) return json({ left: await stockLeft(sql) });
  if (q.get("moving")) return json({ orders: await sql`select id, tracking, shipped_at, moving_at from orders
    where status = 'shipped' and tracking is not null and delivered_at is null and shipped_at > now() - interval '60 days' order by shipped_at` });
  // The shipped boxes deleted here come off the stock count too, so stockLeft doesn't forget them and hand them out again.
  // And they're tallied (counts "shipped_gone"), so api/stats.ts keeps an all-time shipped count.
  await sql`with gone as (delete from orders where (status in ('shipped', 'canceled') and coalesce(shipped_at, paid_at, created) < now() - interval '30 days')
    or (status in ('new', 'expired') and coalesce(got, 0) = 0 and created < now() - interval '30 days') returning cart, status, paid_at),
    tally as (insert into counts (day, k, n) select current_date, 'shipped_gone', count(*)::int from gone where status = 'shipped'
      having count(*) > 0 on conflict (day, k) do update set n = counts.n + excluded.n)
    update stock set n = n - coalesce((select sum(coalesce((cart->>(case stock.id when ${STOCK_ROW.wedgie} then 'wedgie' else 'kit' end))::int, 0)) from gone
      where status = 'shipped' and paid_at >= stock.set_at), 0)::int where id in (${STOCK_ROW.wedgie}, ${STOCK_ROW.kit})`;
  // USDC sent to an order's deposit address after its buyer left the page still pays it
  const open = (await sql`select * from orders where pay = 'usdc' and deposit is not null and status in ('new', 'expired')
    and (created > now() - interval '3 days' or got > 0)`) as Order[];
  await Promise.all(open.map(async (o) => {
    const r = await settleDeposit(sql, o).catch(() => null);
    if (r?.paid) await mailPaid(sql, o.id, new URL(req.url).origin).catch(() => {});
  }));
  const orders = await sql`select id, cart, cents, pay, chain, sealed, paid_at, created from orders where status = 'paid' order by paid_at`;
  return json({ orders, left: await stockLeft(sql) });
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  if (!allowed(req)) return oops("no", 401);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  const sql = await db();
  if (b?.stock !== undefined) {
    if (!Number.isInteger(b.stock) || b.stock < 0 || b.stock > 10000) return oops("Stock is a whole number, 0 or more.");
    if (b.item !== undefined && !(b.item in STOCK_ROW)) return oops("item is wedgie or kit.");
    for (const k of (b.item ? [b.item] : Object.keys(STOCK_ROW)) as Item[])
      await sql`insert into stock (id, n, set_at) values (${STOCK_ROW[k]}, ${b.stock}, now()) on conflict (id) do update set n = excluded.n, set_at = excluded.set_at`;
    return json({ ok: true, left: await stockLeft(sql) });
  }
  if (typeof b?.id !== "string") return oops("Which order?");
  if (b.step !== undefined) {
    const at = typeof b.at === "string" ? new Date(b.at) : new Date(NaN);
    if (b.step !== "moving" && b.step !== "delivered") return oops("step is moving or delivered.");
    if (isNaN(+at) || +at > Date.now() + 864e5) return oops("at is a time, not in the future.");
    // Delivered means it moved too; a step seen twice keeps its first time.
    const r = b.step === "delivered"
      ? await sql`update orders set delivered_at = coalesce(delivered_at, ${at.toISOString()}), moving_at = coalesce(moving_at, ${at.toISOString()}) where id = ${b.id} and status = 'shipped' returning id`
      : await sql`update orders set moving_at = coalesce(moving_at, ${at.toISOString()}) where id = ${b.id} and status = 'shipped' returning id`;
    return r.length ? json({ ok: true }) : oops("No shipped order with that id.", 404);
  }
  if (b.cancel === true) {
    // An open card checkout is ended first, so Stripe can't take money for a canceled order.
    const [c] = (await sql`select id, stripe_session from orders where id = ${b.id} and status = 'new' and pay = 'card'`) as Order[];
    if (c && (await endCard(sql, c).catch(() => "new")) === "new") return oops("Stripe didn't end its checkout. Try again.", 502);
    const r = await sql`update orders set status = 'canceled', shipped_at = now(), sealed = null, email_enc = null, payer = null, tx = null, stripe_session = null
      where id = ${b.id} and status in ('new', 'paid', 'expired') returning id`;
    return r.length ? json({ ok: true }) : oops("No open order with that id.", 404);
  }
  if (typeof b.tracking !== "string" || !/^[A-Z0-9]{10,40}$/i.test(b.tracking.replace(/\s/g, ""))) return oops("That isn't a tracking number.");
  const tracking = b.tracking.replace(/\s/g, "");
  const r = await sql`update orders set status = 'shipped', shipped_at = now(), tracking = ${tracking},
    sealed = null, payer = null, tx = null, stripe_session = null where id = ${b.id} and status = 'paid' returning email_enc`;
  // Already shipped with its email still locked here: the mail failed last time, so this is the retry.
  const [o] = r.length ? r : await sql`select email_enc from orders where id = ${b.id} and status = 'shipped' and tracking = ${tracking} and email_enc is not null`;
  if (!o) return oops("No paid, unshipped order with that id.", 404);
  if (!o.email_enc) return json({ ok: true, mailed: false, noEmail: true });
  try { await shippedMail(await unlock(o.email_enc), b.id, tracking, new URL(req.url).origin); }
  catch { return json({ ok: true, mailed: false }); }
  await sql`update orders set email_enc = null where id = ${b.id} and status = 'shipped'`;
  return json({ ok: true, mailed: true });
}
