// /api/simulate: what a transaction would move in and out of its sender, signed, for a wedgie that doesn't trust the
// computer it's plugged into (built like api/price.ts, same key). Runs the call on the latest block (Alchemy's
// debug_traceCall), adds up the sender's ETH and ERC-20 changes, names each token and prices it.
//   POST {chain, from, to, value, data, nonce: <32 hex>, sig?: "p256"}
//   -> {block, ok, tx, changes: [{token, symbol, decimals, amount, usd}], nonce, sig, r, s}
// sig: the scheme the asker can check fast. Only "p256" (the default) for now: what a wedgie's Trust M checks.
// token "eth" is the chain's coin; amount is signed, raw units (- = out of the sender); usd is the whole change in
// dollars, "" if no price. ok: "ok" or "reverts".
// Signed text (sha256, P-256, ieee-p1363):
//   "wedgie.dev simulate\n<nonce>\n<chain>\n<tx>\n<block>\n<ok>" then "\n<token>,<symbol>,<decimals>,<amount>,<usd>" each
// tx = sha256 hex of "<from>\n<to>\n<value, decimal>\n<data>", all lowercase: the wedgie works it out from what it signs.
// Only a guide: the wedgie still checks the screen against the transaction's own numbers (clear-review docs).
import { createHash, createPrivateKey, sign } from "node:crypto";
import { json, oops, env, db, TRANSFER } from "./_shop.js";
import { HOSTS, COIN, key, prices, overLimit } from "./rpc.js";

const META = new Map<string, { symbol: string; decimals: number }>();
// Per IP: 60 a minute, 2,000 a day (overLimit). All of them: ALL_DAY a day, then no more till tomorrow (each costs
// ~3 Alchemy calls). Austin hears on Telegram (the shop's bot) when that cap is hit, or when the count can't be kept.
const ALL_DAY = 20_000;
let toldAt = 0;

/** A Telegram note to Austin, at most one an hour from a warm instance. Never throws. */
async function tell(text: string) {
  const bot = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (!bot || !chat || Date.now() - toldAt < 3_600_000) return;
  toldAt = Date.now();
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: "⚠️ wedgie.dev /api/simulate: " + text }) }).catch(() => {});
}

/** True once today's total is past ALL_DAY. The count down: let it through, and say so. */
async function allCapped() {
  if (!env("SHOP_DATABASE_URL")) return false;
  try {
    const sql = await db();
    const [r] = await sql`insert into rpc_hits (k, n) values (${"sim:all:" + new Date().toISOString().slice(0, 10)}, 1)
      on conflict (k) do update set n = rpc_hits.n + 1 returning n`;
    if (r.n === ALL_DAY + 1) await tell(`${ALL_DAY} today, the cap. Off till tomorrow (UTC). Someone slamming it?`);
    return r.n > ALL_DAY;
  } catch {
    await tell("can't count requests (database down?): no cap right now");
    return false;
  }
}

const hex = (x: unknown, n?: number) => typeof x === "string" && (n ? new RegExp(`^0x[0-9a-f]{${n}}$`) : /^0x([0-9a-f]{2})*$/).test(x);

async function rpc(host: string, method: string, params: unknown[]) {
  const r: any = await fetch(`https://${host}.g.alchemy.com/v2/${key()}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r?.error) throw new Error(r.error.message || "rpc");
  return r.result;
}

/** The sender's net change per token ("eth" for the coin), from a callTracer trace. Reverted frames don't count. */
export function changes(trace: any, who: string) {
  const out = new Map<string, bigint>();
  const add = (t: string, n: bigint) => out.set(t, (out.get(t) || 0n) + n);
  const walk = (c: any) => {
    if (!c || c.error) return;
    const v = BigInt(c.value || "0x0"), from = String(c.from).toLowerCase(), to = String(c.to).toLowerCase();
    if (v && c.type !== "DELEGATECALL") { if (from === who) add("eth", -v); if (to === who) add("eth", v); }
    for (const l of c.logs || []) {
      if (l.topics?.length !== 3 || l.topics[0] !== TRANSFER || !hex(l.data, 64)) continue;   // ERC-20 only (721 has 4 topics)
      const t = String(l.address).toLowerCase(), a = "0x" + l.topics[1].slice(26), b = "0x" + l.topics[2].slice(26), n = BigInt(l.data);
      if (a === who) add(t, -n);
      if (b === who) add(t, n);
    }
    for (const s of c.calls || []) walk(s);
  };
  walk(trace);
  return [...out].filter(([, n]) => n !== 0n);
}

async function meta(host: string, t: string) {
  const k = host + ":" + t;
  if (!META.has(k)) {
    const m = await rpc(host, "alchemy_getTokenMetadata", [t]).catch(() => null);
    const symbol = typeof m?.symbol === "string" && /^[A-Za-z0-9.$_-]{1,12}$/.test(m.symbol) ? m.symbol : "?";
    const decimals = Number.isInteger(m?.decimals) && m.decimals >= 0 && m.decimals <= 36 ? m.decimals : -1;
    if (META.size > 5000) META.clear();
    META.set(k, { symbol, decimals });
  }
  return META.get(k)!;
}

/** Dollars for n raw units at price p per whole token, 2 decimals. */
const usd = (n: bigint, d: number, p: number | null | undefined) =>
  p && d >= 0 ? (Number(n) / 10 ** d * p).toFixed(2) : "";

export async function POST(req: Request) {
  const pk = process.env.PRICE_KEY;
  if (!pk || !key()) return oops("not set up", 503);
  if (await overLimit(req, 60, 2000, "sim:")) return oops("Too many. Wait a minute.", 429);
  if (await allCapped()) return oops("Too busy today. Try tomorrow.", 503);
  let b: any;
  try { b = JSON.parse(await req.text()); } catch { return oops("Bad request."); }
  const chain = Number(b?.chain), host = HOSTS[chain];
  const from = String(b?.from || "").toLowerCase(), to = String(b?.to || "").toLowerCase(), data = String(b?.data || "0x").toLowerCase();
  if (!host) return oops("No such chain.", 404);
  if (!hex(from, 40) || !hex(to, 40) || !hex(data) || data.length > 200_000) return oops("from, to, data: hex");
  if (!/^\d{1,78}$/.test(String(b?.value ?? ""))) return oops("value: a decimal string");
  if (!/^[0-9a-f]{32}$/.test(b?.nonce || "")) return oops("nonce: 32 lowercase hex");
  if ((b.sig ?? "p256") !== "p256") return oops("sig: only p256 for now");
  const value = BigInt(b.value);
  let block: number, trace: any;
  try {
    block = Number(await rpc(host, "eth_blockNumber", []));
    trace = await rpc(host, "debug_traceCall", [{ from, to, value: "0x" + value.toString(16), data }, "0x" + block.toString(16),
      { tracer: "callTracer", tracerConfig: { withLog: true } }]);
  } catch {
    return oops("can't simulate right now", 502);
  }
  const ok = trace?.error ? "reverts" : "ok";
  const moved = ok === "ok" ? changes(trace, from) : [];
  const px = await prices(chain, host, moved.map(([t]) => t).filter((t) => t !== "eth")).catch(() => null);
  const list = [];
  for (const [t, n] of moved) {
    const m = t === "eth" ? { symbol: COIN[chain] || "ETH", decimals: 18 } : await meta(host, t);
    list.push({ token: t, symbol: m.symbol, decimals: m.decimals, amount: n.toString(), usd: usd(n, m.decimals, t === "eth" ? px?.eth : px?.tokens[t]) });
  }
  const tx = createHash("sha256").update(`${from}\n${to}\n${value}\n${data}`).digest("hex");
  const text = [`wedgie.dev simulate`, b.nonce, chain, tx, block, ok, ...list.map((c) => [c.token, c.symbol, c.decimals, c.amount, c.usd].join(","))].join("\n");
  const sig = sign("sha256", Buffer.from(text), { key: createPrivateKey({ key: Buffer.from(pk, "base64"), format: "der", type: "pkcs8" }), dsaEncoding: "ieee-p1363" });
  return json({ block, ok, tx, changes: list, nonce: b.nonce, sig: "p256", r: sig.subarray(0, 32).toString("hex"), s: sig.subarray(32).toString("hex") });
}
