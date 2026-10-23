// /order end to end on a Base fork (anvil), with the shop's real server (api/, under `vite` on the dev
// database branch) and the shipping computer's real orders.py:
//   1. a USDC order through the page's form: its own deposit address; what leaves the browser never holds the
//      address in clear
//   2. pay it from window.ethereum (an anvil account holding fork USDC): Paid once confirmed. The price went up
//      when it was opened (open quotes count, so six orders can't each get the bottom price) and stays up
//   3. plain transfers, wrong amounts: short (the page asks for the rest), then too much: paid
//      ETH by mistake counts at Chainlink's price
//   4. paid with the page closed: the shipping computer's list still finds it
//   5. orders.py list opens the address (a test key made here); ship marks it shipped and the site forgets it
//   6. /api/admin refuses without the token; the deposits sweep to the Safe; a sweep before it's paid hides nothing
//   7. stock: never set = sold out; orders.py stock N (wedgies and kits each); a cart bigger than what's left is refused; 0 = sold out
//   8. checkout counts (api/count.ts): steps and errors counted, anything off the list dropped
// Needs anvil, ALCHEMY_API_KEY (or BASE_RPC) to fork from, uv or python3 with `cryptography`, Node 23+.
// No SHOP_DATABASE_URL_DEV in .env? It runs on an in-memory Postgres (tools/neonlite.mjs).
// Run: node tools/shopprobe.mjs [outdir]
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { registerHooks } from "node:module";

registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c); throw e; } } });   // src/ says .js (Vercel)

const out = process.argv[2];
const ORDERS_PY = process.env.ORDERS_PY || homedir() + "/clawd/wedgie-shipping/orders.py";
const RPC = process.env.BASE_RPC || (process.env.ALCHEMY_API_KEY ? "https://base-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY : ""), APORT = 8597, ARPC = `http://127.0.0.1:${APORT}`, VPORT = 5197, SITE = `http://localhost:${VPORT}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
if (!RPC) { console.error("Set ALCHEMY_API_KEY (or BASE_RPC): never a public RPC."); process.exit(1); }
const kids = [];
process.on("exit", () => kids.forEach((k) => k.kill()));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the shipping computer's key, made here for the test
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const dir = mkdtempSync(tmpdir() + "/shopprobe-");
writeFileSync(dir + "/key.pem", privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const ADMIN = crypto.randomBytes(24).toString("hex"), PAY_TO = "0x" + crypto.randomBytes(20).toString("hex");

const anvil = spawn("anvil", ["--fork-url", RPC, "--port", String(APORT), "--mnemonic-random", "--hardfork", "osaka", "--silent"], { stdio: "inherit" });
kids.push(anvil);
let id = 0;
const rpcRaw = async (body) => (await fetch(ARPC, { method: "POST", headers: { "content-type": "application/json" }, body })).text();
async function rpc(method, params = []) {
  const r = JSON.parse(await rpcRaw(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })));
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
for (let i = 0; ; i++) { try { await rpc("eth_chainId"); break; } catch { if (i > 150) throw new Error("anvil didn't start"); await sleep(200); } }
const [me] = await rpc("eth_accounts");
await rpc("anvil_dealERC20", [me, USDC, "0x" + (1000n * 10n ** 6n).toString(16)]);

const vite = spawn("npx", ["vite", "--port", String(VPORT), "--strictPort"], { stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, VITE_SEAL_KEY: pub, SHOP_PAY_TO: PAY_TO, SHOP_ADMIN_TOKEN: ADMIN, SHOP_RPC_8453: ARPC, STRIPE_SECRET_KEY: "",
    SHOP_MAIL_FILE: dir + "/mails.jsonl",   // never real mail: .env holds the live Gmail login
    SHOP_DATABASE_URL_DEV: process.env.SHOP_DATABASE_URL_DEV || "pglite" } });
kids.push(vite);
for (let i = 0; ; i++) { try { if ((await fetch(SITE + "/api/order")).ok) break; } catch {} if (i > 100) throw new Error("vite didn't start"); await sleep(300); }

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
await ctx.exposeBinding("__rpc", (_, method, params) => rpc(method, params).catch((e) => ({ __err: e.message })));
await ctx.addInitScript((me) => {
  window.ethereum = { async request({ method, params }) {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
    if (method === "eth_chainId") return "0x2105";
    if (method === "wallet_switchEthereumChain") return null;
    const r = await window.__rpc(method, params || []);
    if (r && r.__err) throw new Error(r.__err);
    return r;
  } };
}, me);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("page:", e.message));
const sent = [];
page.on("request", (r) => { if (r.url().includes("/api/")) sent.push(r.postData() || ""); });
const shot = (n) => out && page.screenshot({ path: `${out}/shop-${n}.png`, fullPage: true });

const NAME = "Probe Buyer " + crypto.randomBytes(3).toString("hex"), STREET = "1600 Probe Street";
async function newOrder(kits = 0, abroad = false) {
  await page.goto(SITE + "/order");
  await page.waitForFunction(() => !document.querySelector("#o-usdc").disabled);
  if (kits) await page.locator('[data-item=kit] [data-d="1"]').click();
  await page.fill("[name=name]", NAME); await page.fill("[name=line1]", STREET); await page.fill("[name=city]", "Testville");
  if (abroad) {
    await page.selectOption("[name=country]", "ES");
    await page.fill("[name=region]", "Madrid"); await page.fill("[name=postal]", "28001"); await page.fill("[name=phone]", "+34 600 000 000");
  } else { await page.selectOption("[name=state]", "CO"); await page.fill("[name=zip]", "80202"); }
  await page.fill("#o-addr [name=email]", "probe@example.com");
  await page.locator("#o-usdc").click();
  await page.waitForURL(/\/order\/[0-9a-f]{12}$/);
  await page.getByText("Copy amount").waitFor();
  return page.url().split("/").pop();
}

// 0: stock (api/_shop.ts stockLeft). Never set: sold out. 8 of each; the probe buys 4 wedgies and 1 kit.
const env = { ...process.env, SHOP_URL: SITE, SHOP_ADMIN_TOKEN: ADMIN, SHOP_KEY: dir + "/key.pem" };
const py = (...a) => { try { return execFileSync("uv", ["run", "--quiet", "--with", "cryptography", "python3", ORDERS_PY, ...a], { env, encoding: "utf8" }); }
  catch { return execFileSync("python3", [ORDERS_PY, ...a], { env, encoding: "utf8" }); } };
const leftNow = async () => { const l = (await (await fetch(SITE + "/api/order")).json()).left; return `${l.wedgie}w ${l.kit}k`; };
ok(await leftNow() === "0w 0k", "stock never set: sold out");
await page.goto(SITE + "/order");
await page.getByText("Sold out.").waitFor();
ok(await page.locator("#o-usdc").isDisabled() && await page.locator("#o-card").isDisabled(), "sold out: the pay buttons are off");
ok(py("stock", "8").includes("8 wedgies, 8 kits"), "orders.py stock 8");

// 1
const extra0 = (await (await fetch(SITE + "/api/order")).json()).extra;
const first = await newOrder(1);
await shot("1-unpaid");
const extraOpen = (await (await fetch(SITE + "/api/order")).json()).extra;
ok(extraOpen > extra0 + 900 && extraOpen <= extra0 + 1000, `an open order raises the price (${extra0} -> ${extraOpen} cents)`);
const want = (6700 + 5700 + 500 + 2 * extra0) / 100;
const amount = await page.locator("[data-copy]").first().getAttribute("data-copy");
ok(Number(amount) === want, `asks for ${want} USDC (${amount})`);
const dep1 = await page.locator("[data-copy]").nth(1).getAttribute("data-copy");
ok(/^0x[0-9a-fA-F]{40}$/.test(dep1) && dep1.toLowerCase() !== PAY_TO, `its own deposit address (${dep1})`);
ok(await page.locator(".order-qr svg").count() === 1 && /\d:\d\d/.test(await page.locator(".o-left").first().innerText()), "a QR code and a countdown");
ok(sent.length && sent.every((b) => !b.includes(NAME) && !b.includes(STREET)), "the address never left the browser in clear");

// 2
await page.locator("#o-send").click();
await page.getByText("Payment sent").waitFor();
await rpc("anvil_mine", ["0x3"]);
await page.getByText("Paid, thank you").waitFor({ timeout: 30000 });
await shot("2-paid");
ok(true, "paid from the browser's wallet, confirmed, shown");
const extra1 = (await (await fetch(SITE + "/api/order")).json()).extra;
ok(extra1 > extra0 + 900 && extra1 <= extra0 + 1000, `2 boxes sold: the price stays up (${extra0} -> ${extra1} cents)`);

// 3: any wallet, wrong amounts: short first (the page asks for the rest), then too much: paid
const send = (to, n) => rpc("eth_sendTransaction", [{ from: me, to: USDC, data: "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + n.toString(16).padStart(64, "0") }]);
const second = await newOrder();
const price2 = BigInt(Math.round(Number(await page.locator("[data-copy]").first().getAttribute("data-copy")) * 1e6));
const dep2 = await page.locator("[data-copy]").nth(1).getAttribute("data-copy");
ok(dep2 !== dep1, "every order has a different address");
await send(dep2, 20_000_000n);
await rpc("anvil_mine", ["0x3"]);
await page.getByText("more on Base").waitFor({ timeout: 30000 });
const rest = await page.locator("[data-copy]").first().getAttribute("data-copy");
await shot("3-short");
ok(BigInt(Math.round(Number(rest) * 1e6)) === price2 - 20_000_000n, `short: it asks for the rest (${rest})`);
await send(dep2, price2);   // way too much
await rpc("anvil_mine", ["0x3"]);
await page.getByText("Paid, thank you").waitFor({ timeout: 30000 });
ok(true, "two sends, too much in total: paid");

// 3b: ETH by mistake (worth more than the price at Chainlink's rate): paid
const ethOrder = await newOrder();
const depE = await page.locator("[data-copy]").nth(1).getAttribute("data-copy");
await rpc("eth_sendTransaction", [{ from: me, to: depE, value: "0x" + (10n ** 17n).toString(16) }]);   // 0.1 ETH
await rpc("anvil_mine", ["0x3"]);
await page.getByText("Paid, thank you").waitFor({ timeout: 30000 });
ok(true, "ETH sent instead of USDC: counted at the ETH price, paid");

// 4: paid after the buyer left the page: the shipping computer's list finds it. Shipped to Spain: +$20.
await page.goto(SITE + "/order");
await page.waitForFunction(() => !document.querySelector("#o-usdc").disabled);
const usTotal = await page.locator("#o-total").innerText();
await page.selectOption("[name=country]", "ES");
const esTotal = await page.locator("#o-total").innerText();
ok(Number(esTotal.slice(1)) - Number(usTotal.slice(1)) === 20 && await page.locator("[name=phone]").isVisible() && !(await page.locator("[name=state]").isVisible()),
  `outside the US: $20 more (${usTotal} -> ${esTotal}), a phone, no US state`);
const third = await newOrder(0, true);
ok(await page.getByText("Shipping outside the US at $20").isVisible(), "the order shows the $20 shipping line");
const dep3 = await page.locator("[data-copy]").nth(1).getAttribute("data-copy");
const price3 = BigInt(Math.round(Number(await page.locator("[data-copy]").first().getAttribute("data-copy")) * 1e6));
await page.goto("about:blank");
await send(dep3, price3);
await rpc("anvil_mine", ["0x3"]);

// 5
ok(await leftNow() === "4w 7k", `4 wedgies and a kit paid: 4 and 7 left (${await leftNow()})`);
const list = py("list");
ok(list.includes(first) && list.includes(NAME) && list.includes("Testville, CO 80202") && list.includes(second) && list.includes(third), "orders.py list opens the paid orders' addresses, the one paid with the page closed too");
ok(list.includes("ABROAD") && list.includes("Testville, Madrid 28001") && list.includes("   ES") && list.includes("phone: +34 600 000 000"), "orders.py list shows the abroad order's country and phone");
py("ship", first, "9400100000000000000001");
await page.goto(SITE + "/order/" + first);
await page.getByText("Shipped.").waitFor();
await shot("4-shipped");
ok(await page.getByText("9400100000000000000001").isVisible(), "the buyer sees the tracking number");
ok(!py("list").includes(first), "shipped: gone from the list (sealed address wiped)");
py("cancel", second);
py("cancel", third);
py("cancel", ethOrder);
ok(await leftNow() === "7w 7k", `canceled orders give their boxes back: 7 and 7 left (${await leftNow()})`);

// 5a: more than what's left is refused, by the page and by the server; 0 = sold out
py("stock", "1");
const tooBig = await fetch(SITE + "/api/order", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ cart: { wedgie: 2, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "probe@example.com", pay: "usdc", chain: 8453 }) });
ok(tooBig.status === 409 && (await tooBig.json()).error === "Only 1 wedgie left.", "a cart bigger than the stock: refused");
await page.goto(SITE + "/order");
await page.waitForFunction(() => !document.querySelector("#o-usdc").disabled);
ok(await page.locator("[data-item=wedgie] .stock").innerText() === "1 in stock", "the page shows what's in stock");
await page.locator('[data-item=wedgie] [data-d="1"]').click();
ok(await page.getByText("Only 1 in stock.").count() > 0 && await page.locator('[data-item=wedgie] .n').innerText() === "1", "the page won't add more than what's left");
py("stock", "kit", "0");
ok(await leftNow() === "1w 0k", "orders.py stock kit 0: kits sold out, wedgies not");
py("stock", "0");
ok(await leftNow() === "0w 0k", "orders.py stock 0: sold out");

// 5b: sweep the deposits to the Safe: anyone may, nowhere else
const D = await import("../src/shop/deposits.ts");
const factory = D.factoryOf(PAY_TO);
await rpc("eth_sendTransaction", [{ from: me, to: D.DEPLOYER, data: "0x" + "00".repeat(32) + D.FACTORY_CODE.slice(2) + PAY_TO.slice(2).padStart(64, "0") }]);
const bal = async (a) => BigInt(await rpc("eth_call", [{ to: USDC, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const held = (await bal(dep1)) + (await bal(dep2)) + (await bal(dep3));
const salts = [first, second, third].map(D.saltOf);
const enc = "0x7654b892" + "40".padStart(64, "0") + USDC.slice(2).toLowerCase().padStart(64, "0") + salts.length.toString(16).padStart(64, "0") + salts.map((x) => x.slice(2)).join("");
await rpc("eth_sendTransaction", [{ from: me, to: factory, data: enc, gas: "0x200000" }]);
await rpc("anvil_mine", ["0x1"]);
ok(held > 0n && (await bal(PAY_TO)) === held && (await bal(dep1)) + (await bal(dep2)) + (await bal(dep3)) === 0n, `sweep: all ${held} went to the Safe`);

// 5c: anyone sweeping an unpaid order's deposit early doesn't hide what was sent (usdcGot counts transfers in)
py("stock", "1");
const api = (b) => fetch(SITE + "/api/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const early = await api({ cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "probe@example.com", pay: "usdc", chain: 8453 });
await send(D.depositOf(PAY_TO, early.id), 20_000_000n);
await rpc("anvil_mine", ["0x3"]);
const one = "0x7654b892" + "40".padStart(64, "0") + USDC.slice(2).toLowerCase().padStart(64, "0") + "1".padStart(64, "0") + D.saltOf(early.id).slice(2);
await rpc("eth_sendTransaction", [{ from: me, to: factory, data: one, gas: "0x200000" }]);
await rpc("anvil_mine", ["0x3"]);
ok((await bal(D.depositOf(PAY_TO, early.id))) === 0n, "swept before it was paid");
const seen = await api({ id: early.id, token: early.token });
ok(seen.got === "20000000" && seen.status === "new", `the order still counts the 20 USDC sent (got ${seen.got})`);
py("cancel", early.id);

// 5d: checkout counts (src/shop/count.ts): the steps taken above, off-list keys dropped, nothing else kept
await fetch(SITE + "/api/count", { method: "POST", body: "probe@example.com" });
const fun = await (await fetch(SITE + "/api/admin?funnel=1", { headers: { authorization: "Bearer " + ADMIN } })).json();
const ks = new Set(fun.counts.map((c) => c.k));
ok(["view", "form", "tap-usdc", "made-usdc", "wallet", "err-only-left"].every((k) => ks.has(k)) && !ks.has("probe@example.com"), `checkout counts: ${[...ks].join(" ")}`);

// 6
ok((await fetch(SITE + "/api/admin")).status === 401 && (await fetch(SITE + "/api/admin", { headers: { authorization: "Bearer x" } })).status === 401, "/api/admin needs the token");
console.log("shopprobe: all passed");
await browser.close();
process.exit(0);
