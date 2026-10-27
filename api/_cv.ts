// Claim a wedgie with conviction: a CLAWD staker burns CV_CLAIM_COST CV (clawdviction, larv.ai) for one free
// wedgie, one per wallet, while stock lasts (no other cap). A third way to pay an order (pay 'cv', api/order.ts); the brief:
// github.com/clawdbotatg/clawdviction docs/WEDGIE-CLAIM.md. larv.ai keeps no ledger, so one-per-wallet is ours:
// cv_claims (api/_shop.ts) keeps the wallet for good, past the order's ship-time wipe and 30-day delete.
// Env: CV_SPEND_SECRET (larv.ai's; server only, never logged, never sent to a browser), CV_API (larv.ai),
// CV_CLAIM_COST. No secret: claims aren't open.
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { base } from "viem/chains";
import { env, type db } from "./_shop.js";

export const CV_MSG = "larv.ai CV Spend";   // larv.ai checks exactly this
export const cvApi = () => (env("CV_API") || "https://larv.ai").replace(/\/+$/, "");
export const cvCost = () => Number(env("CV_CLAIM_COST") || 500_000_000);
export const cvOpen = () => !!env("CV_SPEND_SECRET");

/** larv.ai's balance (its 5-minute column, the one spend checks), or null: never staked. Throws if larv.ai is down. */
export async function cvBalance(wallet: string): Promise<number | null> {
  const r = await fetch(`${cvApi()}/api/cv/balance?address=${wallet}`);
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok || !j?.success) throw new Error("larv.ai didn't answer.");
  return Number(j.balance);
}

/** The signature is this wallet's on CV_MSG: an EOA by recovery, else ERC-1271 on Base (a smart wallet). */
export async function cvSigned(wallet: string, signature: `0x${string}`) {
  try { if ((await recoverMessageAddress({ message: CV_MSG, signature })).toLowerCase() === wallet) return true; } catch {}
  if (!env("SHOP_RPC_8453")) return false;
  const c = createPublicClient({ chain: base, transport: http(env("SHOP_RPC_8453")) });
  return c.verifyMessage({ address: wallet as `0x${string}`, message: CV_MSG, signature }).catch(() => false);
}

/** Burn it. ok, or why not (short: under the cost; down: larv.ai didn't take it). Never logs the body. */
export async function cvSpend(wallet: string, signature: string): Promise<{ ok: true } | { ok: false; short?: number; down?: boolean }> {
  try {
    const r = await fetch(`${cvApi()}/api/cv/spend`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, secret: env("CV_SPEND_SECRET"), amount: cvCost() }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j?.success) return { ok: true };
    if (r.status === 402) return { ok: false, short: Number(j?.balance) || 0 };
    return { ok: false, down: true };
  } catch { return { ok: false, down: true }; }
}

/** This wallet's claim (its order id), or null. A failed burn's row is deleted; a shipped order is deleted after
 * 30 days, its claim row never. */
export async function cvClaimed(sql: Awaited<ReturnType<typeof db>>, wallet: string) {
  const [mine] = await sql`select order_id from cv_claims where wallet = ${wallet}`;
  return (mine?.order_id as string) || null;
}

export const fmtCv = (n: number) => Math.floor(n).toLocaleString("en-US");

/** The one bad state: larv.ai burned the CV but our write failed. Telegram the shop (no address, no email) and keep
 * the rows: Austin ships it by hand. Never throws. */
export async function cvAlarm(id: string, wallet: string) {
  const bot = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!bot || !chat) return;
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `⚠️ CV claim ${id}: larv.ai burned ${wallet}'s CV but the order didn't save as paid. Check orders.py list; mark it paid by hand.` }) }).catch(() => {});
}
