// A renewed order never leaves an old Stripe checkout that can still be paid (audit 11-13, SHOP-12). Renew forgot
// the old session and opened a new one even when Stripe wouldn't end the old one, or when it was complete but not
// paid yet (a slow payment method). Money then landed on a session no order pointed at: charged, never marked paid.
// endCard with Stripe and the database faked.   node tools/test_shoprenew.mjs
import { createServer } from "vite";
import { readFileSync } from "node:fs";
process.env.STRIPE_SECRET_KEY = "test";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const S = await vs.ssrLoadModule("/api/_shop.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
let stripe = {}, expireOk = true, writes = [];
globalThis.fetch = async (u, init) => {
  const path = String(u).split("/v1/")[1];
  if (path.endsWith("/expire")) return expireOk ? { ok: true, json: async () => ({}) } : { ok: false, status: 400, json: async () => ({ error: { message: "can't expire" } }) };
  return { ok: true, json: async () => stripe };
};
const sql = async (parts, ...vals) => { writes.push(parts.join("?").replace(/\s+/g, " ").trim()); return []; };
const run = async (s, canExpire = true) => { stripe = { id: "cs_1", ...s }; expireOk = canExpire; writes = []; return S.endCard(sql, { id: "o1", stripe_session: "cs_1" }); };
const expired = () => writes.some((w) => /set status = 'expired'/.test(w)), paid = () => writes.some((w) => /set status = 'paid'/.test(w));

check(await run({ status: "open", payment_status: "unpaid" }) === "expired" && expired(), "an open checkout Stripe ends: the order is expired");
check(await run({ status: "complete", payment_status: "paid" }) === "paid" && paid(), "a paid one: the order is paid");
check(await run({ status: "expired", payment_status: "unpaid" }) === "expired", "one Stripe already ended: expired");
let r = await run({ status: "open", payment_status: "unpaid" }, false);
check(r === "new" && !expired(), `an open one Stripe won't end: still live, not expired (${r})`);
r = await run({ status: "complete", payment_status: "unpaid", created: Math.floor(Date.now() / 1000) - 3600 });
check(r === "new" && !expired(), `a finished checkout whose money hasn't landed yet: still live, not expired (${r})`);
check(await run({ status: "complete", payment_status: "unpaid", created: Math.floor(Date.now() / 1000) - 8 * 86400 }) === "expired", "one that never paid in a week: expired, its boxes go back");
const order = readFileSync("api/order.ts", "utf8");
const renew = order.slice(order.indexOf("async function renew("), order.indexOf("async function renew(") + 900);
check(/=== "new"\) return /.test(renew) && renew.indexOf('=== "new") return') < renew.indexOf("expireOld"), "renew stops while the old checkout is still live");
await vs.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
