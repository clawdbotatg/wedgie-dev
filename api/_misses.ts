// Calls our wallets showed as ⚠️ (nothing could read them): the to-do list of descriptors to write
// (clear-descriptors MAP.md). Only the chain, the contract and the function: never a Safe, an owner, an amount or an IP.
import { db, ipOf } from "./_shop.js";

export type Miss = { to: string; sel: string };
const DAY = 500;   // rows one IP may add a day: it's a to-do list, junk only costs us a look

let ready: Promise<unknown> | null = null;
async function store() {
  const sql = await db();
  ready ||= sql`create table if not exists misses (chain int not null, addr text not null, sel text not null, app text not null,
    n int not null default 1, first_at timestamptz not null default now(), last_at timestamptz not null default now(),
    primary key (chain, addr, sel, app))`.catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

/** Count each miss once (callers send each transaction once: explain.ts's answers are kept). */
export async function missed(req: Request, app: string, chain: number, list: Miss[]) {
  if (!list.length) return;
  try {
    const sql = await store(), k = "miss:" + await ipOf(req) + ":" + new Date().toISOString().slice(0, 10);
    const [r] = await sql`insert into rpc_hits (k, n) values (${k}, ${list.length}) on conflict (k) do update set n = rpc_hits.n + ${list.length} returning n`;
    if (r.n > DAY) return;
    for (const m of list)
      await sql`insert into misses (chain, addr, sel, app) values (${chain}, ${m.to.toLowerCase()}, ${m.sel.toLowerCase()}, ${app})
        on conflict (chain, addr, sel, app) do update set n = misses.n + 1, last_at = now()`;
  } catch { /* a to-do list: never fails the page */ }
}

/** Most seen first. */
export async function misses() {
  const sql = await store();
  return sql`select chain, addr, sel, app, n, first_at, last_at from misses order by n desc, last_at desc limit 1000`;
}
