// /api/report: a bug report from the site's "Send a bug report" (src/ui/report.ts).
//   POST {note, email?, report}   report: the text the person saw before Send (the page, the browser, and
//                                 a plugged-in wedgie's hello + its log). Kept REPORT_DAYS, mailed to the inbox.
// Spam: PER_HOUR per IP; past MAIL_PER_DAY in a day (many IPs) they're kept but not mailed (`mailed` false);
// past KEEP_PER_DAY, refused (the table stays small).
// No IP kept: ipOf (a hash) only for PER_HOUR, wiped after a day. Their email, if they gave one, goes in the mail, never the table.
// Never log a body here.
import { db as shopDb, json, oops, env, ipOf, crossSite } from "./_shop.js";
import { send } from "./_mail.js";

const REPORT_DAYS = 90, PER_HOUR = 6, MAIL_PER_DAY = 50, KEEP_PER_DAY = 1000, MAX = 60_000, NOTE_MAX = 4000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let ready: Promise<unknown> | null = null;
async function db() {
  const sql = await shopDb();
  ready ||= sql`create table if not exists reports (
      n bigserial primary key,
      note text not null,
      report text not null,
      ip text not null,               -- ipOf, for PER_HOUR
      at timestamptz not null default now())`
    .then(() => sql`alter table reports add column if not exists mailed boolean not null default false`)
    .catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  const note = String(b?.note || "").slice(0, NOTE_MAX), report = String(b?.report || ""), email = String(b?.email || "").trim();
  if (!report || report.length > MAX) return oops("Bad report.");
  if (email && (!EMAIL.test(email) || email.length > 200)) return oops("That email doesn't look right.");
  let n = 0, sql: Awaited<ReturnType<typeof db>> | null = null;
  if (env("SHOP_DATABASE_URL")) {
    sql = await db();
    const ip = await ipOf(req);
    await sql`delete from reports where at < now() - ${`${REPORT_DAYS} days`}::interval`;
    await sql`update reports set ip = '' where ip <> '' and at < now() - interval '1 day'`;   // the privacy page: a day (also _shop expireOld)
    const [r] = await sql`select count(*) filter (where ip = ${ip} and at > now() - interval '1 hour')::int as hour,
      count(*) filter (where mailed)::int as day, count(*)::int as kept from reports where at > now() - interval '1 day'`;
    if (r.hour >= PER_HOUR || r.kept >= KEEP_PER_DAY) return oops("Too many reports. Wait a bit.", 429);
    [{ n }] = await sql`insert into reports (note, report, ip, mailed) values (${note}, ${report}, ${ip}, ${r.day < MAIL_PER_DAY}) returning n`;
    if (r.day >= MAIL_PER_DAY) return json({ ok: true, n: Number(n) });     // kept, not mailed
  }
  const to = env("SHOP_MAIL_USER") || "wedgie@buidlguidl.com";
  try {
    await send(to, `wedgie bug report${n ? " #" + n : ""}${note ? ": " + note.split("\n")[0].slice(0, 60) : ""}`,
      [note || "(no note)", email ? `Reply to: ${email}` : "No email given.", report], { text: "wedgie.dev", href: "https://wedgie.dev" });
  } catch {
    if (sql) await sql`update reports set mailed = false where n = ${n}`.catch(() => {});
    if (!n) return oops("Couldn't send it. Email wedgie@buidlguidl.com instead.", 503);
  }
  return json({ ok: true, n: Number(n) });
}
