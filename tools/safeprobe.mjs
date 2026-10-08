// /safe through its buttons, on a Base fork: a fake wedgie running the Safe signer (fakewedgies: its hello
// carries a key, its safe_sign is answered by a P-256 key here, signing what safe.py signs), window.ethereum
// = an anvil account (the browser wallet), the page's public RPC = the fork, Safe's Transaction Service faked
// in memory. /safe lists the Safes; each opens at /safe/<chain>:<address>. One Safe's life, then a new one:
//   0. an old page's "last Safe" in localStorage doesn't open itself any more (/safe is the list)
//   1. a 1-of-1 Safe the wallet owns, from the list: the page shows the wedgie's signer; Add it with my
//      wallet (sets up the signer contract, runs at once)
//   2. Change the threshold to 2: proposed by the wedgie (A on it), run at once (1 of 2 was enough)
//   3. New transaction, 0.001 ETH, signed with the wedgie: into the queue; Sign with wallet; Execute.
//      Then an 8 KB contract call: the wedgie gets it in safe_data pieces
//   4. back to the list: the Safe is the wedgie's now. Make a new Safe: wallet + wedgie, 2 of 2, one
//      transaction, then its page; the list has both
// (Safe's real API: tools/safelive.mjs.) Needs anvil and Node 23+.
// Serve dist first (npm run build && npx vite preview --port 4173), then: node tools/safeprobe.mjs [url] [outdir]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fakeWedgies } from "./fakewedgies.mjs";
import * as E from "../src/safe/eth.ts";

const base = (process.argv[2] || "http://localhost:4173").replace(/\/$/, ""), out = process.argv[3];
const RPC = process.env.BASE_RPC || "https://mainnet.base.org", PORT = 8598, URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn("anvil", ["--fork-url", RPC, "--port", String(PORT), "--mnemonic-random", "--hardfork", "osaka", "--silent"], { stdio: "inherit" });
process.on("exit", () => anvil.kill());
let id = 0;
async function rpcRaw(body) { return (await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body })).text(); }
async function rpc(method, params = []) {
  const r = JSON.parse(await rpcRaw(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })));
  if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error });
  return r.result;
}
for (let i = 0; ; i++) { try { await rpc("eth_chainId"); break; } catch { if (i > 100) throw new Error("anvil didn't start"); await new Promise((r) => setTimeout(r, 200)); } }
const [me] = await rpc("eth_accounts");
const view = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const owners = async (safe) => E.addrs(await view(safe, E.selector("getOwners()")));
const num = async (safe, sig) => Number(BigInt(await view(safe, E.selector(sig))));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

// the wedgie: a P-256 key, and safe.py's answer to safe_sign
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64 = (s) => "0x" + Buffer.from(s, "base64url").toString("hex");
const key = { x: b64(jwk.x), y: b64(jwk.y) }, signer = E.signerAddress(key.x, key.y);
let pieces = "";            // safe_data, as wedgie-safe takes it: hex pieces, then data "@"
function safeData(m) {
  if (m.at === 0) pieces = "";
  if (m.at * 2 !== pieces.length) return { type: "error", error: "bad piece" };
  pieces += m.hex;
  return { type: "safe_data", have: pieces.length / 2 };
}
function safeSign(m) {
  const t = m.tx.data === "@" ? { ...m.tx, data: "0x" + pieces } : m.tx, h = E.safeTxHash(t.chainId, t.safe, t);
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const auth = Buffer.concat([sha("wedgie.dev"), Buffer.from("0500000000", "hex")]);
  const cdj = `{"type":"webauthn.get","challenge":"${Buffer.from(h.slice(2), "hex").toString("base64url")}","origin":"https://wedgie.dev"}`;
  const sig = crypto.sign(null, Buffer.concat([auth, sha(cdj)]), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { type: "safe_sig", safeTxHash: h, ...key, r: "0x" + sig.subarray(0, 32).toString("hex"), s: "0x" + sig.subarray(32).toString("hex"),
    authenticatorData: "0x" + auth.toString("hex"), clientDataFields: '"origin":"https://wedgie.dev"' };
}

// a Safe only the wallet owns, 1 of 1 (made here, not on the page)
const Z32 = new Uint8Array(32);
const setup = E.call("setup(address[],uint256,address,bytes,address,address,uint256,address)",
  [E.dynAddrs([me]), E.word(1), Z32, E.dynBytes("0x"), E.aword(E.FALLBACK_HANDLER), Z32, Z32, Z32]);
const h0 = await rpc("eth_sendTransaction", [{ from: me, to: E.SAFE_FACTORY, data: E.call("createProxyWithNonce(address,bytes,uint256)", [E.aword(E.SAFE_L2), E.dynBytes(setup), E.word(7)]) }]);
let rc = null;
while (!rc) rc = await rpc("eth_getTransactionReceipt", [h0]);
const mine = E.checksum("0x" + rc.logs.find((l) => l.topics[0] === E.PROXY_CREATION).topics[1].slice(26));
await rpc("anvil_setBalance", [mine, "0xde0b6b3a7640000"]);     // 1 ETH

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1600 } });
await ctx.exposeBinding("__safeSign", (_, m) => safeSign(m));
await ctx.exposeBinding("__safeData", (_, m) => safeData(m));
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc5afe01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.26"',
    "apps.json": JSON.stringify([{ mod: "safe", name: "Safe signer" }]), "safe.py": 1 }, chip: "none",
    hello: { running: "safe", safe: key, signer, safe_chunk: 4000 }, app: { safe_sign: "__safeSign", safe_data: "__safeData" } },
]);
// the browser wallet: anvil, on Base
await ctx.exposeBinding("__rpc", (_, method, params) => rpc(method, params).catch((e) => ({ __err: e.message })));
await ctx.addInitScript((me) => {
  let on = false;      // like a real wallet: eth_accounts is empty until this site asked once
  window.ethereum = { async request({ method, params }) {
    if (method === "eth_requestAccounts") { on = true; return [me]; }
    if (method === "eth_accounts") return on ? [me] : [];
    if (method === "eth_chainId") return "0x2105";
    if (method === "wallet_switchEthereumChain") return null;
    const r = await window.__rpc(method, params || []);
    if (r && r.__err) throw new Error(r.__err);
    return r;
  } };
}, me);
// the page's public RPC for Base = the fork
await ctx.route("https://mainnet.base.org/**", async (r) => r.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: await rpcRaw(r.request().postData()) }));
// Safe's Transaction Service, in memory (owners from the chain)
const txs = new Map();
const known = [mine];      // Safes the fake API can list     // safeTxHash -> the API's multisig transaction
const sigOwner = (sig) => (E.bytes(sig)[64] === 0 ? E.checksum("0x" + sig.slice(26, 66)) : E.checksum(me));   // contract: r = owner; EOA: the one wallet here
await ctx.route("https://api.safe.global/**", async (r) => {
  const u = new globalThis.URL(r.request().url()), p = u.pathname.replace(/^\/tx-service\/\w+\/api\/v1/, ""), cors = { "access-control-allow-origin": "*" };
  const json = (b, status = 200) => r.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(b) });
  let m;
  if (r.request().method() === "POST") {
    const b = JSON.parse(r.request().postData());
    if ((m = p.match(/^\/safes\/(0x\w+)\/multisig-transactions\/$/))) {
      if (!(await owners(m[1])).some((o) => eq(o, b.sender))) return json({ sender: "not an owner" }, 422);
      txs.set(b.contractTransactionHash, { ...b, safe: m[1], safeTxHash: b.contractTransactionHash, confirmations: [{ owner: b.sender, signature: b.signature }] });
      return json({}, 201);
    }
    if ((m = p.match(/^\/multisig-transactions\/(0x\w+)\/confirmations\/$/))) {
      txs.get(m[1]).confirmations.push({ owner: sigOwner(b.signature), signature: b.signature });
      return json({}, 201);
    }
    return json({}, 404);
  }
  if ((m = p.match(/^\/safes\/(0x\w+)\/multisig-transactions\/$/))) {
    const n = await num(m[1], "nonce()"), th = await num(m[1], "getThreshold()");
    return json({ results: [...txs.values()].filter((t) => eq(t.safe, m[1]) && +t.nonce >= n).map((t) => ({ ...t, confirmationsRequired: th })).sort((a, b) => a.nonce - b.nonce) });
  }
  if ((m = p.match(/^\/owners\/(0x\w+)\/safes\/$/))) {     // Base only; the Safes this probe knows, by their owners on chain
    if (!u.pathname.includes("/tx-service/base/")) return json({ safes: [] });
    const out = [];
    for (const sf of known) if ((await owners(sf)).some((o) => eq(o, m[1]))) out.push(sf);
    return json({ safes: out });
  }
  json({}, 404);
});

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const msg = () => page.textContent("#s-msg");
const wait = (fn, arg, ms, what) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => {
  console.log("STUCK:", what, "| msg:", await msg(), "|", (await page.textContent("main")).replace(/\s+/g, " ").slice(0, 600)); bad++; return false; });
const says = (re, what) => wait((re) => new RegExp(re).test(document.querySelector("#s-msg").textContent), re.source, 60000, what);
const asks = () => page.evaluate(() => (window.__ports[0]._st.appAsks || []).length);

// 0 + 1: /safe with an old "last Safe" saved: still the list. The wallet's Safe, from the list: add the wedgie
await page.goto(`${base}/`);
await page.evaluate((m) => localStorage.setItem("wedgie.safe", "base:" + m), mine);
await page.goto(`${base}/safe`);
await wait(() => document.querySelector("#s-wedgie .safe-addr"), null, 30000, "the wedgie's signer address");
check(eq(await page.textContent("#s-wedgie .safe-addr"), signer), `signer address shown: ${signer}`);
check(new globalThis.URL(page.url()).pathname === "/safe" && !(await page.isHidden("#s-list")) && !(await page.isHidden("#s-create")), "an old saved Safe doesn't open itself: /safe is the list, with Make a new Safe");
await wait(() => /None yet/.test(document.querySelector("#s-list").textContent), null, 20000, "the wedgie has no Safes yet");
await page.click("#w-go");
await wait((s) => document.querySelector(`.safe-row[href$="${s}"]`), mine, 20000, "the wallet's Safe listed");
check(/Your wallet's Safes[\s\S]*1 of 1 owner/.test(await page.textContent("#s-list")), "listed under the wallet's Safes, 1 of 1");
if (out) await page.screenshot({ path: `${out}/safe-0-list.png`, fullPage: true });
await page.click(`.safe-row[href$="${mine}"]`);
await wait(() => !document.querySelector("#s-add")?.hidden, null, 30000, "the Add box");
check(new globalThis.URL(page.url()).pathname === `/safe/base:${mine}`, `its own page: /safe/base:${short(mine)}`);
check(/1 of 1 owner must sign/.test(await page.textContent("#s-safe")) && /1 ETH/.test(await page.textContent("#s-safe")), "the Safe: 1 of 1, 1 ETH");
check(/Not set up on Base yet/.test(await page.textContent("#s-wedgie")), "the wedgie: not set up on Base yet");
if (out) await page.screenshot({ path: `${out}/safe-1-add.png`, fullPage: true });
await page.click("#a-go");
await says(/Done: add owner/, "added");
check((await owners(mine)).some((o) => eq(o, signer)), "on chain: the wedgie's signer is an owner");
check((await rpc("eth_getCode", [signer, "latest"])).length > 2, "on chain: its signer contract was deployed first");
check(await page.isHidden("#s-add") && /Your wedgie is an owner/.test(await page.textContent("#s-safe")) && /Set up on Base/.test(await page.textContent("#s-wedgie")), "page: an owner now, set up, Add box gone");

// 2: 2 of 2, proposed by the wedgie: 1 of 2 is enough, so it runs at once
await page.selectOption("#o-th", "2");
await page.click("#o-th-go");
await says(/Done: 2 of 2 must sign/, "threshold changed");
check(await asks() === 1, "the wedgie was asked (safe_sign)");
check(await num(mine, "getThreshold()") === 2, "on chain: 2 of 2, on the wedgie's signature alone");

// 3: send ETH: the wedgie signs, the wallet signs, execute
const to = E.checksum(E.hex(crypto.randomBytes(20)));
await page.fill("#n-to", to);
await page.fill("#n-amt", "0.001");
await page.click("#n-wedgie");
await says(/In the queue with the wedgie's signature/, "queued");
check(await asks() === 2, "the wedgie was asked again");
await wait(() => document.querySelector("[data-wsign]"), null, 10000, "Sign with wallet");
if (out) await page.screenshot({ path: `${out}/safe-3-queue.png`, fullPage: true });
await page.click("[data-wsign]");
await says(/That's enough: press Execute/, "wallet signed");
await page.click("[data-exec]");
await says(/Done: it ran/, "executed");
check(BigInt(await rpc("eth_getBalance", [to, "latest"])) === 10n ** 15n, "on chain: 0.001 ETH sent (wedgie + wallet, packed, executed)");
check(/Nothing waiting/.test(await page.textContent("#s-queue")), "page: the queue is empty");

// 3b: a contract call too big for one USB line (8 KB of data): sent to the wedgie in safe_data pieces
const big = "0x12345678" + "cd".repeat(8000);
const callee = E.checksum(E.hex(crypto.randomBytes(20)));
await page.fill("#n-to", callee);
await page.fill("#n-amt", "");
await page.click("#s-new details summary");
await page.fill("#n-data", big);
await page.click("#n-wedgie");
await says(/In the queue with the wedgie's signature/, "big one queued");
const kinds = await page.evaluate(() => window.__ports[0]._st.appAsks.map((m) => m.type));
check(kinds.filter((k) => k === "safe_data").length === 5 && kinds.at(-1) === "safe_sign", `8 KB of data: ${kinds.filter((k) => k === "safe_data").length} safe_data pieces, then safe_sign with data "@"`);
await page.click("[data-wsign]");
await says(/That's enough: press Execute/, "wallet signed the big one");
await page.click("[data-exec]");
await says(/Done: it ran/, "big one executed");
check(/Nothing waiting/.test(await page.textContent("#s-queue")), "on chain: the 8 KB call ran (wedgie's signature over pieces + wallet)");

// 4: back to the list (no reload): the Safe is the wedgie's now. Then a new one: wallet + wedgie, 2 of 2
await page.click('a[href="/safe"][data-nav]');
await wait((s) => /Your wedgie's Safes/.test(document.querySelector("#s-list").textContent) && document.querySelector(`.safe-row[href$="${s}"]`) && !/Your wallet's Safes/.test(document.querySelector("#s-list").textContent), mine, 30000, "the list: the Safe is the wedgie's now");
await page.click("#c-me");
await wait(() => /of 2 owners/.test(document.querySelector("#c-of").textContent), null, 10000, "2 owners counted");
await page.selectOption("#c-th", "2");
if (out) await page.screenshot({ path: `${out}/safe-4-new.png`, fullPage: true });
await page.click("#c-go");
await says(/Made your Safe on Base/, "made");
const made = new globalThis.URL(page.url()).pathname.match(/0x[0-9a-fA-F]{40}/)?.[0] || "0x";
const os = await owners(made);
check(os.length === 2 && os.some((o) => eq(o, signer)) && os.some((o) => eq(o, me)), `on chain: new Safe ${made} owned by the wedgie and the wallet`);
check(await num(made, "getThreshold()") === 2, "on chain: 2 of 2");
await wait(() => /2 of 2 owners must sign/.test(document.querySelector("#s-safe").textContent), null, 20000, "its page, 2 of 2");
check(/2 of 2 owners must sign/.test(await page.textContent("#s-safe")), "page: opened the new Safe's own page, 2 of 2");
if (out) await page.screenshot({ path: `${out}/safe-4-made.png`, fullPage: true });
await page.goBack();
await wait((a) => [...document.querySelectorAll("#s-list .safe-row")].filter((r) => a.some((x) => r.getAttribute("href").endsWith(x))).length === 2, [mine, made], 30000, "the list has both (Back button)");
check(true, "Back: the list has both Safes (the new one before Safe's API has it)");
if (out) await page.screenshot({ path: `${out}/safe-5-list.png`, fullPage: true });

check(!errs.length, "no page errors " + errs.join("; "));
await browser.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
