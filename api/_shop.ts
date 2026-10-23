// The shop's server side (Vercel functions; files starting with _ aren't routes). What it holds:
// an order's cart, how it was paid, and its address SEALED in the buyer's browser (src/shop/seal.ts) to
// a key only the shipping computer has. This code can't read an address and never tries. Once a box
// ships, the sealed address, the payer and the payment links are wiped; the rest goes 30 days later.
// Also a keyed hash of the buyer's IP (ipOf), for OPEN_MAX; wiped after a day. Their email: _mail.ts.
// And checkout counts (api/count.ts): a number per day per step, about no one.
// Never log a request body here: even sealed, it doesn't belong in Vercel's logs.
// Env: SHOP_DATABASE_URL, STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (card), SHOP_PAY_TO (USDC),
// SHOP_ADMIN_TOKEN (omen's orders.py), SHOP_RPC_<chainId> (an Alchemy URL: never a public RPC).
import { neon } from "@neondatabase/serverless";
import { nameOf, PAY_CHAINS, QUOTE, cartLines, extraAt, type Cart, type Line } from "../src/shop/catalog.js";

declare const process: { env: Record<string, string | undefined> };
export const env = (k: string) => process.env[k] || "";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const oops = (msg: string, status = 400) => json({ error: msg }, status);

// ---- the database ----
let ready: Promise<unknown> | null = null;
export async function db() {
  const sql = neon(env("SHOP_DATABASE_URL"));
  ready ||= (async () => {
    await sql`create table if not exists orders (
      id text primary key,
      token_hash text not null,
      cart jsonb not null,
      cents int not null,
      pay text not null,              -- card | usdc
      status text not null default 'new',   -- new | paid | shipped | canceled | expired (never paid in time)
      sealed text,                    -- the address, sealed to omen's key; null once shipped
      chain int, usdc bigint,         -- usdc: the amount asked for, in 6-decimal units
      stripe_session text,
      tx text, payer text,
      tracking text,
      created timestamptz not null default now(), paid_at timestamptz, shipped_at timestamptz)`;
    await sql`drop table if exists builds`;   // the old globe: names, photos and places of owners, pulled 10-19
    await sql`drop index if exists orders_open_usdc`;   // the old exact-amount orders: amounts needn't be unique now
    await sql`create unique index if not exists orders_tx on orders (chain, tx) where tx is not null`;
    await sql`alter table orders add column if not exists lines jsonb`;   // the prices it was made at
    await sql`alter table orders add column if not exists from_block bigint`;   // usdc: the chain's head when it was made
    await sql`alter table orders add column if not exists ip text`;   // ipOf: a hash, never the IP
    await sql`alter table orders add column if not exists email_hash text`;   // _mail.ts emailHash: finds a buyer's orders at login
    await sql`alter table orders add column if not exists email_enc text`;    // _mail.ts lock: the email, for paid + shipped; wiped when it ships
    await sql`alter table orders add column if not exists paid_mailed timestamptz`;
    await sql`alter table orders add column if not exists paid_pinged timestamptz`;   // _mail.ts pingPaid: Telegram told
    await sql`alter table orders add column if not exists deposit text`;   // usdc: this order's own address (src/shop/deposits.ts)
    await sql`create index if not exists orders_email on orders (email_hash) where email_hash is not null`;
    await sql`drop table if exists logins`;   // the old 6-digit codes
    await sql`create table if not exists links (      -- a sign-in link emailed (api/login.ts); used once, 15 minutes
      token_hash text primary key, email_hash text not null, created timestamptz not null default now(), used_at timestamptz)`;
    await sql`create index if not exists links_email on links (email_hash, created)`;
    await sql`create table if not exists sessions (   -- a signed-in browser (api/login.ts)
      token_hash text primary key, email_hash text not null, expires timestamptz not null)`;
    await sql`alter table links add column if not exists email_enc text`;      // the email, locked (_mail.ts lock)
    await sql`alter table sessions add column if not exists email_enc text`;   // so any browser knows who's signed in
    await sql`alter table links add column if not exists ip text`;   // ipOf, for login.ts IP_HOUR; gone with the link in a day
    await sql`alter table orders add column if not exists held boolean`;   // unused since 10-15 (dust could lock the stock)
    await sql`alter table orders add column if not exists got bigint`;   // usdc: what its deposit held when last read (settleDeposit); kept past 30 days if > 0
    await sql`create table if not exists rpc_hits (k text primary key, n int not null, at timestamptz not null default now())`;   // api/rpc.ts: calls per IP hash per minute and per day
    await sql`create table if not exists stock (id int primary key, n int not null, set_at timestamptz not null default now())`;   // stockLeft
    await sql`create table if not exists counts (day date not null, k text not null, n int not null, primary key (day, k))`;   // api/count.ts: checkout steps, no one in them
    await sql`create table if not exists safe_cache (k text primary key, status int not null, body text not null, at timestamptz not null default now())`;   // api/safe.ts: Safe's answers, shared
    await sql`alter table orders add column if not exists moving_at timestamptz`;      // shipped: USPS has it moving (omen, admin.ts step); never a place
    await sql`alter table orders add column if not exists delivered_at timestamptz`;   // shipped: USPS delivered it
    await sql`create table if not exists alerts (     -- "email me when it's $67 again" (api/alert.ts, _mail.ts sendAlerts); gone once mailed
      email_hash text primary key, email_enc text not null, ip text, created timestamptz not null default now())`;
  })().catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

// ---- small crypto (Web Crypto: no Node types needed) ----
const enc = new TextEncoder();
const hexOf = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const randomHex = (n: number) => hexOf(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s: string) => hexOf(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
export function same(a: string, b: string) {   // constant time
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type Order = {
  id: string; token_hash: string; cart: Cart; lines: Line[] | null; cents: number; pay: "card" | "usdc"; status: string; sealed: string | null;
  chain: number | null; usdc: string | null; from_block: string | null; stripe_session: string | null; tx: string | null; payer: string | null; deposit: string | null;
  tracking: string | null; created: string; paid_at: string | null; shipped_at: string | null; moving_at?: string | null; delivered_at?: string | null; held?: boolean | null; got?: string | null;
};

/** What the buyer's own order page may see: never the sealed address, the payer or the session. */
export const publicView = (o: Order, got?: bigint, checking?: boolean) => ({
  id: o.id, cart: o.cart, lines: o.lines, cents: o.cents, pay: o.pay, status: o.status, chain: o.chain, usdc: o.usdc,
  payTo: o.pay === "usdc" && (o.status === "new" || o.status === "expired") ? o.deposit || env("SHOP_PAY_TO") : undefined,
  got: got?.toString(),     // usdc sent to its deposit so far
  checking: checking || undefined,   // a chain couldn't be read: got may be short
  left: o.status === "new" ? Math.max(0, Date.parse(o.created) + QUOTE - Date.now()) : undefined,
  tracking: o.tracking, created: o.created, paid_at: o.paid_at, shipped_at: o.shipped_at, moving_at: o.moving_at, delivered_at: o.delivered_at,
});

/** What every box costs over its list price right now (catalog.ts extraAt): paid orders at their paying, open
 * quotes at their making, so splitting a cart into orders saves nothing. */
export async function extraNow(sql: Awaited<ReturnType<typeof db>>) {
  const rows = await sql`select coalesce(paid_at, created) as at, cart from orders
    where (status in ('paid', 'shipped') and paid_at > now() - interval '60 days')
    or (status = 'new' and created > now() - ${`${QUOTE / 1000} seconds`}::interval)`;
  return extraAt(rows.map((r: any) => ({ at: Date.parse(r.at), n: (r.cart.wedgie || 0) + (r.cart.kit || 0) })), Date.now());
}

/** How many boxes are left to sell (wedgies and kits from one count: the same parts). The shipping computer sets
 * it (orders.py stock N, admin.ts); each box paid since then, or held by an open quote, takes one; a canceled
 * order gives its boxes back, and so does an expired quote. A card quote holds its box till its Stripe checkout
 * can't be paid any more (CARD_HOLD), even if ending it early failed. Unpaid money never holds a box: a dust
 * send can't lock the stock. Never set: 0, sold out. Can go below 0 when two orders race (order.ts raced backs
 * one out) or when a quote paid in full only after it expired lands on a sold-out shop: orders.py list then
 * says oversold (Austin, 10-15: OK). */
export const CARD_HOLD = 31 * 60_000;   // checkout()'s expires_at, plus a minute
export async function stockLeft(sql: Awaited<ReturnType<typeof db>>): Promise<number> {
  const [s] = await sql`select n, set_at from stock where id = 1`;
  if (!s) return 0;
  const [r] = await sql`select coalesce(sum(coalesce((cart->>'wedgie')::int, 0) + coalesce((cart->>'kit')::int, 0)), 0)::int as used from orders
    where (status in ('paid', 'shipped') and paid_at >= ${s.set_at})
    or (status = 'new' and created > now() - ${`${QUOTE / 1000} seconds`}::interval)
    or (status = 'new' and pay = 'card' and created > now() - ${`${CARD_HOLD / 1000} seconds`}::interval)`;
  return s.n - r.used;
}
export const boxes = (c: Cart) => (c.wedgie || 0) + (c.kit || 0);
export const soldOut = (left: number) => (left > 0 ? `Only ${left} left.` : "Sold out.");

/** Unpaid orders whose quote ran out are 'expired' (the address stays till admin.ts deletes it: a USDC
 * transfer sent in time but seen late still pays it, usdcPaid checks the time; Refresh price quotes it
 * again). A USDC one gets 2 more minutes first; expiring frees its amount's last digits for a new order.
 * A card one's Stripe checkout is ended (endCard), so it can't be paid at the old price. */
export const late = (o: Pick<Order, "pay" | "created">) =>
  Date.now() > Date.parse(o.created) + (o.pay === "usdc" ? QUOTE + 120_000 : QUOTE);
export async function expireOld(sql: Awaited<ReturnType<typeof db>>) {
  await sql`update orders set ip = null where ip is not null and created < now() - interval '1 day'`;
  await sql`update reports set ip = '' where ip <> '' and at < now() - interval '1 day'`.catch(() => {});   // its PER_HOUR needs an hour (no table yet: fine)
  await sql`update orders set status = 'expired' where status = 'new' and pay = 'usdc'
    and created < now() - ${`${(QUOTE + 120_000) / 1000} seconds`}::interval`;
  const cards = await sql`select id, stripe_session from orders where status = 'new' and pay = 'card'
    and created < now() - ${`${QUOTE / 1000} seconds`}::interval`;
  for (const o of cards as Order[]) await endCard(sql, o).catch(() => {});   // Stripe down: tried again next time
}
/** A card order's quote ran out: paid after all, or its Stripe checkout is ended and the order expired. If Stripe
 * won't end it, the order stays 'new' (still holding its box, stockLeft CARD_HOLD) and is tried again later. */
export async function endCard(sql: Awaited<ReturnType<typeof db>>, o: Pick<Order, "id" | "stripe_session">): Promise<"paid" | "expired" | "new"> {
  if (o.stripe_session) {
    const s = await session(o.stripe_session);
    if (s.payment_status === "paid") { await markPaid(sql, o.id, s.id); return "paid"; }
    if (s.status === "open") {
      const done = await stripe(`checkout/sessions/${s.id}/expire`, {}).then(() => true, () => false);
      if (!done) {
        const again = await session(s.id).catch(() => null);   // paid or ended just now?
        if (again?.payment_status === "paid") { await markPaid(sql, o.id, s.id); return "paid"; }
        if (again?.status !== "expired") return "new";
      }
    }
  }
  await sql`update orders set status = 'expired' where id = ${o.id} and status = 'new'`;
  return "expired";
}

/** Open quotes raise everyone's price (extraNow), so one IP may hold only OPEN_MAX at a time. ipOf: the IP,
 * hashed with a secret so the table can't be turned back into IPs. */
export const OPEN_MAX = 2;
export async function ipOf(req: Request) {
  const ip = req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "none";
  return (await hmac(env("SHOP_ADMIN_TOKEN") || "wedgie", "ip:" + ip)).slice(0, 32);
}
/** A browser POST sent by another site (a form or a no-cors fetch riding the visitor's cookies): refused
 * everywhere but the Stripe webhook. Scripts (curl, wedgie.py, Stripe) send neither header and pass. */
export function crossSite(req: Request) {
  if ((req.headers.get("host") || "").startsWith("emu.")) return true;   // /code's own site (index.html): apps nobody reviewed
  const f = req.headers.get("sec-fetch-site");
  if (f) return f !== "same-origin" && f !== "none";
  const o = req.headers.get("origin");
  try { return !!o && new URL(o).host !== req.headers.get("host"); } catch { return true; }
}
export async function tooMany(sql: Awaited<ReturnType<typeof db>>, ip: string) {
  const [r] = await sql`select count(*)::int as n from orders where ip = ${ip} and status = 'new'
    and created > now() - ${`${QUOTE / 1000} seconds`}::interval`;
  return r.n >= OPEN_MAX ? `You have ${OPEN_MAX} orders waiting to be paid. Pay one, or wait 10 minutes.` : "";
}

// ---- Stripe (its REST API; payment only: it is never sent an address) ----
async function stripe(path: string, form?: Record<string, string>) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const r = await res.json();
  if (!res.ok) throw new Error("Stripe: " + (r?.error?.message || res.status));
  return r;
}

export async function checkout(o: Pick<Order, "id" | "cart" | "lines">, origin: string) {
  const f: Record<string, string> = {
    mode: "payment",
    client_reference_id: o.id,
    "metadata[order]": o.id,
    expires_at: String(Math.floor(Date.now() / 1000) + 1800),   // Stripe's shortest; endCard ends it at QUOTE
    "payment_intent_data[metadata][order]": o.id,
    billing_address_collection: "auto",     // never "required", and no shipping_address_collection
    success_url: `${origin}/order/${o.id}`,
    cancel_url: `${origin}/order/${o.id}`,
  };
  (o.lines || cartLines(o.cart, 0)).forEach((l, i) => {     // the prices the order was made at, even on a later day
    f[`line_items[${i}][quantity]`] = String(l.qty);
    f[`line_items[${i}][price_data][currency]`] = "usd";
    f[`line_items[${i}][price_data][unit_amount]`] = String(l.cents);
    f[`line_items[${i}][price_data][product_data][name]`] = nameOf(l.item);
  });
  return stripe("checkout/sessions", f) as Promise<{ id: string; url: string }>;
}
export const session = (id: string) => stripe("checkout/sessions/" + id) as Promise<{ id: string; url: string | null; status: string; payment_status: string; metadata: Record<string, string> }>;

export async function markPaid(sql: Awaited<ReturnType<typeof db>>, id: string, sessionId: string) {
  await sql`update orders set status = 'paid', paid_at = now() where id = ${id} and status in ('new', 'expired') and stripe_session = ${sessionId}`;   // Stripe takes no payment after expiry
}

// ---- USDC: read the chain ----
// New orders: each has its own deposit address (src/shop/deposits.ts), so whatever lands there is that order's:
// any amount, any wallet, any number of sends, late or not, USDC or ETH, on any of the shop's chains. Paid once it holds the price. The old orders
// (deposit null) were paid to the Safe with an exact amount: usdcPaid / usdcFind below.
let rpcId = 0;
export async function rpc(chain: number, method: string, params: unknown[]) {
  if (!env("SHOP_RPC_" + chain)) throw new Error("The shop can't read " + PAY_CHAINS[chain].name + " right now.");
  const res = await fetch(env("SHOP_RPC_" + chain), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const r = await res.json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicOf = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** What this order's deposit address got, in USDC units (6 decimals), on every chain the shop reads: the
 * address is the same on all of them, so the wrong chain still counts. USDC: every transfer into it, ever (the
 * address is this order's alone), so a sweep doesn't hide a payment; anyone may sweep (WedgieDeposits.sweep).
 * ETH: what it holds now, at Chainlink's ETH/USD on Base (skipped if that's over an hour old); plain ETH leaves no
 * log, so ETH swept before the order counts paid is missed (check the Safe by hand). Read PAY_CHAINS confirm back. */
const ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";   // Chainlink ETH/USD on Base, 8 decimals
export async function usdcGot(o: Order): Promise<{ got: bigint; sure: boolean }> {
  const who = o.deposit!.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const chains = Object.keys(PAY_CHAINS).map(Number).filter((c) => env("SHOP_RPC_" + c));
  const per = await Promise.all(chains.map(async (chain) => {
    const c = PAY_CHAINS[chain];
    const head = BigInt(await rpc(chain, "eth_blockNumber", []));
    const at = "0x" + (head - BigInt(c.confirm) + 1n).toString(16);
    const [logs, wei] = await Promise.all([
      rpc(chain, "eth_getLogs", [{ address: c.usdc, fromBlock: "earliest", toBlock: at, topics: [TRANSFER, null, "0x" + who] }]) as Promise<{ data: string }[]>,
      rpc(chain, "eth_getBalance", ["0x" + who.slice(24), at])]);
    return { usdc: logs.reduce((t, l) => t + BigInt(l.data), 0n), wei: BigInt(wei) };
  }).map((p) => p.catch(() => null)));   // a chain that can't be read counts 0 this time, and sure is false
  const sure = per.every(Boolean);
  let got = per.reduce((t, x) => t + (x?.usdc || 0n), 0n);
  const wei = per.reduce((t, x) => t + (x?.wei || 0n), 0n);
  if (wei > 0n && env("SHOP_RPC_8453")) {
    const r = (await rpc(8453, "eth_call", [{ to: ETH_USD, data: "0xfeaf968c" }, "latest"])) as string;   // latestRoundData
    const price = BigInt("0x" + r.slice(2 + 64, 2 + 128)), updated = Number(BigInt("0x" + r.slice(2 + 192, 2 + 256)));
    if (price > 0n && Date.now() / 1000 - updated < 3600) got += wei * price / 10n ** 20n;   // wei * usd(1e8) -> 1e6
  }
  return { got, sure };
}
/** A deposit order that holds its price: paid. Returns whether it is now. sure: every chain was read (if not, a
 * short got may be wrong: say so, and don't requote). */
export async function settleDeposit(sql: Awaited<ReturnType<typeof db>>, o: Order): Promise<{ paid: boolean; got: bigint; sure: boolean }> {
  const { got, sure } = await usdcGot(o);
  if (got > BigInt(o.got || 0)) await sql`update orders set got = ${got.toString()} where id = ${o.id}`;
  if (got < BigInt(o.usdc!)) return { paid: false, got, sure };
  const done = await sql`update orders set status = 'paid', paid_at = now() where id = ${o.id} and status in ('new', 'expired') returning id`;
  return { paid: done.length > 0 || o.status === "paid", got, sure };
}

/** Did this transaction pay this order? The amount's last digits are unique among open orders on the
 * chain, and it must land between the order's making and its quote running out, so a hash can't pay
 * someone else's and a late one can't buy at an old price. */
export async function usdcPaid(o: Order, tx: string): Promise<{ paid: true; payer: string } | { paid: false; why: string }> {
  const c = PAY_CHAINS[o.chain!];
  const r = await rpc(o.chain!, "eth_getTransactionReceipt", [tx]);
  if (!r) return { paid: false, why: "Not on chain yet." };
  if (r.status !== "0x1") return { paid: false, why: "That transaction failed on chain." };
  const log = (r.logs as { address: string; topics: string[]; data: string }[]).find((l) =>
    l.address.toLowerCase() === c.usdc.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2] === topicOf(env("SHOP_PAY_TO"))
    && BigInt(l.data) === BigInt(o.usdc!));
  if (!log) return { paid: false, why: `That transaction didn't send exactly ${fmtUsdc(o.usdc!)} USDC to the shop on ${c.name}.` };
  const [block, head] = await Promise.all([rpc(o.chain!, "eth_getBlockByNumber", [r.blockNumber, false]), rpc(o.chain!, "eth_blockNumber", [])]);
  const at = Number(BigInt(block.timestamp)) * 1000, made = Date.parse(o.created);
  if (at < made - 120_000) return { paid: false, why: "That transaction is older than this order." };
  if (at > made + QUOTE + 30_000) return { paid: false, why: "That payment came after the 10 minutes ran out. Write to wedgie@buidlguidl.com for a refund." };
  if (BigInt(head) - BigInt(r.blockNumber) + 1n < BigInt(c.confirm)) return { paid: false, why: "Waiting for confirmations." };
  return { paid: true, payer: "0x" + log.topics[1].slice(-40) };
}

/** Look for this order's payment on chain (any wallet, e.g. from the QR code): a transfer of its exact
 * amount to the shop, in the blocks of its 10 minutes. Returns the transaction, or null. */
export async function usdcFind(o: Order): Promise<string | null> {
  if (o.from_block == null) return null;
  const c = PAY_CHAINS[o.chain!], head = Number(BigInt(await rpc(o.chain!, "eth_blockNumber", [])));
  const from = Number(o.from_block) - 2, to = Math.min(head, Number(o.from_block) + Math.ceil((QUOTE + 60_000) / 1000 / c.secs));
  if (to < from) return null;
  const logs = await rpc(o.chain!, "eth_getLogs", [{ address: c.usdc, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
    topics: [TRANSFER, null, topicOf(env("SHOP_PAY_TO"))] }]) as { data: string; transactionHash: string }[];
  return logs.find((l) => BigInt(l.data) === BigInt(o.usdc!))?.transactionHash || null;
}
export const fmtUsdc = (u: string | bigint) => { const n = BigInt(u); return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`; };
