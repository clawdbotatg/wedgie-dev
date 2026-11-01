// /api/misses: calls our wallets couldn't read (⚠️), the to-do list of descriptors to write (_misses.ts).
//   GET  -> [{chain, addr, sel, app, n, first_at, last_at}], most seen first. Public: contracts and functions only.
//   POST {app, chain, calls: [{to, sel}]}   from Instant Wallet's server (its /api/explain); wedgie.dev's own
//        /api/explain counts its own.
import { env, json, oops } from "./_shop.js";
import { missed, misses } from "./_misses.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/, SEL = /^0x[0-9a-fA-F]{8}$/, APPS = ["instant-wallet"];

export async function GET() {
  if (!env("SHOP_DATABASE_URL")) return json([]);
  return json(await misses().catch(() => []));
}

export async function POST(req: Request) {
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  const chain = Number(b?.chain), app = String(b?.app || "");
  if (!APPS.includes(app) || !Number.isInteger(chain) || chain <= 0 || !Array.isArray(b.calls) || b.calls.length > 20) return oops("Bad request.");
  const list = b.calls.map((c: any) => ({ to: String(c?.to || ""), sel: String(c?.sel || "") }));
  if (list.some((m: any) => !ADDR.test(m.to) || !SEL.test(m.sel))) return oops("Bad call.");
  if (env("SHOP_DATABASE_URL")) await missed(req, app, chain, list);
  return json({ ok: true });
}
