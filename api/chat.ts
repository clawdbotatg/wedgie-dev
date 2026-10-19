// /api/chat: the mailbox behind /secret's chat. It holds sealed messages only (src/secret/box.ts: only the
// wedgie they're to can open one) and can't read them. A message waits here 7 days (DAYS), then it's gone.
//   POST {to, from, blob}   to, from: public keys (hex, 04 X Y); blob: a wedgie1 message sealed to `to`
//   GET ?box=<h>&after=<n>  h = sha256 of the to key's hex -> {msgs: [{n, from, blob, at}]}, oldest first
// `from` is what the sender's page says: nothing proves it (the page shows it as such). PER_HOUR posts an
// hour per IP (_shop.ts ipOf: a hash, never the IP), BOX_MAX waiting in one box. Never log a body here.
import { neon } from "@neondatabase/serverless";
import { json, oops, env, sha256, ipOf, crossSite } from "./_shop.js";

const DAYS = 7, PER_HOUR = 120, BOX_MAX = 500, BLOB_MAX = 2400;
const KEY = /^04[0-9a-f]{128}$/, BOX = /^[0-9a-f]{64}$/;

let ready: Promise<unknown> | null = null;
async function db() {
  const sql = neon(env("SHOP_DATABASE_URL"));
  ready ||= sql`create table if not exists chat (
      n bigserial primary key,
      box text not null,              -- sha256 of the to key's hex
      sender text not null,           -- the from key's hex, as the sender said
      blob text not null,             -- sealed: wedgie1.<...>
      ip text not null,               -- ipOf, for PER_HOUR
      at timestamptz not null default now())`
    .then(() => sql`create index if not exists chat_box on chat (box, n)`)
    .catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  if (!env("SHOP_DATABASE_URL")) return oops("Chat isn't open yet.", 503);
  const to = String(b?.to || "").toLowerCase(), from = String(b?.from || "").toLowerCase(), blob = String(b?.blob || "");
  if (!KEY.test(to) || !KEY.test(from)) return oops("Bad key.");
  if (!/^wedgie1\.[\w-]+$/.test(blob) || blob.length > BLOB_MAX) return oops("Bad message.");
  const sql = await db(), ip = await ipOf(req), box = await sha256(to);
  await sql`delete from chat where at < now() - ${`${DAYS} days`}::interval`;
  const [r] = await sql`select count(*) filter (where ip = ${ip} and at > now() - interval '1 hour')::int as hour,
    count(*) filter (where box = ${box})::int as waiting from chat where ip = ${ip} or box = ${box}`;
  if (r.hour >= PER_HOUR) return oops("Too many messages. Wait a bit.", 429);
  if (r.waiting >= BOX_MAX) return oops("Their mailbox is full.", 429);
  const [m] = await sql`insert into chat (box, sender, blob, ip) values (${box}, ${from}, ${blob}, ${ip}) returning n, at`;
  return json({ n: Number(m.n), at: new Date(m.at).getTime() });
}

export async function GET(req: Request) {
  const u = new URL(req.url), box = u.searchParams.get("box") || "", after = Number(u.searchParams.get("after") || 0);
  if (!BOX.test(box) || !Number.isFinite(after)) return oops("Bad request.");
  if (!env("SHOP_DATABASE_URL")) return json({ msgs: [] });
  const sql = await db();
  const rows = await sql`select n, sender, blob, at from chat where box = ${box} and n > ${after}
    and at > now() - ${`${DAYS} days`}::interval order by n limit 100`;
  return json({ msgs: rows.map((r: any) => ({ n: Number(r.n), from: r.sender, blob: r.blob, at: new Date(r.at).getTime() })) });
}
