// /api/stats: counts only, for a wall display. Bearer SHOP_STATS_TOKEN (read-only; not the admin token).
//   GET -> {toPack, boxesToPack, onTheWay, delivered, shipped, left: {wedgie, kit}, price: {wedgie, kit, surge}}
// Orders, not boxes, except boxesToPack. shipped is all time: shipped orders still here plus the ones admin.ts
// deleted 30 days on (counts row "shipped_gone"). Prices in cents, surge = over list (catalog.ts extraAt).
// Never an id, a cart, a tracking number or sealed text.
import { ITEMS } from "../src/shop/catalog.js";
import { db, env, same, stockLeft, extraNow } from "./_shop.js";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization", "Cache-Control": "no-store" };
const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export const OPTIONS = () => new Response(null, { status: 204, headers: cors });

export async function GET(req: Request) {
  const t = env("SHOP_STATS_TOKEN");
  if (t.length < 32 || !same(req.headers.get("authorization") || "", "Bearer " + t)) return out({ error: "no" }, 401);
  const sql = await db();
  const [r] = await sql`select
    count(*) filter (where status = 'paid')::int as "toPack",
    coalesce(sum(coalesce((cart->>'wedgie')::int, 0) + coalesce((cart->>'kit')::int, 0)) filter (where status = 'paid'), 0)::int as "boxesToPack",
    count(*) filter (where status = 'shipped' and delivered_at is null)::int as "onTheWay",
    count(*) filter (where status = 'shipped' and delivered_at is not null)::int as delivered,
    count(*) filter (where status = 'shipped')::int
      + (select coalesce(sum(n), 0) from counts where k = 'shipped_gone')::int as shipped
    from orders`;   // one statement: one snapshot, so a cleanup in between can't count a box twice
  const surge = await extraNow(sql);
  return out({ ...r, left: await stockLeft(sql),
    price: { wedgie: ITEMS.wedgie.cents + surge, kit: ITEMS.kit.cents + surge, surge } });
}
