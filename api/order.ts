// /api/order
//   GET                                       what's open: card, usdc; extra = cents over list price right now;
//                                             left = boxes in stock (_shop.ts stockLeft); sends the price alerts once it's back down
//   POST {cart, sealed, email, pay, chain?}   a new order -> {id, token, url?} (url: Stripe Checkout); email: _mail.ts
//   POST {id, token, tx?, renew?}             its status (a USDC one: what its deposit address holds); tx: old orders only;
//                                             renew: an expired order quoted again at today's price
// A quote holds 10 minutes (catalog.ts QUOTE); then the order is 'expired'.
// The token is the buyer's: only its hash is kept. See _shop.ts for what is and isn't stored.
import { PAY_CHAINS, cartOk, cartLines } from "../src/shop/catalog.js";
import { depositOf } from "../src/shop/deposits.js";
import { EMAIL, emailHash, lock, tokenOf, mailPaid, sendAlerts } from "./_mail.js";
import { db, env, json, oops, randomHex, sha256, same, publicView, checkout, session, markPaid, endCard, usdcPaid, usdcFind, settleDeposit, extraNow, expireOld, late, rpc, ipOf, tooMany, stockLeft, boxes, soldOut, type Order, crossSite } from "./_shop.js";

const open = () => ({ card: !!env("STRIPE_SECRET_KEY"), usdc: !!env("SHOP_PAY_TO"), chains: Object.keys(PAY_CHAINS).map(Number).filter((c) => env("SHOP_RPC_" + c)) });

export async function GET(req: Request) {
  const sql = env("SHOP_DATABASE_URL") ? await db() : null;
  const extra = sql ? await extraNow(sql).catch(() => -1) : 0;
  if (sql && extra === 0 && env("SHOP_MAIL_KEY")) await sendAlerts(sql, new URL(req.url).origin, 0).catch(() => {});
  const left = sql ? Math.max(0, await stockLeft(sql).catch(() => 0)) : 0;
  return json({ ...open(), extra: Math.max(0, extra), left });
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  if (!env("SHOP_DATABASE_URL")) return oops("The shop isn't open yet.", 503);
  const sql = await db();
  const origin = new URL(req.url).origin;
  const ip = await ipOf(req);
  return b?.id ? status(sql, b, origin, ip) : create(sql, b, origin, ip);
}

async function create(sql: Awaited<ReturnType<typeof db>>, b: any, origin: string, ip: string) {
  const o = open();
  if (!cartOk(b?.cart)) return oops("Pick what you'd like.");
  if (typeof b.sealed !== "string" || !/^v1\.[A-Za-z0-9_.-]{40,4000}$/.test(b.sealed)) return oops("The address didn't come through sealed.");
  if (typeof b.email !== "string" || b.email.length > 100 || !EMAIL.test(b.email.trim())) return oops("Fill in your email.");
  const cart = { wedgie: b.cart.wedgie, kit: b.cart.kit, ...(b.cart.abroad ? { abroad: true } : {}) };
  await expireOld(sql);
  const many = await tooMany(sql, ip);
  if (many) return oops(many, 429);
  const left = await stockLeft(sql);
  if (boxes(cart) > left) return oops(soldOut(left), 409);
  const lines = cartLines(cart, await extraNow(sql));
  const cents = lines.reduce((t, l) => t + l.qty * l.cents, 0);
  const id = randomHex(6), token = await tokenOf(id), th = await sha256(token);
  const keyed = !!env("SHOP_MAIL_KEY");     // no key (dev): the order still works, it just can't be mailed or found by email
  const eh = keyed ? await emailHash(b.email) : null, ee = keyed ? await lock(b.email.trim()) : null;
  if (b.pay === "card") {
    if (!o.card) return oops("Card checkout isn't open yet.", 503);
    await sql`insert into orders (id, token_hash, cart, lines, cents, pay, sealed, ip, email_hash, email_enc) values (${id}, ${th}, ${JSON.stringify(cart)}, ${JSON.stringify(lines)}, ${cents}, 'card', ${b.sealed}, ${ip}, ${eh}, ${ee})`;
    if (await raced(sql, id)) return oops(soldOut(0), 409);
    const s = await checkout({ id, cart, lines }, origin);
    await sql`update orders set stripe_session = ${s.id} where id = ${id}`;
    return json({ id, token, url: s.url });
  }
  if (b.pay === "usdc") {
    if (!o.usdc) return oops("USDC checkout isn't open yet.", 503);
    const chain = Number(b.chain);
    if (!open().chains.includes(chain)) return oops("Pick a chain.");
    // Its own deposit address: whatever is sent there is this order's.
    const usdc = BigInt(cents) * 10_000n, deposit = depositOf(env("SHOP_PAY_TO"), id);
    await sql`insert into orders (id, token_hash, cart, lines, cents, pay, sealed, chain, usdc, deposit, ip, email_hash, email_enc) values (${id}, ${th}, ${JSON.stringify(cart)}, ${JSON.stringify(lines)}, ${cents}, 'usdc', ${b.sealed}, ${chain}, ${usdc.toString()}, ${deposit}, ${ip}, ${eh}, ${ee})`;
    if (await raced(sql, id)) return oops(soldOut(0), 409);
    return json({ id, token });
  }
  return oops("Pay by card or USDC.");
}

/** Two orders at once can take the last box: whoever finds the count below 0 after making theirs backs out. */
async function raced(sql: Awaited<ReturnType<typeof db>>, id: string) {
  if ((await stockLeft(sql)) >= 0) return false;
  await sql`delete from orders where id = ${id} and status = 'new'`;
  return true;
}

async function status(sql: Awaited<ReturnType<typeof db>>, b: any, origin: string, ip: string) {
  if (typeof b.id !== "string" || typeof b.token !== "string") return oops("Bad request.");
  const [o] = (await sql`select * from orders where id = ${b.id}`) as Order[];
  if (!o || !same(o.token_hash, await sha256(b.token))) return oops("No such order.", 404);
  let url: string | undefined, why: string | undefined;
  if ((o.status === "new" || o.status === "expired") && o.pay === "card" && o.stripe_session) {
    const s = await session(o.stripe_session);
    if (s.payment_status === "paid") { await markPaid(sql, o.id, s.id); o.status = "paid"; }
    else if (s.status === "open" && o.status === "new" && !late(o)) url = s.url || undefined;
    else if (o.status === "new") o.status = await endCard(sql, o);
  }
  let got: bigint | undefined, checking = false;
  if ((o.status === "new" || o.status === "expired") && o.pay === "usdc" && o.deposit) {
    const r = await settleDeposit(sql, o);
    got = r.got;
    if (r.paid) o.status = "paid";
    else checking = !r.sure;   // a chain didn't answer: never tell a paid buyer to pay again or requote them
  }
  let tx = o.deposit ? undefined : b.tx;
  if ((o.status === "new" || o.status === "expired") && o.pay === "usdc" && !o.deposit && !tx) tx = await usdcFind(o).catch(() => null);
  if ((o.status === "new" || o.status === "expired") && o.pay === "usdc" && tx) {
    if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return oops("That isn't a transaction hash.");
    const r = await usdcPaid(o, tx.toLowerCase());
    if (r.paid) {
      try {
        const done = await sql`update orders set status = 'paid', paid_at = now(), tx = ${tx.toLowerCase()}, payer = ${r.payer}
          where id = ${o.id} and status in ('new', 'expired') returning id`;
        if (done.length) o.status = "paid";
      } catch (e: any) {
        if (/orders_tx/.test(e?.message || "")) why = "That transaction already paid for another order.";
        else throw e;
      }
    } else why = r.why;
  }
  if (o.status === "new" && o.pay === "usdc" && late(o)) { await sql`update orders set status = 'expired' where id = ${o.id} and status = 'new'`; o.status = "expired"; }
  if (b.renew === true && o.status === "expired" && !got && !checking) {   // something sent already: its price holds
    const r = await renew(sql, o, origin, ip);
    if (typeof r === "string") return oops(r, 429);
    Object.assign(o, r.o); url = r.url; why = undefined;
  }
  if (o.status === "paid") await mailPaid(sql, o.id, origin);
  return json({ ...publicView(o, got, checking), url, why });
}

/** An expired order quoted again: today's price, a fresh 10 minutes, the same cart and sealed address. */
async function renew(sql: Awaited<ReturnType<typeof db>>, o: Order, origin: string, ip: string): Promise<string | { o: Order; url?: string }> {
  if (!o.sealed) return "That order can't be renewed: start over.";
  if (o.pay === "card" && (await endCard(sql, o)) === "paid") return { o: { ...o, status: "paid" } };   // its old checkout: paid after all, or ended
  await expireOld(sql);
  const many = await tooMany(sql, ip);
  if (many) return many;
  const left = await stockLeft(sql);
  if (boxes(o.cart) > left) return soldOut(left);
  const lines = cartLines(o.cart, await extraNow(sql));
  const cents = lines.reduce((t, l) => t + l.qty * l.cents, 0);
  if (o.pay === "card" && !open().card) return "Card checkout isn't open right now.";
  if (o.pay === "usdc" && !open().chains.includes(o.chain!)) return "USDC on that chain isn't open right now.";
  // Reserve the boxes first (status 'new' holds stock), then check nobody raced us to them; only then a checkout.
  // A USDC order keeps its deposit address (an old exact-amount order gets one now): today's price.
  const deposit = o.pay === "usdc" ? o.deposit || depositOf(env("SHOP_PAY_TO"), o.id) : null;
  const usdc = o.pay === "usdc" ? (BigInt(cents) * 10_000n).toString() : o.usdc;
  const [n] = (await sql`update orders set status = 'new', created = now(), lines = ${JSON.stringify(lines)}, cents = ${cents}, usdc = ${usdc},
    deposit = ${deposit}, stripe_session = null, ip = ${ip} where id = ${o.id} and status = 'expired' returning *`) as Order[];
  if (!n) return "Try again.";
  if ((await stockLeft(sql)) < 0) { await sql`update orders set status = 'expired' where id = ${o.id} and status = 'new'`; return soldOut(0); }
  if (o.pay === "usdc") return { o: n };
  const s = await checkout({ id: o.id, cart: o.cart, lines }, origin);
  await sql`update orders set stripe_session = ${s.id} where id = ${o.id}`;
  return { o: { ...n, stripe_session: s.id }, url: s.url };
}
