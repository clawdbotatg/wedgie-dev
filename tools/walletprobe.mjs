// /safe's Connect wallet with a browser wallet (Rainbow) wagmi remembers from an earlier visit, and that wallet slow
// to answer: the click must open RainbowKit's picker. It did nothing (Austin, 10-21): a restore in flight keeps
// openConnectModal undefined. node tools/walletprobe.mjs [base url, default http://localhost:4173]
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs"; import { homedir } from "node:os";
const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const b = await chromium.launch({ executablePath: `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
await ctx.addInitScript(() => {
  const me = "0x34aA3F359A9D614239015126635CE7732c18fDF3";
  // a Rainbow-like wallet that never answers eth_accounts quickly (a restore that hangs)
  const eth = { isRainbow: true, isMetaMask: true, on() {}, removeListener() {}, async request({ method }) {
    if (method === "eth_accounts") return new Promise(() => {});
    if (method === "eth_requestAccounts") return [me];
    if (method === "eth_chainId") return "0x1";
    if (method === "wallet_revokePermissions") return new Promise(() => {});   // like a WalletConnect wallet: never answers
    return null; } };
  window.ethereum = eth;
  const info = { uuid: "1", name: "Rainbow", icon: "data:image/svg+xml,<svg/>", rdns: "me.rainbow" };
  const ann = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: eth }) }));
  window.addEventListener("eip6963:requestProvider", ann); ann();
  if (!localStorage.getItem("seeded")) {
    localStorage.setItem("seeded", "1");
    localStorage.setItem("wagmi.recentConnectorId", '"me.rainbow"');
    localStorage.setItem("wagmi.store", JSON.stringify({ state: { connections: { __type: "Map", value: [["u1", { accounts: [me], chainId: 1, connector: { id: "me.rainbow", name: "Rainbow", type: "injected", uid: "u1" } }]] }, chainId: 1, current: "u1" }, version: 2 }));
    localStorage.setItem("wedgie.safe.wallet-off", "1");
  }
});
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto((process.argv[2] || "http://localhost:4173").replace(/\/$/, "") + "/safe"); await p.waitForTimeout(2500);
await p.click("#w-go");
await p.waitForTimeout(3000);
const d = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((x) => [x.getBoundingClientRect().width, x.textContent.slice(0, 80)]));
let bad = 0;
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) bad++; };
check(d.some(([w, t]) => w > 0 && /Connect a Wallet/.test(t) && /Rainbow/.test(t)), "Connect wallet opens the picker, Rainbow in it, with a remembered connection");
// pick it, then Disconnect: the page lets go at once, though the wallet never answers the revoke
await p.locator('[role="dialog"] button', { hasText: "Rainbow" }).first().click();
const on = await p.waitForSelector("#w-off", { timeout: 8000 }).then(() => true, () => false);
check(on, "picked Rainbow: connected (Disconnect shows)");
if (on) {
  await p.click("#w-off");
  check(await p.waitForSelector("#w-go", { timeout: 2000 }).then(() => true, () => false), "Disconnect lets go at once, though the wallet never answers");
}
await b.close();
process.exit(bad ? 1 : 0);
