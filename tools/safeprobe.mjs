// /safe through its buttons, on a Base fork: a fake wedgie running the Safe signer (fakewedgies, its hello
// carries a key), window.ethereum = an anvil account (the browser wallet), Safe's Transaction Service faked
// from the fork's state. Checks:
//   - the page shows the wedgie's signer address
//   - a wallet that owns a 1-of-1 Safe adds the wedgie as an owner: Add box, the signer contract deployed,
//     signed and run at once
//   - Make a new Safe: wallet + wedgie, 2 of 2, one transaction, then the page opens it
// (The wedgie's own signature on chain: tools/safefork.mjs.) Needs anvil and Node 23+.
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
async function rpc(method, params = []) {
  const r = await (await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error });
  return r.result;
}
for (let i = 0; ; i++) { try { await rpc("eth_chainId"); break; } catch { if (i > 100) throw new Error("anvil didn't start"); await new Promise((r) => setTimeout(r, 200)); } }
const [me] = await rpc("eth_accounts");
const view = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const owners = async (safe) => {
  const b = E.bytes(await view(safe, E.selector("getOwners()")));
  return Array.from({ length: Number(BigInt(E.hex(b.slice(32, 64)))) }, (_, i) => E.checksum(E.hex(b.slice(76 + 32 * i, 96 + 32 * i))));
};
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// the wedgie's key (only its public half matters here)
const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
const b64 = (s) => "0x" + Buffer.from(s, "base64url").toString("hex");
const key = { x: b64(jwk.x), y: b64(jwk.y) }, signer = E.signerAddress(key.x, key.y);

// a Safe only the wallet owns, 1 of 1 (made here, not on the page)
const Z32 = new Uint8Array(32);
const setup = E.call("setup(address[],uint256,address,bytes,address,address,uint256,address)",
  [E.dynAddrs([me]), E.word(1), Z32, E.dynBytes("0x"), E.aword(E.FALLBACK_HANDLER), Z32, Z32, Z32]);
const h0 = await rpc("eth_sendTransaction", [{ from: me, to: E.SAFE_FACTORY, data: E.call("createProxyWithNonce(address,bytes,uint256)", [E.aword(E.SAFE_L2), E.dynBytes(setup), E.word(7)]) }]);
let rc = null;
while (!rc) rc = await rpc("eth_getTransactionReceipt", [h0]);
const mine = E.checksum("0x" + rc.logs.find((l) => l.topics[0] === E.PROXY_CREATION).topics[1].slice(26));

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell` });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
await ctx.addInitScript(fakeWedgies, [
  { uid: "aa11bb22cc5afe01", machine: "Raspberry Pi Pico with RP2040", files: { "main.py": 1, "slot.py": 1, "wedgiedrive.py": 1, "wedgie.py": 'VERSION = "0.3.26"',
    "apps.json": JSON.stringify([{ mod: "safe", name: "Safe signer" }]), "safe.py": 1 }, chip: "none", hello: { running: "safe", safe: key } },
]);
// the browser wallet: anvil, on Base
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
// Safe's Transaction Service, from the fork
const queue = [];
await ctx.route("https://api.safe.global/**", async (r) => {
  const u = new globalThis.URL(r.request().url()), cors = { "access-control-allow-origin": "*" };
  const m = u.pathname.match(/\/safes\/(0x[0-9a-fA-F]{40})\/(multisig-transactions\/)?$/);
  if (r.request().method() === "POST") { queue.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 201, headers: cors, body: "" }); }
  if (m && m[2]) return r.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ results: [] }) });
  if (m) {
    if ((await rpc("eth_getCode", [m[1], "latest"])).length <= 2) return r.fulfill({ status: 404, headers: cors, body: "{}" });
    const nonce = Number(BigInt(await view(m[1], E.selector("nonce()")))), threshold = Number(BigInt(await view(m[1], E.selector("getThreshold()"))));
    return r.fulfill({ headers: cors, contentType: "application/json", body: JSON.stringify({ address: m[1], nonce: String(nonce), threshold, owners: await owners(m[1]) }) });
  }
  r.fulfill({ status: 404, headers: cors, body: "{}" });
});

let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const msg = () => page.textContent("#s-msg");
const wait = (fn, arg, ms, what) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, async () => { console.log("STUCK:", what, "|", (await page.textContent("main")).replace(/\s+/g, " ").slice(0, 500)); bad++; return false; });

// 1: an existing Safe the wallet owns: add the wedgie
await page.goto(`${base}/safe?safe=base:${mine}`);
await wait(() => document.querySelector(".safe-addr"), null, 30000, "the wedgie's signer address");
check(eq(await page.textContent(".safe-addr"), signer), `signer address shown: ${signer}`);
await wait(() => !document.querySelector("#s-add")?.hidden, null, 30000, "the Add box");
if (out) await page.screenshot({ path: `${out}/safe-add.png`, fullPage: true });
await page.click("#a-go");
await wait(() => /Done: your wedgie is an owner/.test(document.querySelector("#s-msg").textContent), null, 60000, "added");
check((await owners(mine)).some((o) => eq(o, signer)), "on chain: the wedgie's signer is an owner of the wallet's Safe");
check((await rpc("eth_getCode", [signer, "latest"])).length > 2, "on chain: its signer contract was deployed first");
check(await page.isHidden("#s-add") && /Your wedgie is an owner/.test(await page.textContent("#s-safe")), "page: an owner now, Add box gone");

// 2: a new Safe: wallet + wedgie, 2 of 2
await page.click("#s-new-safe");
await page.click("#c-me");
await wait(() => /of 2 owners/.test(document.querySelector("#c-of").textContent), null, 10000, "2 owners counted");
await page.selectOption("#c-th", "2");
if (out) await page.screenshot({ path: `${out}/safe-new.png`, fullPage: true });
await page.click("#c-go");
await wait(() => /Made your Safe: 0x/.test(document.querySelector("#s-msg").textContent), null, 60000, "made");
const made = (await msg()).match(/0x[0-9a-fA-F]{40}/)[0];
const os = await owners(made);
check(os.length === 2 && os.some((o) => eq(o, signer)) && os.some((o) => eq(o, me)), `on chain: new Safe ${made} owned by the wedgie and the wallet`);
check(Number(BigInt(await view(made, E.selector("getThreshold()")))) === 2, "on chain: 2 of 2");
check(new globalThis.URL(page.url()).search.includes(made), "page: opened the new Safe (its address in the link)");
check(/2 needed to sign/.test(await page.textContent("#s-safe")), "page: shows it, 2 needed");
if (out) await page.screenshot({ path: `${out}/safe-made.png`, fullPage: true });

check(!errs.length, "no page errors " + errs.join("; "));
await browser.close();
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
