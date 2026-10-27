// /claim end to end: a CV claim (api/_cv.ts) through the real page and server (api/, under `vite`, in-memory
// Postgres), against a FAKE larv.ai (a stub here: never the real one, so no real CV burns) and a fake wallet
// (a key made here, signing in node):
//   1. a wallet short of CV: told how far off, the button stays off, nothing burned
//   2. a wallet with enough: signs, the order is paid from the start, larv.ai saw one spend with the secret,
//      the address never left the browser in clear, the price didn't move, a box came off the stock
//   3. the same wallet again: the page says claimed; a straight POST gets 409; still one spend
//   4. larv.ai says 402 at the burn: an error, no order, the wallet can try again
//   5. a signature from another key: 403, nothing burned
//   6. omen: orders.py list opens it (if ORDERS_PY), shipping it keeps the claim (still 409 after)
// Run: node tools/claimprobe.mjs [outdir]   (ORDERS_PY=<wedgie-shipping>/orders.py for step 6's list)
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import crypto from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const out = process.argv[2];
const ORDERS_PY = process.env.ORDERS_PY || homedir() + "/clawd/clawd-harness/projects/wedgie-shipping/orders.py";
const VPORT = 5198, SITE = `http://localhost:${VPORT}`, CPORT = 5199, SECRET = "probe-" + crypto.randomBytes(8).toString("hex");
const kids = [];
process.on("exit", () => kids.forEach((k) => k.kill()));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the fake larv.ai: balances by wallet, every spend it was asked for
const rich = privateKeyToAccount(generatePrivateKey()), poor = privateKeyToAccount(generatePrivateKey()), flaky = privateKeyToAccount(generatePrivateKey());
const bal = { [rich.address.toLowerCase()]: 618e6, [poor.address.toLowerCase()]: 100e6, [flaky.address.toLowerCase()]: 900e6 };
const refuse = new Set([flaky.address.toLowerCase()]);   // its balance says yes, its spend says 402
const spends = [];
createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/cv/balance") {
    const w = (u.searchParams.get("address") || "").toLowerCase();
    return w in bal ? send(200, { success: true, balance: bal[w] }) : send(404, { success: false, error: "wallet not found" });
  }
  if (u.pathname === "/api/cv/spend" && req.method === "POST") {
    let s = ""; for await (const c of req) s += c;
    const b = JSON.parse(s); spends.push(b);
    if (b.secret !== SECRET) return send(403, { success: false, error: "invalid secret" });
    const w = b.wallet.toLowerCase();
    if (!(w in bal)) return send(404, { success: false, error: "wallet not found" });
    if (refuse.has(w) || bal[w] < b.amount) return send(402, { success: false, error: "insufficient balance", balance: refuse.has(w) ? 42 : bal[w] });
    bal[w] -= b.amount;
    return send(200, { success: true, newBalance: bal[w] });
  }
  send(404, {});
}).listen(CPORT);

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const dir = mkdtempSync(tmpdir() + "/claimprobe-");
writeFileSync(dir + "/key.pem", privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const ADMIN = crypto.randomBytes(24).toString("hex");

const vite = spawn("npx", ["vite", "--port", String(VPORT), "--strictPort"], { stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, VITE_SEAL_KEY: pub, SHOP_ADMIN_TOKEN: ADMIN, STRIPE_SECRET_KEY: "", SHOP_PAY_TO: "",
    CV_SPEND_SECRET: SECRET, CV_API: `http://127.0.0.1:${CPORT}`,
    SHOP_MAIL_FILE: dir + "/mails.jsonl", SHOP_DATABASE_URL_DEV: "pglite" } });
kids.push(vite);
for (let i = 0; ; i++) { try { if ((await fetch(SITE + "/api/order")).ok) break; } catch {} if (i > 100) throw new Error("vite didn't start"); await sleep(300); }
const admin = async (b) => (await fetch(SITE + "/api/admin", { method: "POST", headers: { authorization: "Bearer " + ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const shop = async (w = "") => (await fetch(SITE + "/api/order" + (w ? "?wallet=" + w : ""))).json();
await admin({ stock: 8, item: "wedgie" });
ok((await shop()).left.wedgie === 8 && (await shop()).cv.open, "8 wedgies in stock, claims open");

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
let who = rich;
async function as(acct) {
  who = acct;
  const ctx = await browser.newContext({ viewport: { width: 400, height: 1400 } });
  await ctx.exposeBinding("__sign", (_, hex) => who.signMessage({ message: { raw: hex } }));
  await ctx.addInitScript((a) => {
    window.ethereum = { async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [a];
      if (method === "personal_sign") return window.__sign(params[0]);
      throw new Error("probe wallet: " + method);
    } };
  }, acct.address);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("page:", e.message));
  page.sent = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) page.sent.push(r.postData() || ""); });
  await page.goto(SITE + "/claim");
  await page.waitForFunction(() => !document.querySelector("#c-connect").disabled);
  await page.locator("#c-connect").click();
  await page.locator("#c-bal").waitFor();
  return page;
}
const NAME = "Claim Probe " + crypto.randomBytes(3).toString("hex"), STREET = "500 Conviction Way";
async function fill(page) {
  await page.fill("[name=name]", NAME); await page.fill("[name=line1]", STREET); await page.fill("[name=city]", "Testville");
  await page.selectOption("[name=state]", "CO"); await page.fill("[name=zip]", "80202"); await page.fill("#o-addr [name=email]", "claim@example.com");
}
const shot = (page, n) => out && page.screenshot({ path: `${out}/claim-${n}.png`, fullPage: true });

// 1
let page = await as(poor);
await page.getByText("more to go").waitFor();
await shot(page, "1-short");
ok(await page.locator("#c-go").isDisabled() && spends.length === 0, "short of CV: how far off, the button is off, nothing burned");

// 2
const extra0 = (await shop()).extra;
page = await as(rich);
await page.getByText("Enough for a wedgie").waitFor();
await fill(page);
await page.locator("#c-go").click();
await page.waitForURL(/\/order\/[0-9a-f]{12}$/);
await page.getByText("Paid, thank you.").waitFor();
await shot(page, "2-paid");
const id = page.url().split("/").pop();
ok(spends.length === 1 && spends[0].secret === SECRET && spends[0].amount === 500000000 && spends[0].wallet === rich.address.toLowerCase(), "one spend of 500M with the secret");
ok(page.sent.every((b) => !b.includes(NAME) && !b.includes(STREET)), "the address never left the browser in clear");
ok(await page.getByText("claimed with CV").isVisible(), "the order page says claimed with CV");
const after = await shop(rich.address);
ok(after.extra === extra0 && after.left.wedgie === 7 && after.cv.claimed === id, "the price didn't move; one box gone");

// 3
page = await as(rich);
await page.getByText("already claimed its wedgie").waitFor();
ok(await page.locator("#c-go").isDisabled(), "the same wallet again: claimed, the button is off");
const again = await page.evaluate(async (a) => {
  const sig = await window.ethereum.request({ method: "personal_sign", params: ["0x" + Array.from(new TextEncoder().encode("larv.ai CV Spend"), (b) => b.toString(16).padStart(2, "0")).join(""), a] });
  const r = await fetch("/api/order", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pay: "cv", cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "x@example.com", wallet: a, signature: sig }) });
  return { status: r.status, sig };
}, rich.address);
ok(again.status === 409 && spends.length === 1, "a straight POST from the same wallet: 409, still one spend");

// 4
page = await as(flaky);
await page.getByText("Enough for a wedgie").waitFor();
await fill(page);
await page.locator("#c-go").click();
await page.getByText("This wallet has 42 CV").waitFor();
const f = await shop(flaky.address);
ok(spends.length === 2 && f.cv.claimed === null && f.left.wedgie === 7, "larv.ai said 402: no order, no claim, no box taken");

// 5
const forged = await fetch(SITE + "/api/order", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pay: "cv", cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "x@example.com", wallet: poor.address, signature: again.sig }) });
ok(forged.status === 403 && spends.length === 2, "someone else's signature: 403, nothing burned");

// 6
if (existsSync(ORDERS_PY)) {
  const env = { ...process.env, SHOP_URL: SITE, SHOP_ADMIN_TOKEN: ADMIN, SHOP_KEY: dir + "/key.pem" };
  const list = (() => { try { return execFileSync("uv", ["run", "--quiet", "--with", "cryptography", "python3", ORDERS_PY, "list"], { env, encoding: "utf8" }); }
    catch { return execFileSync("python3", [ORDERS_PY, "list"], { env, encoding: "utf8" }); } })();
  ok(list.includes(id) && list.includes(NAME) && list.includes("Testville, CO 80202"), "orders.py list opens the claim's address");
} else console.log("skip: orders.py list (set ORDERS_PY)");
ok((await admin({ id, tracking: "9400100000000000000009" })).ok, "shipped");
const post = await fetch(SITE + "/api/order", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ pay: "cv", cart: { wedgie: 1, kit: 0 }, sealed: "v1." + "a".repeat(60), email: "x@example.com", wallet: rich.address, signature: again.sig }) });
ok(post.status === 409 && spends.length === 2, "after it ships (payer wiped) the wallet still can't claim again");

console.log("claimprobe: all ok");
await browser.close();
process.exit(0);
