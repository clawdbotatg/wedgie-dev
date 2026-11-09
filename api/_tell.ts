// tellShop: a note to the shop (Austin) by Telegram AND email, so a frozen bot never hides an order (11-03: Telegram
// froze @wedgieshippingbot). Never the buyer's address or email in the text.
// Env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (Telegram), SHOP_MAIL_USER + SHOP_MAIL_PASS (Gmail), SHOP_NOTIFY_EMAIL
// (where it goes; default SHOP_MAIL_USER). SHOP_MAIL_FILE: probes, mail appended there instead of sent.
import nodemailer from "nodemailer";
import { appendFileSync } from "node:fs";
import { env } from "./_shop.js";

async function telegram(text: string) {
  const bot = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!bot || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }) });
    return r.ok;
  } catch { return false; }
}

let smtp: ReturnType<typeof nodemailer.createTransport> | null = null;
async function email(text: string) {
  const to = env("SHOP_NOTIFY_EMAIL") || env("SHOP_MAIL_USER");
  const subject = text.split("\n")[0].slice(0, 120);
  try {
    if (env("SHOP_MAIL_FILE")) { appendFileSync(env("SHOP_MAIL_FILE"), JSON.stringify({ to, subject, text }) + "\n"); return true; }
    if (!to || !env("SHOP_MAIL_USER") || !env("SHOP_MAIL_PASS")) return false;
    smtp ||= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: env("SHOP_MAIL_USER"), pass: env("SHOP_MAIL_PASS") } });
    await smtp.sendMail({ from: `wedgie shop <${env("SHOP_MAIL_USER")}>`, to, subject, text: text + "\n" });
    return true;
  } catch { return false; }
}

/** Both at once. True if either got through. Never throws. */
export async function tellShop(text: string) {
  const [t, e] = await Promise.all([telegram(text), email(text)]);
  return t || e;
}
