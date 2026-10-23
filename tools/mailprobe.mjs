// Shop email end to end, no real mail and no database account: the real api/*.ts under vite's SSR loader, an
// in-memory Postgres (tools/neonlite.mjs), a fake chain head, and SHOP_MAIL_FILE catching each mail.
//   1. an order needs an email; the database never holds it in clear
//   2. paid: one "paid" mail, with the order's link
//   3. sign in: a mail with a green button to /signin#<token>; the link gives a session and the order's token, once;
//      the session lists the orders; a 2nd send waits a minute; signed out, the session is dead
//   4. an email with no orders still gets a link; signed in, it claims this device's order
//   5. shipped: a mail with the tracking number; the locked email is wiped
//   5b. price alert: stored locked, one mail once the surge is gone, then deleted
//   6. two tabs: tab A asks to sign in, the mail's link opens in tab B, and A signs in by itself; Sign out keeps only the email
// Run: node tools/mailprobe.mjs
import { createServer } from "vite";
import { createServer as http } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const chain = http((q, s) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => s.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(b).id, result: "0x10" }))); }).listen(8598);
const MAILS = mkdtempSync(tmpdir() + "/mailprobe-") + "/mail.jsonl";
Object.assign(process.env, { SHOP_DATABASE_URL: "pglite", SHOP_MAIL_KEY: "probe-key-" + Math.random(), SHOP_MAIL_FILE: MAILS,
  SHOP_PAY_TO: "0x" + "ab".repeat(20), SHOP_RPC_8453: "http://127.0.0.1:8598", SHOP_ADMIN_TOKEN: "t".repeat(40), STRIPE_SECRET_KEY: "" });
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  resolve: { alias: { "@neondatabase/serverless": new URL("./neonlite.mjs", import.meta.url).pathname } } });
const order = await vs.ssrLoadModule("/api/order.ts"), alert = await vs.ssrLoadModule("/api/alert.ts"), login = await vs.ssrLoadModule("/api/login.ts"), admin = await vs.ssrLoadModule("/api/admin.ts");
const { db } = await vs.ssrLoadModule("/api/_shop.ts");
const call = async (fn, body, headers = {}) => { const r = await fn(new Request("https://wedgie.dev/api/x", { method: "POST", headers, body: JSON.stringify(body) })); return { status: r.status, ...(await r.json()) }; };
const mails = () => (existsSync(MAILS) ? readFileSync(MAILS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// 1 (stock never set = sold out: give the probe some boxes)
await call(admin.POST, { stock: 20 }, { authorization: "Bearer " + "t".repeat(40) });
const base = { cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "x".repeat(60), pay: "usdc", chain: 8453 };
ok((await call(order.POST, base)).status === 400, "no email: refused");
const EMAIL = "Buyer@Example.com";
const o = await call(order.POST, { ...base, email: EMAIL });
ok(o.id && /^[0-9a-f]{32}$/.test(o.token), "an order with an email");
const sql = await db();
const [row] = await sql`select * from orders where id = ${o.id}`;
ok(!JSON.stringify(row).toLowerCase().includes("buyer@example.com") && row.email_hash && row.email_enc, "the database holds only a hash and a locked copy");

// 2
await sql`update orders set status = 'paid', paid_at = now() where id = ${o.id}`;
await call(order.POST, { id: o.id, token: o.token });
await call(order.POST, { id: o.id, token: o.token });
const paid = mails().filter((m) => /paid/.test(m.subject));
ok(paid.length === 1 && paid[0].to === EMAIL && paid[0].text.includes(`/order/${o.id}#${o.token}`), "one paid mail, with the order's link");

// 3
ok((await call(login.POST, { email: "buyer@example.com " })).ok, "sign in: asks for a link (any case, spaces)");
const sm1 = mails().find((m) => /Sign in/.test(m.subject));
const link = sm1?.html.match(/href="https:\/\/wedgie\.dev\/signin#([0-9a-f]{32})"/)?.[1];
ok(link && sm1.to === "buyer@example.com" && /background:#22c452/.test(sm1.html) && sm1.text.includes("/signin#" + link), "a sign-in mail with a green button");
ok((await call(login.POST, { link: "0".repeat(32) })).status === 400, "a made-up link is refused");
const got = await call(login.POST, { link });
ok(got.session && got.until > Date.now() + 2 * 86400e3 && got.orders?.length === 1 && got.orders[0].id === o.id && got.orders[0].token === o.token,
  "the link gives a session (over 48 hours) and the order with its token");
ok((await call(login.POST, { link })).status === 400, "a used link doesn't work again");
ok((await call(login.POST, { session: got.session })).orders?.[0]?.id === o.id, "the session lists the orders");
ok((await call(login.POST, { email: EMAIL })).status === 429, "a second send within a minute waits");
await call(login.POST, { signout: got.session });
ok((await call(login.POST, { session: got.session })).status === 401, "signed out: the session is dead");

// 4
ok((await call(login.POST, { email: "nobody@example.com" })).ok, "no orders: still asks for a link");
const nl = mails().filter((m) => m.to === "nobody@example.com").pop()?.text.match(/signin#([0-9a-f]{32})/)?.[1];
const ns = await call(login.POST, { link: nl });
ok(ns.session && ns.orders.length === 0, "no orders: the link signs in, no orders");
const old = await call(order.POST, { ...base, email: "other@example.com" });
await sql`update orders set email_hash = null, email_enc = null where id = ${old.id}`;
const cl = await call(login.POST, { session: ns.session, claim: [{ id: old.id, token: old.token }] });
const [oc] = await sql`select email_enc from orders where id = ${old.id}`;
ok(cl.email === "nobody@example.com" && cl.orders?.[0]?.id === old.id && oc.email_enc, "signed in: this device's old order (no email) gets the email");
ok((await call(login.POST, { session: ns.session, claim: [{ id: o.id, token: "0".repeat(32) }] })).orders.length === 1, "a wrong token claims nothing");

// 5
const auth = { authorization: "Bearer " + "t".repeat(40) };
const shipped = await call(admin.POST, { id: o.id, tracking: "9400100000000000000001" }, auth);
const sm = mails().find((m) => /shipped/.test(m.subject));
ok(shipped.mailed && sm?.to === EMAIL && sm.text.includes("9400100000000000000001"), "shipped mail with the tracking number");
const [after] = await sql`select email_enc, email_hash from orders where id = ${o.id}`;
ok(!after.email_enc && after.email_hash, "shipped: the locked email is wiped (the hash stays for login)");

// 5b
const get = async () => (await order.GET(new Request("https://wedgie.dev/api/order"))).json();
ok((await get()).extra > 0, "a surge on (the paid order)");
ok((await call(alert.POST, { email: "nope" })).status === 400, "alert: a bad email is refused");
ok((await call(alert.POST, { email: "Watcher@Example.com" })).ok, "alert: asked");
const [al] = await sql`select * from alerts`;
ok(al && !JSON.stringify(al).toLowerCase().includes("watcher@"), "alert: only a hash and a locked copy");
await get();
ok(!mails().some((m) => m.to === "Watcher@Example.com"), "alert: no mail while the surge is on");
await sql`update orders set created = created - interval '3 days', paid_at = paid_at - interval '3 days'`;
ok((await get()).extra === 0, "the surge is gone");
const am = mails().filter((m) => m.to === "Watcher@Example.com");
ok(am.length === 1 && /\$67 again/.test(am[0].subject) && am[0].text.includes("https://wedgie.dev/order"), "alert: one mail, with a link to order");
await get();
ok(mails().filter((m) => m.to === "Watcher@Example.com").length === 1 && !(await sql`select * from alerts`).length, "alert: sent once, then deleted");
ok((await call(alert.POST, { email: "watcher@example.com" })).status === 400, "alert: refused while it's already $67");

// 6: the real pages under vite, in a browser
await vs.close();
const { spawn } = await import("node:child_process");
const { chromium } = await import("playwright-core");
const { readdirSync } = await import("node:fs");
const { homedir } = await import("node:os");
const PORT = 5199, SITE = `http://localhost:${PORT}`;
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "ignore", env: { ...process.env, SHOP_DATABASE_URL_DEV: "pglite" } });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) { try { if ((await fetch(SITE + "/api/order")).ok) break; } catch {} if (i > 100) throw new Error("vite didn't start"); await new Promise((r) => setTimeout(r, 300)); }
const post = async (u, b) => (await fetch(SITE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
await fetch(SITE + "/api/admin", { method: "POST", headers: auth, body: JSON.stringify({ stock: 20 }) });
const o2 = await post("/api/order", { ...base, email: "tabs@example.com" });
ok(o2.id, "an order on the page's server");
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const A = await ctx.newPage();
A.on("pageerror", (e) => console.error("page:", e.message));
await A.goto(SITE + "/");
ok(await A.locator(".signin-btn").innerText() === "Sign in", "the header says Sign in");
await A.locator(".signin-btn").click();
await A.waitForURL(/\/signin$/);
await A.fill("[name=email]", "tabs@example.com");
await A.locator("#o-go").click();
await A.getByText("Check your email").waitFor();
const href = mails().filter((m) => m.to === "tabs@example.com" && /Sign in/.test(m.subject)).pop().html.match(/href="http[^"]*?(\/signin#[0-9a-f]{32})"/)[1];
const B = await ctx.newPage();
await B.goto(SITE + href);
await B.waitForURL(/\/orders$/);
await B.locator(`[data-id="${o2.id}"]`).waitFor();
ok(true, "the link signs in tab B and lists the order");
await A.waitForURL(/\/orders$/, { timeout: 5000 });
ok(await A.locator(`[data-id="${o2.id}"]`).count() === 1 && await A.locator(".orders-btn .lbl").innerText() === "Orders", "tab A signed in by itself; the header says Orders");
await A.goto(SITE + "/signin");
ok(await A.inputValue("[name=email]").catch(() => null) === null && /\/orders$/.test(A.url()), "signed in, /signin goes to your orders");
await A.evaluate(() => localStorage.removeItem("wedgie-email"));
await A.goto(SITE + "/orders");
await A.getByText("Signed in as").waitFor();
await A.goto(SITE + "/order");
const em = A.locator("#o-addr [name=email]");
ok(await em.inputValue() === "tabs@example.com" && await em.getAttribute("readonly") !== null, "signed in: checkout has your email, locked");
await A.goto(SITE + "/orders");
await A.locator("#o-out").click();
await A.waitForURL(SITE + "/");
ok(await A.evaluate(() => ["wedgie-session", "wedgie-orders"].every((k) => !localStorage.getItem(k))), "Sign out forgets the session and orders here");
await A.goto(SITE + "/signin");
ok(await A.inputValue("[name=email]") === "tabs@example.com", "Sign in again: your last email is filled in");
await browser.close();

console.log("mailprobe: all passed");
chain.close();
process.exit(0);
