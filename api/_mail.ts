// Email from wedgie@buidlguidl.com (Gmail SMTP, an app password): sign-in links, paid, shipped. Text + a little
// HTML: the lines and one green button like the site's.
// A buyer's email is kept two ways, never in clear: emailHash (a keyed hash, to find their orders at login; goes
// with the order) and lock()ed (to send paid and shipped; wiped when it ships). Order tokens are tokenOf(id), so
// a login can hand them back. All three need SHOP_MAIL_KEY: change it and old orders can't be found by email.
// Env: SHOP_MAIL_USER, SHOP_MAIL_PASS (the app password), SHOP_MAIL_KEY (any long random string).
// TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID: a Telegram note to the shop on each paid order (pingPaid).
// Probes: SHOP_MAIL_FILE = append each mail there as a JSON line instead of sending it.
import nodemailer from "nodemailer";
import { appendFileSync } from "node:fs";
import { env, hmac, sha256, randomHex, extraNow, type db } from "./_shop.js";
import { nameOf, SHIPS, ITEMS, BUMP, type Line } from "../src/shop/catalog.js";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const key = () => env("SHOP_MAIL_KEY");
export const emailHash = (email: string) => hmac(key(), "email:" + email.trim().toLowerCase());
/** An order's token: derived, so a login can give it back. Without SHOP_MAIL_KEY (dev), random. */
export const tokenOf = async (id: string) => (key() ? (await hmac(key(), "order:" + id)).slice(0, 32) : randomHex(16));

// AES-GCM, key = sha256(SHOP_MAIL_KEY). Stored as base64 of iv + ciphertext.
const aes = async () => crypto.subtle.importKey("raw", Uint8Array.from((await sha256(key())).match(/../g)!, (h) => parseInt(h, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
export async function lock(s: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(), new TextEncoder().encode(s)));
  return Buffer.concat([iv, ct]).toString("base64");
}
export async function unlock(b64: string) {
  const b = Buffer.from(b64, "base64");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12) }, await aes(), b.subarray(12)));
}

let smtp: ReturnType<typeof nodemailer.createTransport> | null = null;
/** lines: plain paragraphs. go: the green button (and the link, in the text version). */
export async function send(to: string, subject: string, lines: string[], go: { text: string; href: string }) {
  const text = [...lines, `${go.text}: ${go.href}`].join("\n\n") + "\n";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:17px;line-height:1.5;color:#1a1b1a;max-width:480px;margin:0 auto;padding:24px 16px">
${lines.map((l) => `<p style="margin:0 0 16px">${esc(l).replace(/\n/g, "<br>")}</p>`).join("")}
<p style="margin:28px 0"><a href="${esc(go.href)}" style="display:inline-block;background:#22c452;background-image:linear-gradient(#3fd56a,#168c34);color:#ffffff;font-weight:800;font-size:18px;text-decoration:none;padding:16px 30px;border-radius:999px;border-bottom:3px solid #0f6e28">${esc(go.text)}</a></p>
<p style="margin:0;color:#787b78;font-size:13px">wedgie.dev</p></div>`;
  if (env("SHOP_MAIL_FILE")) { appendFileSync(env("SHOP_MAIL_FILE"), JSON.stringify({ to, subject, text, html }) + "\n"); return; }
  if (!env("SHOP_MAIL_USER") || !env("SHOP_MAIL_PASS")) throw new Error("Email isn't set up yet.");
  smtp ||= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: env("SHOP_MAIL_USER"), pass: env("SHOP_MAIL_PASS") } });
  await smtp.sendMail({ from: `wedgie <${env("SHOP_MAIL_USER")}>`, to, subject, text, html });
}

const items = (lines: Line[] | null) => (lines || []).map((l) => `${l.qty} × ${nameOf(l.item)}`).join(", ");
const usd = (c: number) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const link = async (origin: string, id: string) => `${origin}/order/${id}#${await tokenOf(id)}`;

export const signinMail = (to: string, href: string) =>
  send(to, "Sign in to wedgie.dev", ["Tap to sign in and see your orders. The link works once, for 15 minutes.", "Didn't ask for this? Ignore it."],
    { text: "Sign in to wedgie.dev", href });
export const paidMail = async (to: string, o: { id: string; lines: Line[] | null; cents: number }, origin: string) =>
  send(to, `wedgie order ${o.id}: paid`, ["Paid, thank you.", `${items(o.lines)} · ${usd(o.cents)} shipped`, `${SHIPS} We'll email the tracking number.`],
    { text: "See your order", href: await link(origin, o.id) });
export const shippedMail = async (to: string, id: string, tracking: string, origin: string) =>
  send(to, `wedgie order ${id}: shipped`, ["Shipped.", `USPS tracking: ${tracking}`],
    { text: "Track it", href: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}` });

/** "Paid" goes out once per order (paid_mailed), if it has an email. Never throws: a failed send is tried again next time. */
export async function mailPaid(sql: Awaited<ReturnType<typeof db>>, id: string, origin: string) {
  await pingPaid(sql, id);
  const [o] = await sql`update orders set paid_mailed = now() where id = ${id} and status in ('paid', 'shipped') and paid_mailed is null
    and email_enc is not null returning id, lines, cents, email_enc`;
  if (!o) return;
  try { await paidMail(await unlock(o.email_enc), o as any, origin); }
  catch { await sql`update orders set paid_mailed = null where id = ${id}`.catch(() => {}); }
}

/** Telegram to the shop, once per order (paid_pinged): id, items, amount, how. Never the address or email. Never throws. */
async function pingPaid(sql: Awaited<ReturnType<typeof db>>, id: string) {
  const bot = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!bot || !chat) return;
  const [o] = await sql`update orders set paid_pinged = now() where id = ${id} and status in ('paid', 'shipped') and paid_pinged is null
    and paid_at > now() - interval '1 day' returning id, lines, cents, pay`;
  if (!o) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `💰 wedgie order ${o.id} paid: ${items(o.lines)} · ${usd(o.cents)} (${o.pay})` }) });
    if (!r.ok) throw 0;
  } catch { await sql`update orders set paid_pinged = null where id = ${id}`.catch(() => {}); }
}

/** Price alerts (api/alert.ts): once the surge is gone, each one gets a mail; ALERT_AGAIN later, the next time it's
 * back to list, one more, and it's deleted. 50 a call (Gmail's daily cap); a failed send goes back for next time.
 * Runs on GET /api/order (every shop page view) and omen's admin GETs. */
const ALERT_AGAIN = "14 days";
export async function sendAlerts(sql: Awaited<ReturnType<typeof db>>, origin: string, extra?: number) {
  const [any] = await sql`select 1 from alerts where sent = 0 or sent_at < now() - ${ALERT_AGAIN}::interval limit 1`;
  if (!any || (extra ?? (await extraNow(sql))) > 0) return;
  const rows = await sql`update alerts set sent = sent + 1, sent_at = now()
    where email_hash in (select email_hash from alerts where sent = 0 or sent_at < now() - ${ALERT_AGAIN}::interval order by created limit 50) returning *`;
  const list = usd(ITEMS.wedgie.cents);
  for (const r of rows) {
    const last = r.sent >= 2;
    try {
      await send(await unlock(r.email_enc), `wedgie is ${list} again`,
        [`The price is back to ${list}.`, `Each sale adds ${usd(BUMP)}, so it may not last.`,
          last ? "That's the last price email from us." : `You asked for this on wedgie.dev. One more in a couple of weeks, the next time it's ${list}, then that's it.`],
        { text: "Order one", href: `${origin}/order` });
      if (last) await sql`delete from alerts where email_hash = ${r.email_hash}`;
    } catch {
      await sql`update alerts set sent = sent - 1, sent_at = case when sent > 1 then now() - ${ALERT_AGAIN}::interval - interval '1 hour' end where email_hash = ${r.email_hash}`;
    }
  }
}
