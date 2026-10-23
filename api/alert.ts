// /api/alert: "email me when it's $67 again" (src/shop/why.ts).
//   POST {email}   one mail the next time the surge is gone (_mail.ts sendAlerts), then the row is deleted
// Kept like a buyer's email: a keyed hash (one alert per email) and a locked copy, never in clear. IP_HOUR an hour
// per IP (ipOf, a hash; wiped after a day).
import { db, json, oops, env, ipOf, crossSite, extraNow } from "./_shop.js";
import { EMAIL, emailHash, lock } from "./_mail.js";
import { ITEMS } from "../src/shop/catalog.js";

const IP_HOUR = 5;

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  if (!env("SHOP_DATABASE_URL") || !env("SHOP_MAIL_KEY")) return oops("Alerts aren't open yet.", 503);
  const email = typeof b?.email === "string" ? b.email.trim() : "";
  if (email.length > 100 || !EMAIL.test(email)) return oops("That isn't an email.");
  const sql = await db(), ip = await ipOf(req);
  if ((await extraNow(sql)) === 0) return oops(`It's ${"$" + ITEMS.wedgie.cents / 100} right now.`);
  await sql`update alerts set ip = null where ip is not null and created < now() - interval '1 day'`;
  const [n] = await sql`select count(*)::int as n from alerts where ip = ${ip} and created > now() - interval '1 hour'`;
  if (n.n >= IP_HOUR) return oops("Too many tries. Wait an hour.", 429);
  await sql`insert into alerts (email_hash, email_enc, ip) values (${await emailHash(email)}, ${await lock(email)}, ${ip})
    on conflict (email_hash) do update set email_enc = excluded.email_enc`;
  return json({ ok: true });
}
