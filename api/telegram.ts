// /api/telegram: the gate to the wedgie Telegram group (wedgie.dev/telegram, bot/telegram.mjs).
//   POST {t, proof}   t: the bot's link token "<telegram id>.<expires>.<hmac>"; proof: a wedgie's {"type":"chip"}
//                     answer. A Trust M that traces to Infineon gets a one-person invite, sent by the bot too.
//   GET ?member=<id>  (Authorization: Bearer TELEGRAM_GATE_SECRET) the bot asking: did this account prove a chip?
// One chip, one account: we keep the SHA-256 of its certificate and the Telegram id it let in. Nothing else.
// Env: TELEGRAM_GATE_BOT_TOKEN, TELEGRAM_GATE_SECRET (shared with the bot), TELEGRAM_GATE_CHAT, SHOP_DATABASE_URL.
import { neon } from "@neondatabase/serverless";
import { checkChip, trustmCert } from "../src/serial/chipcheck.js";
import { env, json, oops, crossSite, hmac, same } from "./_shop.js";

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
  const d = body?.proof;
  if (d?.kind !== "trustm") return oops(d?.kind === "atecc" ? "Needs a Trust M chip." : "No Trust M chip found.");
  let ok;
  try { ok = await checkChip(d, "https://wedgie.dev"); } catch { return oops("Bad chip answer."); }
  if (!ok.pass) return oops(`Chip check failed: ${ok.detail}`);
  const chip = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", trustmCert(d))), (x) => x.toString(16).padStart(2, "0")).join("");
  const sql = await db();
  await sql`insert into tg_members (chip, tg_id) values (${chip}, ${id}) on conflict (chip) do nothing`;
  const [row] = await sql`select tg_id from tg_members where chip = ${chip}`;
  if (String(row.tg_id) !== id) return oops("This wedgie already let in another account.", 409);
  const link = (await tg("createChatInviteLink", { chat_id: env("TELEGRAM_GATE_CHAT"), member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600, name: `wedgie ${id}` })).invite_link;
  await tg("sendMessage", { chat_id: id, text: `You're in: ${link}` }).catch(() => {});
  return json({ link });
}
