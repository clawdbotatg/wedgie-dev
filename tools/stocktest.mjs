// The shop's stock count (api/_shop.ts stockLeft) on an in-memory Postgres, calling api/ directly: no chain,
// no browser, under a second. shopprobe.mjs covers the pages; this covers the bookkeeping:
//   1. an expired USDC quote gives its box back, even if dust reached it (dust can't lock the stock); admin can
//      cancel it; an order is at most 3 boxes
//   2. admin's 30-day cleanup of shipped orders doesn't hand their boxes out again
// Not here: two orders racing for the last box (order.ts raced, renew). PGlite runs one query at a time and these
// requests never interleave, so a race test passes on racy code too.
// Run: node tools/stocktest.mjs
import { registerHooks } from "node:module";

const lite = new URL("./neonlite.mjs", import.meta.url).href;
registerHooks({ resolve: (s, c, next) => {
  if (s === "@neondatabase/serverless") return { url: lite, shortCircuit: true };
  try { return next(s, c); } catch (e) { if (s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c); throw e; }
} });
Object.assign(process.env, { SHOP_DATABASE_URL: "pglite", SHOP_PAY_TO: "0x" + "11".repeat(20), SHOP_RPC_8453: "http://127.0.0.1:9",
  SHOP_ADMIN_TOKEN: "t".repeat(40), SHOP_MAIL_KEY: "", STRIPE_SECRET_KEY: "" });
const shop = await import("../api/_shop.ts"), order = await import("../api/order.ts"), admin = await import("../api/admin.ts");
const sql = await shop.db();
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
let ip = 0;
const post = (h, body, auth) => h.POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "x-real-ip": "10.0.0." + ++ip, ...(auth ? { authorization: "Bearer " + "t".repeat(40) } : {}) } }));
const stock = (n, item) => post(admin, { stock: n, item }, true);
const buy = async () => (await (await post(order, { cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "a@b.co", pay: "usdc", chain: 8453 })).json());
const expire = (id) => sql`update orders set status = 'expired', created = now() - interval '20 minutes' where id = ${id}`;
const left = async () => (await shop.stockLeft(sql)).wedgie;

// 1
await stock(1);
const c = await buy();
await expire(c.id);
ok(await left() === 1, "an expired quote with nothing sent gives its box back");
await sql`update orders set held = true where id = ${c.id}`;   // the old rule: money reached it
ok(await left() === 1, "an expired quote that dust reached still gives its box back");
ok((await post(admin, { id: c.id, cancel: true }, true)).status === 200, "admin cancels an expired order");
await stock(10);
const big = await post(order, { cart: { wedgie: 2, kit: 2 }, sealed: "v1." + "a".repeat(60), email: "a@b.co", pay: "usdc", chain: 8453 });
ok(big.status === 400, "an order of 4 boxes is refused");

// 2
await stock(1);
const d = await buy();
await sql`update orders set status = 'shipped', paid_at = now(), shipped_at = now() - interval '70 days' where id = ${d.id}`;
ok(await left() === 0, "shipped: its box is gone");
const g = await admin.GET(new Request("http://x/api/admin", { headers: { authorization: "Bearer " + "t".repeat(40) } }));
ok(g.status === 200 && (await sql`select 1 from orders where id = ${d.id}`).length === 0, "the 30-day cleanup deleted it");
ok(await left() === 0, `and the stock still counts it (left ${await left()})`);
// 3
await stock(2, "wedgie"); await stock(1, "kit");
const both = async () => JSON.stringify(await shop.stockLeft(sql));
ok(await both() === '{"wedgie":2,"kit":1,"atomic":1,"atomickit":1}', "stock wedgie 2, kit 1 (the atomic ones keep the 1 from `stock 1`: no kind = all)");
const k2 = await post(order, { cart: { wedgie: 0, kit: 2 }, sealed: "v1." + "a".repeat(60), email: "a@b.co", pay: "usdc", chain: 8453 });
ok(k2.status === 409 && (await k2.json()).error === "Only 1 wedgie kit left.", "2 kits from 1: refused");
await buy();
ok(await both() === '{"wedgie":1,"kit":1,"atomic":1,"atomickit":1}', "a wedgie takes a wedgie, not a kit");
ok(JSON.stringify((await (await order.GET(new Request("http://x/api/order"))).json()).left) === '{"wedgie":1,"kit":1,"atomic":1,"atomickit":1}', "GET /api/order shows every kind");
await stock(0, "kit");
const k0 = await post(order, { cart: { wedgie: 0, kit: 1 }, sealed: "v1." + "a".repeat(60), email: "a@b.co", pay: "usdc", chain: 8453 });
ok(k0.status === 409 && (await k0.json()).error === "Kits are sold out.", "kits sold out, wedgies still on sale");

// 4: the atomic wedgie and its kit: their own stock, $10 more, the same surge as everything else, US only
const cartOf = (c) => ({ cart: { wedgie: 0, kit: 0, atomic: 0, atomickit: 0, ...c }, sealed: "v1." + "a".repeat(60), email: "a@b.co", pay: "usdc", chain: 8453 });
await stock(0, "atomic");
const a0 = await post(order, cartOf({ atomic: 1 }));
ok(a0.status === 409 && (await a0.json()).error === "Atomic wedgies are sold out.", "atomic wedgies sold out, the rest still on sale");
await stock(2, "atomic"); await stock(1, "atomickit");
const extraNow = async () => (await (await order.GET(new Request("http://x/api/order"))).json()).extra;
const centsOf = async (r) => (await sql`select cents from orders where id = ${(await r.json()).id}`)[0].cents;
const near = (a, b) => Math.abs(a - b) <= 2;      // the surge melts a cent now and then
const surge = await extraNow();
const a1 = await centsOf(await post(order, cartOf({ atomic: 1 })));
ok(near(a1, 7700 + surge), `an atomic wedgie is $77 plus the surge (${a1} = 7700 + ${surge})`);
const after = await extraNow();
ok(near(after, surge + 500), "an atomic order raises everyone's price by $5");
const ak = await centsOf(await post(order, cartOf({ atomickit: 1 })));
ok(near(ak, 6700 + after), "an atomic kit is $67 plus the surge");
ok(await both() === '{"wedgie":1,"kit":0,"atomic":1,"atomickit":0}', "each took one of its own kind");
const ab = await post(order, cartOf({ atomic: 1, abroad: true }));
ok(ab.status === 400 && /US only/.test((await ab.json()).error), "an atomic wedgie abroad is refused");
const mix = await post(order, cartOf({ wedgie: 1, atomic: 1, kit: 0 }));
ok(mix.status === 200, "a wedgie and an atomic wedgie in one order");
const four = await post(order, cartOf({ wedgie: 2, atomic: 2 }));
ok(four.status === 400, "4 boxes of mixed kinds: refused");
console.log("stocktest: all passed");
process.exit(0);
