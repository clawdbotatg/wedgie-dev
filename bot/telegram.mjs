// @wedgiechatbot: the door to the wedgie Telegram group. Runs on clawd's Mac under launchd
// (bot/com.wedgie.telegram-bot.plist), like the $CLAWD bouncer (~/clawd/token-gated-chat).
//   A DM: replies with a wedgie.dev/telegram link that names that account (signed, an hour). The page has
//   the wedgie's chip sign; /api/telegram checks it and sends a one-person invite.
//   Someone joins the group by a link: asked /api/telegram?member=; not proven = removed. Added by an admin: left alone.
// Env (.env here): TELEGRAM_GATE_BOT_TOKEN, TELEGRAM_GATE_SECRET (same as Vercel's), TELEGRAM_GATE_CHAT.
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = Object.fromEntries(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8")
  .split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const TOKEN = env.TELEGRAM_GATE_BOT_TOKEN, SECRET = env.TELEGRAM_GATE_SECRET, CHAT = env.TELEGRAM_GATE_CHAT;
const SITE = "https://wedgie.dev";
if (!TOKEN || !SECRET || !CHAT) { console.error("bot: .env needs TELEGRAM_GATE_BOT_TOKEN, TELEGRAM_GATE_SECRET, TELEGRAM_GATE_CHAT"); process.exit(1); }

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!d.ok) throw new Error(`${method}: ${d.description}`);
  return d.result;
}

function link(id) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = createHmac("sha256", SECRET).update(`${id}.${exp}`).digest("hex").slice(0, 32);
  return `${SITE}/telegram?t=${id}.${exp}.${sig}`;
}

async function member(id) {
  const r = await fetch(`${SITE}/api/telegram?member=${id}`, { headers: { Authorization: `Bearer ${SECRET}` } });
  if (!r.ok) throw new Error(`member check: ${r.status}`);
  return (await r.json()).member;
}

async function onMessage(m) {
  if (m.chat.type === "private") {
    await tg("sendMessage", { chat_id: m.chat.id, disable_web_page_preview: true,
      text: `Prove you have a wedgie:\n${link(m.from.id)}\n\nOpen it in Chrome or Edge on a computer, plug in your wedgie, tap Connect. The link works for an hour.` });
    return;
  }
  if (String(m.chat.id) !== CHAT || !m.new_chat_members) return;
  for (const u of m.new_chat_members) {
    if (u.is_bot || u.id !== m.from.id) continue;       // added by an admin (members can't add people)
    let ok = false;
    try { ok = await member(u.id); } catch (e) { console.error(e.message); }   // can't tell: out, they can come back
    if (ok) continue;
    console.log(`removing ${u.id} (${u.username || u.first_name}): no chip proven`);
    await tg("banChatMember", { chat_id: CHAT, user_id: u.id }).catch((e) => console.error(e.message));
    await tg("unbanChatMember", { chat_id: CHAT, user_id: u.id, only_if_banned: true }).catch(() => {});
  }
}

let offset = 0;
console.log("bot: up");
for (;;) {
  try {
    const ups = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
    for (const u of ups) {
      offset = u.update_id + 1;
      if (u.message) await onMessage(u.message).catch((e) => console.error(e.message));
    }
  } catch (e) {
    console.error(e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
