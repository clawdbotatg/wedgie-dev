// /api/telegram: the gate to the wedgie Telegram group (wedgie.dev/telegram, bot/telegram.mjs).
//   POST {t, proof}   t: the bot's link token "<telegram id>.<expires>.<hmac>"; proof: Safe Signer's safe_proof for
//                     TEXT with t as its code (_prove.ts). Checks out: a one-person invite, sent by the bot too.
//   GET ?member=<id>  (Authorization: Bearer TELEGRAM_GATE_SECRET) the bot asking: did this account prove a chip?
// One chip, one account: we keep the SHA-256 of its certificate and the Telegram id it let in. Nothing else.
// Env: TELEGRAM_GATE_BOT_TOKEN, TELEGRAM_GATE_SECRET (shared with the bot), TELEGRAM_GATE_CHAT, SHOP_DATABASE_URL.
import { neon } from "@neondatabase/serverless";
import { checkProof } from "./_prove.js";
import { env, json, oops, crossSite, hmac, same } from "./_shop.js";

// What the wedgie shows and signs, with the bot's link token as the code: a proof is good for one account, one hour.
const TEXT = "Join Telegram";

let ready: Promise<unknown> | null = null;
async function db() {
  const sql = neon(env("SHOP_DATABASE_URL"));
  ready ||= sql`create table if not exists tg_members (chip text primary key, tg_id bigint not null, at timestamptz not null default now())`;
  await ready;
  return sql;
}

const tg = async (method: string, body: unknown) => {
  const r = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_GATE_BOT_TOKEN")}/${method}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || method);
  return d.result;
};

/** The Telegram id a link token is for, or null (forged, expired). */
async function who(t: string) {
  const [id, exp, sig] = String(t || "").split(".");
  if (!/^\d+$/.test(id) || !/^\d+$/.test(exp) || +exp < Date.now() / 1000) return null;
  return same(sig || "", (await hmac(env("TELEGRAM_GATE_SECRET"), `${id}.${exp}`)).slice(0, 32)) ? id : null;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!env("TELEGRAM_GATE_SECRET") || !same(auth, `Bearer ${env("TELEGRAM_GATE_SECRET")}`)) return oops("No.", 403);
  const id = new URL(req.url).searchParams.get("member") || "";
  if (!/^\d+$/.test(id)) return oops("member=<telegram id>");
  const sql = await db();
  return json({ member: (await sql`select 1 from tg_members where tg_id = ${id}`).length > 0 });
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  let body: any;
  try { body = await req.json(); } catch { return oops("Bad request."); }
  const id = await who(body?.t);
  if (!id) return oops("Link expired. Message @wedgiechatbot for a new one.", 401);
  let chip;
  try { chip = await checkProof(body?.proof, TEXT, body.t); } catch (e: any) { return oops(`Didn't check out: ${e?.message || e}`); }
  const sql = await db();
  await sql`insert into tg_members (chip, tg_id) values (${chip}, ${id}) on conflict (chip) do nothing`;
  const [row] = await sql`select tg_id from tg_members where chip = ${chip}`;
  if (String(row.tg_id) !== id) return oops("This wedgie already let in another account.", 409);
  const link = (await tg("createChatInviteLink", { chat_id: env("TELEGRAM_GATE_CHAT"), member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600, name: `wedgie ${id}` })).invite_link;
  await tg("sendMessage", { chat_id: id, text: `You're in: ${link}` }).catch(() => {});
  return json({ link });
}
