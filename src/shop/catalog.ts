// What the shop sells. Read by the order page and by the server (api/), so a price lives in one place.
// Prices are US dollars in cents, US shipping included (Ground Advantage is ~$6). Outside the US: a flat ABROAD
// per order (USPS international is $16-30; wedgie-shipping README). The buyer pays any import tax.
export const ITEMS = {
  wedgie: { name: "wedgie", what: "Assembled: pico, screen, chip, and case. Plug it in and go.", cents: 6700 },
  kit: { name: "wedgie kit", what: "Every part and the case, with assembly instructions. You need a wire stripper, electrical tape, tweezers, a stiff wire or pin, and a USB data cable that fits your Pico (USB-C or micro USB, depending on the model).", cents: 5700 },
} as const;
export type Item = keyof typeof ITEMS;
export type Cart = Record<Item, number> & { abroad?: boolean };   // abroad: ships outside the US (only that bit, never the country)
export const MAX_EACH = 3, MAX_BOXES = 3;   // per order, wedgies and kits together (one person can't hold all the stock)
export const ABROAD = 2000;
export const SHIPS = "Ships within a week.";
export const ABROAD_NOTE = "Outside the US: $20 shipping. You pay any import tax when it arrives.";

// The price follows demand: each box sold adds BUMP to the next one (wedgies and kits together). That extra
// melts away evenly, all of it 24 hours after the last sale, so a quiet day is back at $67. Whole cents,
// rounded down. Open quotes count too (at their making), so six orders cost what one order of six does; a quote
// that runs out unpaid stops counting. `extra` comes from api/.
export const BUMP = 500, MELT = 24 * 3600_000;
export type Sale = { at: number; n: number };   // ms, boxes
export function extraAt(sales: Sale[], now: number) {
  let e = 0, t = 0;
  const melt = (dt: number) => Math.floor(e * Math.max(0, 1 - dt / MELT));
  for (const s of [...sales].sort((a, b) => a.at - b.at)) { e = melt(s.at - t) + BUMP * s.n; t = s.at; }
  return melt(now - t);
}
export type Line = { item: Item | "ship"; qty: number; cents: number };
export const nameOf = (i: Line["item"]) => i === "ship" ? "Shipping outside the US" : ITEMS[i].name;
export function cartLines(c: Cart, extra: number): Line[] {
  const lines: Line[] = [];
  let x = extra;
  for (const k of Object.keys(ITEMS) as Item[]) for (let i = 0; i < c[k]; i++, x += BUMP) {
    const cents = ITEMS[k].cents + x, last = lines[lines.length - 1];
    if (last?.item === k && last.cents === cents) last.qty++; else lines.push({ item: k, qty: 1, cents });
  }
  if (c.abroad) lines.push({ item: "ship", qty: 1, cents: ABROAD });
  return lines;
}
export const cartCents = (c: Cart, extra: number) => cartLines(c, extra).reduce((t, l) => t + l.qty * l.cents, 0);
export function cartOk(c: unknown): c is Cart {
  const o = c as Record<string, unknown>;
  if (!o || typeof o !== "object") return false;
  const ns = (Object.keys(ITEMS) as Item[]).map((k) => o[k]);
  if (o.abroad !== undefined && typeof o.abroad !== "boolean") return false;
  return ns.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_EACH) && ns.some((n) => (n as number) > 0)
    && ns.reduce((t: number, n) => t + (n as number), 0) <= MAX_BOXES;
}

// USDC (Circle's own, 6 decimals) on each chain the shop takes, all paid to the shop's Safe (the same address
// on every one: a chain goes here only once the Safe is deployed there). The server reads each chain through
// SHOP_RPC_<chainId>. secs: block time, to find a payment's blocks; confirm: blocks to wait (1 on the L2s: they
// don't reorg in practice, and a buyer watching the page shouldn't wait).
// A quote holds for QUOTE, USDC or card (a Stripe checkout lasts 30 minutes at least: the server ends it sooner).
// The shop's Safe goes by its ENS name on the pay page.
export const SHOP_ENS = { name: "wedgie.eth", address: "0xf5d3C7F2fACeAAc12A75d66e3BE4365A21d0d43C" };
export const QUOTE = 10 * 60_000;
export const PAY_CHAINS: Record<number, { name: string; usdc: string; scan: string; confirm: number; secs: number }> = {
  8453: { name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scan: "https://basescan.org", confirm: 1, secs: 2 },
  1: { name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", scan: "https://etherscan.io", confirm: 2, secs: 12 },
  42161: { name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", scan: "https://arbiscan.io", confirm: 1, secs: 0.25 },
  10: { name: "Optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", scan: "https://optimistic.etherscan.io", confirm: 1, secs: 2 },
};

// What the buyer types, sealed in their browser (seal.ts) before it leaves it.
// country: ISO code; outside the US, state and zip are whatever the buyer types (province, postal code), plus a phone.
export type ShipTo = { name: string; line1: string; line2: string; city: string; state: string; zip: string; country: string; phone: string; email: string };
export const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP".split(" ");

// Where we ship outside the US (ISO codes; the page shows each in the buyer's language). Left out: US embargoes and
// export bans on electronics (Cuba, Iran, North Korea, Syria, Russia, Belarus) and places USPS doesn't take mail.
export const COUNTRIES = ("AD AE AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BJ BM BN BO BR BS BT BW BZ CA CH CI CL CM CN CO CR CV CW CY CZ "
  + "DE DJ DK DM DO DZ EC EE EG ES ET FI FJ FO FR GA GB GD GE GH GI GL GM GN GR GT GY HK HN HR HU ID IE IL IN IS IT JM JO JP KE KG KH KN KR KW KY KZ "
  + "LA LB LC LI LK LS LT LU LV MA MC MD ME MG MK MN MO MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NZ OM PA PE PF PG PH PK PL PT PY QA RO RS RW "
  + "SA SC SE SG SI SK SL SM SN SR SV SZ TC TG TH TJ TN TO TR TT TW TZ UA UG UY UZ VC VG VN WS ZA ZM").split(" ");
