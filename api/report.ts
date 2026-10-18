// /api/report: a bug report from the site's "Send a bug report" (src/ui/report.ts).
//   POST {note, email?, report}   report: the text the person saw before Send (the page, the browser, and
//                                 a plugged-in wedgie's hello + its log). Kept REPORT_DAYS, mailed to the inbox.
// No IP kept: ipOf (a hash) only for PER_HOUR. Their email, if they gave one, goes in the mail, never the table.
// Never log a body here.
import { db as shopDb, json, oops, env, ipOf } from "./_shop.js";
import { send } from "./_mail.js";

const REPORT_DAYS = 90, PER_HOUR = 6, MAX = 60_000, NOTE_MAX = 4000;
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
    .catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

export async function POST(req: Request) {
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  const note = String(b?.note || "").slice(0, NOTE_MAX), report = String(b?.report || ""), email = String(b?.email || "").trim();
  if (!report || report.length > MAX) return oops("Bad report.");
  if (email && (!EMAIL.test(email) || email.length > 200)) return oops("That email doesn't look right.");
  let n = 0;
  if (env("SHOP_DATABASE_URL")) {
    const sql = await db(), ip = await ipOf(req);
    await sql`delete from reports where at < now() - ${`${REPORT_DAYS} days`}::interval`;
    const [r] = await sql`select count(*)::int as hour from reports where ip = ${ip} and at > now() - interval '1 hour'`;
    if (r.hour >= PER_HOUR) return oops("Too many reports. Wait a bit.", 429);
    [{ n }] = await sql`insert into reports (note, report, ip) values (${note}, ${report}, ${ip}) returning n`;
  }
  const to = env("SHOP_MAIL_USER") || "wedgie@buidlguidl.com";
  try {
    await send(to, `wedgie bug report${n ? " #" + n : ""}${note ? ": " + note.split("\n")[0].slice(0, 60) : ""}`,
      [note || "(no note)", email ? `Reply to: ${email}` : "No email given.", report], { text: "wedgie.dev", href: "https://wedgie.dev" });
  } catch {
    if (!n) return oops("Couldn't send it. Email wedgie@buidlguidl.com instead.", 503);
  }
  return json({ ok: true, n: Number(n) });
}
