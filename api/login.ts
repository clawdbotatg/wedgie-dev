// /api/login: sign in by email to see your orders on any device.
//   POST {email}       a sign-in link (/signin#<token>) goes to that email
//   POST {link}        the link's token -> {session, until, email, orders}. Works once, 15 minutes.
//   POST {session}     -> {until, email, orders}; 401 once it's over (SESSION_DAYS) or signed out.
//                      + claim: [{id, token}] (this device's orders): ones with no email get this one (for login, and
//                      the paid/shipped mails if it hasn't shipped)
//   POST {signout}     the session ends
// orders: [{id, token, at}]; the tokens (_mail.ts tokenOf) open each order's page. One link a minute, 5 an hour,
// per email, and IP_HOUR an hour per IP (a script with a list of addresses would burn the inbox's daily quota). Only
// hashes are stored (the IP's: _shop.ts ipOf, gone with its link after a day).
import { db, json, oops, same, env, sha256, randomHex, ipOf, crossSite } from "./_shop.js";
import { EMAIL, emailHash, tokenOf, signinMail, lock, unlock } from "./_mail.js";

const SESSION_DAYS = 30, IP_HOUR = 5;
type Sql = Awaited<ReturnType<typeof db>>;

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  if (!env("SHOP_DATABASE_URL") || !env("SHOP_MAIL_KEY")) return oops("Sign in isn't open yet.", 503);
  const sql = await db();
  if (typeof b?.email === "string") return ask(sql, b.email, new URL(req.url).origin, await ipOf(req));
  if (typeof b?.link === "string") return follow(sql, b.link);
  if (typeof b?.session === "string") return mine(sql, b.session, Array.isArray(b.claim) ? b.claim.slice(0, 50) : []);
  if (typeof b?.signout === "string") { await sql`delete from sessions where token_hash = ${await sha256(b.signout)}`; return json({ ok: true }); }
  return oops("Bad request.");
}

async function ask(sql: Sql, email: string, origin: string, ip: string) {
  if (email.length > 100 || !EMAIL.test(email.trim())) return oops("That isn't an email.");
  const h = await emailHash(email);
  await sql`delete from links where created < now() - interval '1 day'`;
  const [r] = await sql`select count(*)::int as hour, count(*) filter (where created > now() - interval '1 minute')::int as minute
    from links where email_hash = ${h} and created > now() - interval '1 hour'`;
  if (r.minute) return oops("We just sent one. Wait a minute.", 429);
  if (r.hour >= 5) return oops("Too many tries. Wait an hour.", 429);
  const [n] = await sql`select count(*)::int as n from links where ip = ${ip} and created > now() - interval '1 hour'`;
  if (n.n >= IP_HOUR) return oops("Too many tries. Wait an hour.", 429);
  const token = randomHex(16);
  await sql`insert into links (token_hash, email_hash, email_enc, ip) values (${await sha256(token)}, ${h}, ${await lock(email.trim())}, ${ip})`;
  try { await signinMail(email.trim(), `${origin}/signin#${token}`); } catch { return oops("Couldn't send the email. Try again soon.", 503); }
  return json({ ok: true });
}

async function follow(sql: Sql, link: string) {
  const [l] = await sql`update links set used_at = now() where token_hash = ${await sha256(link)} and used_at is null
    and created > now() - interval '15 minutes' returning email_hash, email_enc`;
  if (!l) return oops("That link ran out. Sign in again.");
  await sql`delete from sessions where expires < now()`;
  const session = randomHex(16);
  const [s] = await sql`insert into sessions (token_hash, email_hash, email_enc, expires) values (${await sha256(session)}, ${l.email_hash},
    ${l.email_enc}, now() + ${`${SESSION_DAYS} days`}::interval) returning expires`;
  return json({ session, until: new Date(s.expires).getTime(), email: await unlock(l.email_enc), orders: await orders(sql, l.email_hash) });
}

async function mine(sql: Sql, session: string, claim: any[]) {
  const [s] = await sql`select email_hash, email_enc, expires from sessions where token_hash = ${await sha256(session)} and expires > now()`;
  if (!s || !s.email_enc) return oops("Signed out.", 401);
  for (const c of claim) if (typeof c?.id === "string" && typeof c?.token === "string")
    await sql`update orders set email_hash = ${s.email_hash},
      email_enc = case when status in ('new', 'paid') then ${s.email_enc} else email_enc end
      where id = ${c.id} and token_hash = ${await sha256(c.token)} and email_hash is null`;
  return json({ until: new Date(s.expires).getTime(), email: await unlock(s.email_enc), orders: await orders(sql, s.email_hash) });
}

async function orders(sql: Sql, h: string) {
  const rows = await sql`select id, token_hash, created from orders where email_hash = ${h} order by created desc`;
  const out = [];
  for (const o of rows) {
    const token = await tokenOf(o.id);
    if (same(o.token_hash, await sha256(token))) out.push({ id: o.id, token, at: new Date(o.created).getTime() });
  }
  return out;
}
