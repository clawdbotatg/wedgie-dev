// /api/price: the ETH price, signed, for a wedgie that doesn't trust the computer it's plugged into.
//   GET ?nonce=<32 hex>  -> {pair, price, t, nonce, r, s}
// The wedgie makes the nonce and checks the signature against the public half of PRICE_KEY (pinned in the
// wedgie-price app), so the computer passing it along can block the answer but can't change or replay it.
// Signed text: "wedgie.dev price\n<nonce>\n<pair>\n<price>\n<t>" (sha256, P-256; t = unix seconds).
import { createPrivateKey, sign } from "node:crypto";

const PAIR = "ETH-USD";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const nonce = new URL(req.url).searchParams.get("nonce") || "";
  if (!/^[0-9a-f]{32}$/.test(nonce)) return json({ error: "nonce: 32 lowercase hex" }, 400);
  const k = process.env.PRICE_KEY;
  if (!k) return json({ error: "not set up" }, 503);
  let price: string;
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${PAIR}/spot`);
    price = (await r.json()).data.amount;
    if (!/^\d+(\.\d+)?$/.test(price)) throw new Error("bad price");
  } catch {
    return json({ error: "no price right now" }, 502);
  }
  const t = Math.floor(Date.now() / 1000);
  const key = createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" });
  const sig = sign("sha256", Buffer.from(`wedgie.dev price\n${nonce}\n${PAIR}\n${price}\n${t}`), { key, dsaEncoding: "ieee-p1363" });
  return json({ pair: PAIR, price, t, nonce, r: sig.subarray(0, 32).toString("hex"), s: sig.subarray(32).toString("hex") });
}
