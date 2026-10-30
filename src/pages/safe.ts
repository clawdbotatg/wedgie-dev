// wedgie.dev/safe: a wedgie as a signer on a Safe. The wedgie runs the Safe Signer app
// (clawdbotatg/wedgie-safe): its key lives in the secure chip (ATECC608 or Trust M), it shows each transaction and signs on A.
// Its key is a Safe owner through Safe's passkey signer contract (eth.ts signerAddress, no RPC).
// Three views, one page (history.pushState between them, so the wedgie's key is read once), laid out like
// Instant Wallet: a big balance, three buttons, then what's waiting, what it holds, what happened.
//   /safe                    every Safe the wedgie owns on every chain, as cards (Safe's API, plus the ones made
//                            or opened in this browser), the wallet's Safes it could join, New Safe (a sheet)
//   /safe/<chain>:<address>  one Safe: its balance in dollars, Send / Receive / Connect app (sheets), apps'
//                            requests, Waiting (sign, execute, reject, remove), Assets (every token), Activity
//   /safe/<…>/settings       owners, threshold, add the wedgie or an owner, other chains, Safe{Wallet}
//   - the chain is read through /api/rpc (Alchemy): owners, threshold, balances, tokens, prices
//   - the queue (Safe's Transaction Service, through /api/safe with our key): sign on the wedgie or the
//     wallet, execute once enough have signed (a wallet sends it, packSignatures puts them together)
//   - every transaction in plain words (src/safe/describe.ts): "Send 100 USDC to bob.eth"
// Every transaction goes through propose(): one signature, into Safe's queue, where Safe{Wallet} sees it too.
// Safe{Wallet} can't EXECUTE one the wedgie signed: it pastes a contract signature in place and the Safe
// reverts GS021 (safe-wallet-monorepo#8808). packSignatures does it right, so execute here.
// tools/safefork.mjs + safeprobe.mjs (a Base fork) and safelive.mjs (Base Sepolia, the real API) test it.
// Nothing here remembers "the" Safe: a wedgie has many. The list comes from Safe's API (every chain), the
// wedgie itself (safe_list: the Safes it signed for or was told about, wedgie-safe safe-4+; the page tells it
// with safe_note), and this browser's own memory (per wedgie). Each is checked on chain before it's shown.
import { pressModal } from "../ui/askmodal";
import { askYes } from "../ui/askyes";
import * as W from "../serial/wedgies";
import * as Drive from "../serial/drive";
import * as E from "../safe/eth";
import { address, addressInput, addressOf, face, watch } from "../safe/address";
import { describe, type Ctx, type Said } from "../safe/describe";
import { explain, callsOf } from "../safe/explain";
import { readAssets, tokenMeta, knownMeta, usd, type Asset } from "../safe/assets";
import { canScan, scan } from "../safe/scan";
import * as Clear from "../safe/clear";
import * as Sim from "clear-signing-safe-kit";
import { addressQr } from "../safe/qr";
import * as Hist from "../safe/history";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const Z = "0x" + "0".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: any) => e?.message || String(e);

// Every one has the P-256 precompile the wedgie's signer contract uses (checked on chain 2026-10-21: HyperEVM and
// Plasma don't, so a wedgie can't sign there), Safe 1.4.1 and the passkey signer factory. key = Safe's API short
// name (app: app.safe.global's, when it differs). native: the chain's own coin (Arc's is USDC: no second USDC row).
// rpc: only handed to a wallet that adds the chain; the page's own reads go through /api/rpc (readUrl)
type Coin = { symbol: string; name: string; logo: string };
type Chain = { name: string; key: string; app?: string; logo: string; native: Coin; rpc: string; scan: string; usdc?: string; test?: boolean };
const ETHER: Coin = { symbol: "ETH", name: "Ether", logo: "/img/tokens/eth.png" };
const coin = (symbol: string, name: string, f: string): Coin => ({ symbol, name, logo: `/img/tokens/${f}` });
const CHAINS: Record<number, Chain> = {
  8453: { name: "Base", key: "base", logo: "/img/chains/base.webp", native: ETHER, rpc: "https://mainnet.base.org", scan: "https://basescan.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  1: { name: "Ethereum", key: "eth", logo: "/img/chains/ethereum.webp", native: ETHER, rpc: "https://ethereum-rpc.publicnode.com", scan: "https://etherscan.io", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  10: { name: "Optimism", key: "oeth", logo: "/img/chains/optimism.svg", native: ETHER, rpc: "https://mainnet.optimism.io", scan: "https://optimistic.etherscan.io", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  42161: { name: "Arbitrum", key: "arb1", logo: "/img/chains/arbitrum.svg", native: ETHER, rpc: "https://arb1.arbitrum.io/rpc", scan: "https://arbiscan.io", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  137: { name: "Polygon", key: "pol", app: "matic", logo: "/img/chains/polygon.svg", native: coin("POL", "Polygon", "pol.png"), rpc: "https://polygon-rpc.com", scan: "https://polygonscan.com", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  43114: { name: "Avalanche", key: "avax", logo: "/img/chains/avalanche.svg", native: coin("AVAX", "Avalanche", "avax.png"), rpc: "https://api.avax.network/ext/bc/C/rpc", scan: "https://snowtrace.io", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
  56: { name: "BNB Chain", key: "bnb", logo: "/img/chains/bsc.svg", native: coin("BNB", "BNB", "bnb.png"), rpc: "https://bsc-dataseed.bnbchain.org", scan: "https://bscscan.com" },
  100: { name: "Gnosis", key: "gno", logo: "/img/chains/gnosis.svg", native: coin("XDAI", "xDAI", "xdai.png"), rpc: "https://rpc.gnosischain.com", scan: "https://gnosisscan.io", usdc: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0" },
  42220: { name: "Celo", key: "celo", logo: "/img/chains/celo.svg", native: coin("CELO", "Celo", "celo.png"), rpc: "https://forno.celo.org", scan: "https://celoscan.io", usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" },
  146: { name: "Sonic", key: "sonic", logo: "/img/chains/sonic.svg", native: coin("S", "Sonic", "s.png"), rpc: "https://rpc.soniclabs.com", scan: "https://sonicscan.org", usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" },
  5042: { name: "Arc", key: "arc", logo: "/img/chains/arc.svg", native: coin("USDC", "USD Coin", "usdc.png"), rpc: "https://rpc.mainnet.arc.io", scan: "https://explorer.arc.io" },
  4663: { name: "Robinhood", key: "robinhood", logo: "/img/chains/robinhood.svg", native: ETHER, rpc: "https://rpc.mainnet.chain.robinhood.com", scan: "https://robinhoodchain.blockscout.com" },
  84532: { name: "Base Sepolia", key: "basesep", logo: "/img/chains/base.webp", native: ETHER, rpc: "https://sepolia.base.org", scan: "https://sepolia.basescan.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", test: true },
  11155111: { name: "Sepolia", key: "sep", logo: "/img/chains/ethereum.webp", native: ETHER, rpc: "https://ethereum-sepolia-rpc.publicnode.com", scan: "https://sepolia.etherscan.io", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", test: true },
};
const IDS = [8453, 1, 10, 42161, 137, 43114, 56, 100, 42220, 146, 5042, 4663, 84532, 11155111];   // the order they're shown in
const nat = (c: number) => CHAINS[c].native.symbol;
const chainLogo = (t: number) => CHAINS[t] ? `<img class="sx-chain-img" src="${CHAINS[t].logo}" alt="">` : "";
const api = (chain: number) => `https://api.safe.global/tx-service/${CHAINS[chain].key}/api/v1`;
// The queue lives in three places, so a slow or down Safe Transaction Service doesn't stop a Safe: Safe's API,
// Instant Wallet's shared queue (mainnets; it checks each signature on chain), and this browser.
const IWQ = "https://instantwallet.io/api/safe/queue";
const SLOW_MS = 8000;
const appLink = (chain: number, safe: string, path = "home") => `https://app.safe.global/${path}?safe=${CHAINS[chain].app || CHAINS[chain].key}:${safe}`;
// The wedgie drops a USB line over 6 KB, but one near it needs that much RAM in one piece: a 5.7 KB MultiSend ran out
// of memory after the drive grew by a sector (0.3.74, safechip). Over 3 KB, the data goes in safe_data pieces.
const LINE_MAX = 3000;
// clear-sim (github.com/clawdbotatg/clear-sim): runs the tx and signs what goes in and out. The wedgie picks the
// nonce, checks the signature against its own list of simulator keys, and shows a short page first (safe-28+).
const SIM_URL = "https://sim.wedgie.dev";
const DATA_MAX = 8000;      // wedgie-safe safe_data pieces: up to this many bytes (what an RP2040 heap joins safely)

// Safe's service goes through /api/safe (our key: without one Safe allows 5,000 reads a month per IP, and one person's
// page used that up, 10-21), at most 3 at a time (the key: 5 a second). A local preview has no /api: straight there.
const SAFE = "https://api.safe.global/tx-service/";
// q: more for /api/safe (&v=<version> keeps an answer for everyone till the version changes, &fresh=1 asks Safe again)
const via = (url: string, q = "") => {
  const fresh = url.endsWith("?fresh"), u = fresh ? url.slice(0, -6) : url;
  return u.startsWith(SAFE) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? `${location.origin}/api/safe?u=${encodeURIComponent(u.slice(SAFE.length))}${fresh ? "&fresh=1" : ""}${q}` : u;
};
/** Our daily share of Safe's service is used (/api/safe's 429): the rest comes from the chain till tomorrow. */
const REST = "Safe's service is resting till tomorrow.";
let safeBusy = 0;
const safeWait: (() => void)[] = [];
async function safeFetch(url: string, init?: RequestInit, q = "") {
  if (safeBusy >= 3) await new Promise<void>((r) => safeWait.push(r));
  safeBusy++;
  try { return await fetch(via(url, q), init); } finally { safeBusy--; safeWait.shift()?.(); }
}
async function get(url: string, q = "") {
  const r = await safeFetch(url, undefined, q);
  if (!r.ok) throw Object.assign(new Error(`Safe's API: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.json();
}
/** Give up on a slow answer: a busy service never holds the page. */
const within = <T,>(p: Promise<T>, ms = SLOW_MS) => Promise.race([p, sleep(ms).then((): T => { throw new Error("no answer"); })]);
async function post(url: string, body: unknown) {
  const r = await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Safe's API said no: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ---- the chain, read through /api/rpc (the shop's Alchemy key; no wallet needed) ----
const readUrl = (chain: number) => `${location.origin}/api/rpc?chain=${chain}`;
let rpcId = 0;
// /api/rpc down (Vercel or Alchemy): the connected wallet's own RPC, when it's on that chain. Standard reads only
// (no alchemy_ or wedgie_ methods). For a minute after a failure, that chain's reads go to the wallet first.
const rpcDown: Record<number, number> = {};
async function walletRead(chain: number, method: string, params: unknown[]): Promise<{ result: any } | null> {
  if (!wcp || !method.startsWith("eth_")) return null;
  try { if (Number(await wcp.request({ method: "eth_chainId" })) !== chain) return null; } catch { return null; }
  return { result: await wcp.request({ method, params }) };     // a revert throws, as it does from /api/rpc
}
/** A burst can be rate-limited (a list of Safes reads several at once): wait and try again. */
async function rpc(chain: number, method: string, params: unknown[]): Promise<any> {
  for (let i = 0; ; i++) {
    if (Date.now() - (rpcDown[chain] || 0) < 60_000) { const w = await walletRead(chain, method, params); if (w) return w.result; }
    try {
      const res = await fetch(readUrl(chain), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      // 429: /api/rpc's own limit ("Too many reads") or Alchemy's ("Busy."): say which
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`${CHAINS[chain].name}: ${(await res.json().catch(() => null))?.error || "busy"} (${res.status})`), { again: true });
      const r = await res.json();
      if (r.error) throw new Error(`${CHAINS[chain].name}: ${r.error.message || r.error}`);    // a JSON-RPC error, or /api/rpc's own
      return r.result;
    } catch (e: any) {
      // TypeError: the fetch itself failed. ~80 s of tries: /api/rpc's limit is per minute
      if (i >= 8 || !(e.again || e instanceof TypeError)) throw e;
      if (!rpcDown[chain] || Date.now() - rpcDown[chain] >= 60_000) {
        rpcDown[chain] = Date.now();
        const w = await walletRead(chain, method, params);
        if (w) return w.result;
      }
      await sleep(Math.min(600 * 2 ** i, 20_000));
    }
  }
}
const TX_LINK = "#tx=";     // a link to a waiting transaction (txLink)
const rpcOf = (chain: number) => (method: string, params: unknown[]) => rpc(chain, method, params);

// History, how a Safe was made, and "did it run" come from Safe's API or the chain (src/safe/history.ts). COMPARE: both
// asked, Safe's shown when it answers, the chain's when it doesn't, and whether they matched goes to /api/safe (PUT,
// once per Safe and thing per page) so we know when the chain alone is enough. Then: the chain first, Safe's API only
// when it fails (we get 1,500 Safe calls a day).
const COMPARE = true;
const compared = new Set<string>();
function report(what: string, c: number, a: string, diffs: string[]) {
  const k = `${what}:${c}:${a.toLowerCase()}`;
  if (compared.has(k)) return;
  compared.add(k);
  const real = diffs.filter((d) => !d.startsWith("("));
  if (real.length) console.warn(`/safe ${what} on ${CHAINS[c].name}: Safe's API and the chain differ`, real);
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  fetch("/api/safe", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ what, chain: c, safe: a, diffs: real.slice(0, 20) }) }).catch(() => {});
}
/** Safe's answer and the chain's, both asked: Safe's if it has one (diffs reported), else the chain's, else Safe's error. */
async function either<T>(what: string, c: number, a: string, svc: () => Promise<T>, chain: () => Promise<T>, diff: (s: T, h: T) => string[]): Promise<T> {
  if (!COMPARE) { try { return await within(chain(), 20_000); } catch { return svc(); } }
  const [s, h] = await Promise.allSettled([svc(), within(chain(), 20_000)]);
  if (s.status === "fulfilled") {
    report(what, c, a, h.status === "fulfilled" ? diff(s.value, h.value) : [`chain: ${msgOf(h.reason)}`]);
    return s.value;
  }
  if (h.status === "fulfilled") return h.value;
  throw s.reason;
}

// Our own list of who owns which Safe (api/safes.ts: the owners read on chain there), so a person's Safes are found
// when Safe's API is down. Each Safe the page reads is sent once a day; the list asks it for the owners' Safes.
const TOLD = "wedgie.safe.told";
let toTell: { chain: number; safe: string }[] = [], tellTimer = 0;
function tellOurs(c: number, a: string) {
  if (CHAINS[c].test || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const k = `${c}:${a.toLowerCase()}`;
  let told: Record<string, number> = {};
  try { told = JSON.parse(localStorage.getItem(TOLD) || "{}"); } catch {}
  if (Date.now() - (told[k] || 0) < 86_400_000 || toTell.some((x) => x.chain === c && x.safe.toLowerCase() === a.toLowerCase())) return;
  toTell.push({ chain: c, safe: a });
  clearTimeout(tellTimer);
  tellTimer = window.setTimeout(() => {
    const go = toTell.splice(0, 20);
    fetch("/api/safes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ safes: go }) }).then((r) => {
      if (!r.ok) return;
      try { const t = JSON.parse(localStorage.getItem(TOLD) || "{}"); for (const x of go) t[`${x.chain}:${x.safe.toLowerCase()}`] = Date.now(); localStorage.setItem(TOLD, JSON.stringify(t)); } catch {}
    }).catch(() => {});
  }, 1500);
}
/** The Safes our list has for these owners: chain:address → which owner. Nothing if it isn't answering. */
const ourSafes = (owners: string[]): Promise<{ chain: number; safe: string; owner: string }[]> =>
  owners.length ? within(fetch(`/api/safes?owners=${owners.join(",")}`).then((r) => r.json())).then((j) => j.safes || []).catch(() => []) : Promise.resolve([]);

const view = (chain: number, to: string, data: string) => rpc(chain, "eth_call", [{ to, data }, "latest"]);
const hasCode = async (chain: number, a: string) => (await rpc(chain, "eth_getCode", [a, "latest"])).length > 2;

// ---- a browser wallet (EIP-1193): pays the gas, and can sign as an owner ----
// Always through RainbowKit (safe/rainbow.ts): you pick the wallet, even with one in the browser (Austin, 10-21:
// it went straight to Rainbow, no way to WalletConnect another). wcp is the connected wallet's provider.
let wcp: any = null;
const WCP = "wedgie.safe.wc";        // set once a wallet connected this way: its session is restored on the next visit
const eth = () => wcp;
// Loaded once, early (see the end of mount): each deploy deletes the last one's chunks, so a page left open
// across a deploy failed at Make it with "Failed to fetch dynamically imported module" (Austin, 10-21)
let rk: Promise<typeof import("../safe/rainbow")> | null = null;
const rainbow = () => rk ??= import("../safe/rainbow").catch((e) => {
  rk = null;
  throw /dynamically imported|Importing a module script/i.test(String(e?.message)) ? new Error("wedgie.dev was just updated. Reload the page.") : e;
});
async function wallet(chain: number): Promise<string> {
  if (!eth()) { wcp = await (await rainbow()).connect(); try { localStorage.setItem(WCP, "1"); } catch {} }
  const [from] = await eth().request({ method: "eth_requestAccounts" });
  const want = "0x" + chain.toString(16);
  if ((await eth().request({ method: "eth_chainId" })) !== want) {
    try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
    catch (e: any) {
      if (e?.code !== 4902) throw e;       // the wallet doesn't know this chain yet: add it
      const c = CHAINS[chain];
      await eth().request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: c.name, rpcUrls: [c.rpc],
        nativeCurrency: { name: c.native.name, symbol: c.native.symbol, decimals: 18 }, blockExplorerUrls: [c.scan] }] });
    }
  }
  return E.checksum(from);
}
async function send(chain: number, to: string, data: string, say: (s: string, pct?: number) => void, value = "0x0"): Promise<any> {
  say("Getting your wallet.", 4);
  const from = await wallet(chain);
  say("Opening your wallet: confirm it there.", 10);
  const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from, to, data, value }] });
  for (let i = 0; i < 160; i++) {
    say("Sent. Waiting for it to land in a block.", 20 + 50 * (1 - 0.85 ** i));
    // our own RPC: a wallet over WalletConnect often never answers this (Austin, 10-21: stuck on "Sent" forever)
    const r = await rpc(chain, "eth_getTransactionReceipt", [hash]).catch(() => null)
      || await within(eth().request({ method: "eth_getTransactionReceipt", params: [hash] }), 3000).catch(() => null);
    if (r) { if (r.status !== "0x1") throw new Error(`It failed on chain: ${CHAINS[chain].scan}/tx/${hash}`); return r; }
    await sleep(1500);
  }
  throw new Error("Still not in a block: " + hash);
}

type Info = { owners: string[]; threshold: number; nonce: number; balance: bigint; usdc: bigint | null };
type Row = { chain: number; addr: string; wedgie: boolean; wallet: boolean; info?: Info | null; err?: string; gone?: boolean };
const KEYS = Object.fromEntries(IDS.map((id) => [CHAINS[id].key, id]));
const route = (chain: number, a: string) => `/safe/${CHAINS[chain].key}:${a}`;

/** The wedgie's Safes as /safe last listed them, for the top bar (main.ts). Only what this browser saved: never a
 * chain or Safe's API (Austin, 10-22). Dollars as the card showed them; null: no price, or a test chain.
 * One entry per Safe address, its chains added together. */
export function savedSafes(): { addr: string; chain: number; href: string; usd: number | null }[] {
  try {
    const l = JSON.parse(localStorage.getItem("wedgie.safe.last") || "null"), full = JSON.parse(localStorage.getItem("wedgie.safe.usd") || "{}");
    return (Array.isArray(l?.rows) ? l.rows : []).filter((r: any) => CHAINS[r.chain] && r.info && !r.gone).map((r: any) => {
      const f = full[`${r.chain}:${r.addr.toLowerCase()}`], px = l.px?.[r.chain];
      const usd = CHAINS[r.chain].test ? null : f && f.b === String(r.info.balance) && f.u === String(r.info.usdc) ? f.usd
        : px ? Number(r.info.balance) / 1e18 * px + Number(r.info.usdc || 0) / 1e6 : null;
      return { addr: r.addr, chain: r.chain, href: route(r.chain, r.addr), usd };
    }).sort((a: any, b: any) => (b.usd || 0) - (a.usd || 0)).reduce((out: { addr: string; chain: number; href: string; usd: number | null }[], s: any) => {
      // one Safe on many chains: one pill, its dollars added up, opening the chain with the most
      const o = out.find((x) => x.addr.toLowerCase() === s.addr.toLowerCase());
      if (!o) out.push(s);
      else if (s.usd !== null) o.usd = (o.usd || 0) + s.usd;
      return out;
    }, []);
  } catch { return []; }
}

/** Owners, threshold, nonce, balances: from the chain, not Safe's API (which can lag a block or more). One read
 * (Multicall3): a page with many Safes on many chains stays under /api/rpc's limit. */
async function readSafe(c: number, a: string): Promise<Info> {
  const u = CHAINS[c].usdc, calls = [{ to: a, allowFailure: true, data: E.selector("getOwners()") },
    { to: a, allowFailure: true, data: E.selector("getThreshold()") }, { to: a, allowFailure: true, data: E.selector("nonce()") },
    { to: E.MULTICALL3, allowFailure: true, data: E.call("getEthBalance(address)", [E.aword(a)]) },
    ...(u ? [{ to: u, allowFailure: true, data: E.call("balanceOf(address)", [E.aword(a)]) }] : [])];
  const [owners, th, n, bal, usdc] = E.unaggregate(await view(c, E.MULTICALL3, E.aggregate3(calls)));
  // no code there: every call "works" and says nothing; not a Safe: getOwners fails
  if (!owners.ok || owners.data.length < 130 || !th.ok || !n.ok) throw Object.assign(new Error(`There's no Safe at ${short(a)} on ${CHAINS[c].name}.`), { gone: true });
  return { owners: E.addrs(owners.data), threshold: Number(BigInt(th.data)), nonce: Number(BigInt(n.data)), balance: BigInt(bal.data),
    usdc: usdc?.ok && usdc.data.length > 2 ? BigInt(usdc.data) : null };
}

// ---- what a Safe has besides owners: modules (each can move money without the owners) and guards ----
// No standard says what a module does. What works: NAME()/VERSION() (Safe's and Candide's), a 4337 module's
// SUPPORTED_ENTRYPOINT(), Zodiac's avatar() (Roles answers allowances(), Delay txCooldown()). Instant Wallet uses
// Candide's recovery (7, 14 or 60 days: no getter, so by address) and Zodiac Roles for the phone's daily limit
// (its keys: instant-wallet web/lib/safe/config.ts). Read only: nothing here changes a module.
type Limit = { sym: string; dec: number; max: bigint; left: bigint; days: number };
type Addon = { addr: string; kind: "recovery" | "limit" | "roles" | "allowance" | "delay" | "4337" | "other"; name: string;
  guardians?: string[]; need?: number; days?: number; running?: { owners: string[]; at: number; approvals: number };
  members?: string[]; limits?: Limit[]; who?: { addr: string; limits: Limit[] }[]; wait?: number };
type Addons = { mods: Addon[]; guards: string[] };
const RECOVERY_DAYS: Record<string, number> = { "0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2": 7,
  "0x9bacd92f4687db306d7ded5d4513a51ea05df25b": 14, "0x6aa9a8ad0582db61a97a6e30eba22ba143d1e960": 60 };
const IW_KEYS = { usdc: E.hex(E.keccakText("instant-wallet.burner.usdc")), eth: E.hex(E.keccakText("instant-wallet.burner.eth")) };
// Safe's storage slots: the guard (checks every transaction), the module guard (Safe 1.5: checks module calls)
const GUARD_SLOTS = ["guard_manager.guard.address", "module_manager.module_guard.address"].map((k) => E.hex(E.keccakText(k)));
const wd = (d: string, i: number) => BigInt("0x" + (d.slice(2 + 64 * i, 66 + 64 * i) || "0"));
const wAddr = (d: string, i: number) => E.checksum("0x" + d.slice(26 + 64 * i, 66 + 64 * i));
/** An address[] whose head is word i (its offset counted from word `base`). */
const arrAt = (d: string, i: number, base = 0) => { const o = base + Number(wd(d, i)) / 32; return Array.from({ length: Math.min(50, Number(wd(d, o))) }, (_, k) => wAddr(d, o + 1 + k)); };
const str = (d: string) => { try { const o = Number(wd(d, 0)) / 32, n = Number(wd(d, o)), h = d.slice(2 + 64 * (o + 1), 2 + 64 * (o + 1) + 2 * n);
  return new TextDecoder().decode(E.bytes("0x" + h)).replace(/[^\x20-\x7e]/g, "").slice(0, 40); } catch { return ""; } };
/** A Zodiac Roles allowance now: its balance plus refills since, capped (instant-wallet state.ts avail). */
function rolesLimit(d: string, sym: string, dec: number): Limit | null {
  const [refill, max, period, balance, at] = [0, 1, 2, 3, 4].map((i) => wd(d, i));
  if (!max) return null;
  const n = period && BigInt(Math.floor(Date.now() / 1000)) > at ? (BigInt(Math.floor(Date.now() / 1000)) - at) / period : 0n;
  const b = balance + n * refill;
  return { sym, dec, max, left: b > max ? (balance > max ? balance : max) : b, days: Number(period) / 86400 };
}
async function readAddons(c: number, safe: string): Promise<Addons> {
  const many = async (calls: { to: string; data: string }[]) => calls.length ? E.unaggregate(await view(c, E.MULTICALL3, E.aggregate3(calls.map((x) => ({ ...x, allowFailure: true }))))) : [];
  const [mods, ...gs] = await many([{ to: safe, data: E.call("getModulesPaginated(address,uint256)", [E.aword(E.SENTINEL), E.word(20)]) },
    ...GUARD_SLOTS.map((s) => ({ to: safe, data: E.call("getStorageAt(uint256,uint256)", [E.word(s), E.word(1)]) }))]);
  const guards = gs.filter((g) => g.ok && g.data.length >= 194 && wd(g.data, 2) !== 0n).map((g) => wAddr(g.data, 2));
  const list = mods.ok && mods.data.length >= 194 ? arrAt(mods.data, 0) : [];
  const probes = (m: string) => [E.selector("NAME()"), E.selector("SUPPORTED_ENTRYPOINT()"), E.call("getGuardians(address)", [E.aword(safe)]),
    E.call("threshold(address)", [E.aword(safe)]), E.call("getRecoveryRequest(address)", [E.aword(safe)]), E.selector("avatar()"),
    E.selector("txCooldown()"), E.call("getModulesPaginated(address,uint256)", [E.aword(E.SENTINEL), E.word(20)]),
    E.call("allowances(bytes32)", [E.word(IW_KEYS.usdc)]), E.call("allowances(bytes32)", [E.word(IW_KEYS.eth)]),
    E.call("getDelegates(address,uint48,uint8)", [E.aword(safe), E.word(0), E.word(10)])].map((data) => ({ to: m, data }));
  const got = await many(list.flatMap(probes));
  const usdc = CHAINS[c].usdc;
  const out: Addon[] = [];
  for (const [k, m] of list.entries()) {
    const [name, ep, gd, th, req, av, cool, mem, au, ae, del] = got.slice(k * 11, k * 11 + 11), ok = (x: { ok: boolean; data: string }, n = 66) => x.ok && x.data.length >= n;
    const nm = ok(name, 194) ? str(name.data) : "";
    if (ok(gd, 130) && ok(th) && ok(req, 386)) {
      const r = req.data, t = Number(wd(r, 0)) / 32, at = Number(wd(r, t + 2)) * 1000;
      out.push({ addr: m, kind: "recovery", name: nm || "Social recovery", guardians: arrAt(gd.data, 0), need: Number(wd(th.data, 0)),
        days: RECOVERY_DAYS[m.toLowerCase()], running: at ? { owners: arrAt(r, t + 3, t), at, approvals: Number(wd(r, t)) } : undefined });
    } else if (ok(ep) && wd(ep.data, 0) >> 160n === 0n && wd(ep.data, 0)) out.push({ addr: m, kind: "4337", name: nm || "4337 module" });
    else if (/allowance module/i.test(nm) && ok(del, 194)) out.push({ addr: m, kind: "allowance", name: nm, members: arrAt(del.data, 0) });
    else if (ok(av) && ok(au, 322)) {
      const limits = [usdc && rolesLimit(au.data, "USDC", 6), rolesLimit(ae.data, nat(c), 18)].filter((x): x is Limit => !!x);
      out.push({ addr: m, kind: limits.length ? "limit" : "roles", name: "Zodiac Roles", limits, members: ok(mem, 194) ? arrAt(mem.data, 0) : [] });
    } else if (ok(av) && ok(cool)) out.push({ addr: m, kind: "delay", name: "Zodiac Delay", wait: Number(wd(cool.data, 0)) });
    else out.push({ addr: m, kind: "other", name: nm });
  }
  // Safe's own spending limit: each delegate's tokens, then each token's allowance [amount, spent, reset minutes, …]
  for (const a of out.filter((x) => x.kind === "allowance")) {
    const del = a.members!, toks = await many(del.map((d) => ({ to: a.addr, data: E.call("getTokens(address,address)", [E.aword(safe), E.aword(d)]) })));
    const pairs = del.flatMap((d, i) => toks[i].ok && toks[i].data.length >= 130 ? E.addrs(toks[i].data).slice(0, 5).map((t) => [d, t]) : []);
    const al = await many(pairs.map(([d, t]) => ({ to: a.addr, data: E.call("getTokenAllowance(address,address,address)", [E.aword(safe), E.aword(d), E.aword(t)]) })));
    a.who = del.map((d) => ({ addr: d, limits: [] }));
    for (const [i, [d, t]] of pairs.entries()) {
      if (!al[i].ok || al[i].data.length < 322) continue;
      const amt = wd(al[i].data, 0), spent = wd(al[i].data, 1), reset = Number(wd(al[i].data, 2)), last = Number(wd(al[i].data, 3));
      const due = reset > 0 && Date.now() / 60000 > last + reset;     // past its reset: the whole amount again
      const meta = Number(BigInt(t)) === 0 ? { symbol: nat(c), decimals: 18 } : knownMeta(c, t) || await tokenMeta(c, t, (mm, p) => rpc(c, mm, p)).catch(() => null);
      a.who.find((w) => w.addr === d)!.limits.push({ sym: meta?.symbol || short(t), dec: meta?.decimals ?? 18, max: amt, left: due ? amt : amt > spent ? amt - spent : 0n, days: reset / 1440 });
    }
  }
  return { mods: out, guards };
}

export function safe(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page safe-page">
    <div class="safe-ids" id="s-ids"><div class="safe-id" id="s-me" data-copy-warn="Don't send tokens here! Only for adding to a Safe." hidden></div><div class="safe-id safe-id-wallet" id="s-wallet" hidden></div></div>
    <div class="sx-spin" id="s-spin" hidden aria-label="Loading"></div>
    <div class="sx-first" id="s-first" hidden><div class="sx-spin sx-spin-big"></div></div>
    <div class="sx-banner" id="s-wedgie" hidden></div>
    <div class="sx-view" id="s-list" hidden></div>
    <div class="sx-card sx-iw" id="s-iw" hidden></div>
    <div class="sx-hero" id="s-safe" hidden></div>
    <div class="sx-banner" id="s-add" hidden></div>
    <div class="sx-card" id="s-queue" hidden></div>
    <div class="sx-card" id="s-apps" hidden></div>
    <div class="sx-card" id="s-assets" hidden></div>
    <div class="sx-card" id="s-activity" hidden></div>
    <div class="sx-card" id="s-owners" hidden></div>
    <div class="sx-card" id="s-addons" hidden></div>
    <div class="sx-card" id="s-owner" hidden></div>
    <div class="sx-card" id="s-chains" hidden></div>
    <p class="safe-msg" id="s-msg" hidden></p>
    <div class="safe-dock" id="s-dock" hidden><div class="safe-dock-row" id="s-dock-tx"></div><div id="s-dock-msg"></div></div>
    <div class="sx-sheet" id="s-sheet" hidden><div class="sx-sheet-card" role="dialog" aria-modal="true">
      <button class="sx-x" id="s-sheet-x" type="button" aria-label="Close">×</button>
      <div id="s-create" hidden></div><div id="s-new" hidden></div><div id="s-receive" hidden></div><div id="s-wc" hidden></div>
      <div class="sx-sheet-msg" id="s-sheet-msg" hidden></div>
    </div></div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  document.getElementById("connect-btn")?.before($("s-me"));   // the wedgie's address sits beside its Connected button
  let key: { x: string; y: string } | null = null, signer = "", signers: string[] = [], wedgie: W.Wedgie | null = null, asking = false, noKey: boolean | string = false;
  // In the iPhone app there's no serial port: the wedgie is reached through its WEDGIE drive (serial/drive.ts).
  const DRIVE = { key: -1, state: "ready", running: "safe", short: "", log: "" } as unknown as W.Wedgie;
  let driveState = "";
  const ask = <T,>(w: W.Wedgie, fn: (r: Drive.Asker) => Promise<T>): Promise<T> => w === DRIVE ? Drive.withDrive(fn) : W.withRepl(w, fn);
  const present = (w: W.Wedgie) => w === DRIVE ? driveState === "here" : W.wedgies().includes(w);
  // a wedgie gone: its address and list stay (a reload shows them); the next key read says if it's another
  if (Drive.inApp()) {
    const look = async () => { const s = await Drive.status().catch(() => "away"); if (s !== driveState) { driveState = s; if (s !== "here") { wedgie = null; key = null; } paintAll(); } };
    look(); setInterval(look, 1500);
  }
  let chunk = 0;          // hex chars per safe_data piece (its hello's safe_chunk), 0: this app can't take pieces
  let clearTag = "";      // the clear-signing data its app trusts (its hello's safe_clear), "": none (an older app)
  let simOk = false;      // its app checks a clear-sim answer (its hello's safe_sim: "p256")
  let reviewRound = 0;    // the clear-review round its app saved (hello's safe_review; sent newer below), 0: none
  let onWedgie: string[] | null = null;   // the wedgie's own list ("8453:0x.."), null: its app keeps none
  let account = "", busy = false;
  // the view: null = the list; else one Safe
  let chain = 8453, safeAddr = "", info: Info | null = null, queue: any[] = [];
  let rows: Row[] = [], listing = false, listPct = 8;
  let newChain = 8453, showWallet = false;   // the wallet's own Safes: folded away (the wedgie's are the point)
  const OFF = "wedgie.safe.wallet-off";      // Disconnect sticks: no reconnecting by itself on the next visit
  const deployed: Record<number, boolean | undefined> = {};
  // this Safe on the other chains: there (true), not yet (false), unknown; recipe = how it was made, to make it again
  let copies: Record<number, boolean | undefined> = {}, recipe: E.Recipe | null = null;
  let worths: Record<number, number | null> = {}, looked = false, checked = false;   // checked: every chain was asked just now   // this Safe's dollars on each chain it's on (null: no price)
  let queueNote = "";        // which queue sources didn't answer just now
  let sub: "home" | "settings" = "home";
  let assets: Asset[] | null = null;              // what the open Safe holds (null: not read yet)
  let activity: any[] | null = null, activityErr = "";
  let addons: Addons | null = null;               // its modules and guards (null: not read yet)
  const ethPx: Record<number, number | null> = {};   // the native coin's dollar price per chain, for the list's totals
  // Each Safe's full dollars per chain (every token, as its page counts them), saved with the coin and USDC balances it
  // was read at: the card shows the same number as the Safe's page. Balances changed since: coin + USDC till read again.
  const FULL = "wedgie.safe.usd";
  let fullUsd: Record<string, { usd: number; b: string; u: string }> = {};
  try { fullUsd = JSON.parse(localStorage.getItem(FULL) || "{}"); } catch {}
  const fk = (c: number, a: string) => `${c}:${a.toLowerCase()}`;
  const setFull = (c: number, a: string, i: Info, usd: number) => {
    fullUsd[fk(c, a)] = { usd, b: String(i.balance), u: String(i.usdc) };
    try { localStorage.setItem(FULL, JSON.stringify(fullUsd)); } catch {}
    // the saved list's row too: its old balances wouldn't match the new dollars, and the top bar would guess from them
    const r = rows.find((r) => r.chain === c && eqA(r.addr, a));
    if (r?.info) r.info = { ...r.info, balance: i.balance, usdc: i.usdc };
    try {
      const l = JSON.parse(localStorage.getItem(LAST) || "null"), s = l?.rows?.find((r: any) => r.chain === c && eqA(r.addr, a));
      if (s?.info) { s.info.balance = String(i.balance); s.info.usdc = i.usdc === null ? null : String(i.usdc); localStorage.setItem(LAST, JSON.stringify(l)); }
    } catch {}
    dispatchEvent(new Event("wedgie-safes"));     // the top bar's Safes (main.ts)
  };
  const priced = new Set<string>();     // read in full on this visit
  // a sheet over the page (a bottom sheet on a phone): one at a time
  let sheet: "" | "create" | "send" | "receive" | "connect" = "", sendToken: string | null = null;

  // the old page's "last Safe" (it opened that one every time): moved into the list once the wedgie is read
  let oldSaved = "";
  try { oldSaved = localStorage.getItem("wedgie.safe") || ""; } catch {}
  const old = new URLSearchParams(location.search).get("safe")?.match(/^(\w+):(0x[0-9a-fA-F]{40})$/);
  if (old && KEYS[old[1]]) history.replaceState(null, "", route(KEYS[old[1]], E.checksum(old[2])));
  // /safe/<chain>:<addr>?wc=<link>: connect that app as soon as the Safe is read (one step, for agents too).
  // Last in the query; its own ?/& may come encoded or not. Dropped from the URL so a reload doesn't pair again.
  let wcLink = "";
  const wcq = location.search.match(/[?&]wc=(.*)$/);
  if (wcq) {
    wcLink = /^wc%3A/i.test(wcq[1]) ? decodeURIComponent(wcq[1]) : wcq[1];
    history.replaceState(null, "", location.pathname + location.search.slice(0, wcq.index).replace(/^&/, "?"));
  }

  /** The message box. A number instead of bad: a progress bar under it, that far along (0-100). */
  // While a bar is up it keeps creeping (1-2% every half second, slower near the end), so a wait never looks
  // stuck; each new step jumps it ahead if it's behind (Austin).
  let barAt = 0, creep = 0;
  const paintBar = () => document.querySelectorAll<HTMLElement>("#s-msg .meter-fill, #s-dock-msg .meter-fill, #s-sheet-msg .meter-fill").forEach((f) => f.style.width = `${barAt}%`);
  const say = (s: string, bad: boolean | number = false) => {
    const el = $("s-msg");
    el.hidden = !s;
    const bar = typeof bad === "number";
    if (bar) barAt = Math.max(barAt, Math.max(8, Math.min(100, bad)));
    $("s-sheet-msg").hidden = !s;
    $("s-sheet-msg").innerHTML = $("s-dock-msg").innerHTML = el.innerHTML = bar
      ? `${esc(s)}<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${barAt}%"></div></div></div>`
      : bad ? `<b class="bad">${esc(s)}</b>` : esc(s);
    clearInterval(creep);
    if (bar) creep = window.setInterval(() => { barAt = Math.min(97, barAt + Math.max(0.3, Math.min(2, (97 - barAt) * 0.04))); paintBar(); }, 500);
    else barAt = 0;
  };
  const fail = (e: any) => { say(msgOf(e), true); };
  const eqA = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOwner = (a: string) => !!info && !!a && info.owners.some((o) => eqA(o, a));
  // signer = the wedgie's own address; signers = every address its key can own a Safe as (Instant Wallet's two too)
  const mine = (a: string) => signers.some((s) => eqA(s, a));
  /** The wedgie's owner slots on this Safe: one, or Instant Wallet's two (one press signs for both). */
  const ownedBy = () => (info ? info.owners.filter(mine) : []);
  const wedgieOwns = () => ownedBy().length > 0;
  /** Instant Wallet's Safe: the wedgie is an owner through one of IW's two signer addresses. */
  const isIW = (owners: string[]) => signers.slice(1).some((s) => owners.some((o) => eqA(o, s)));
  const iwMark = `<img class="iw-mark" src="/img/instantwallet.png" alt="Instant Wallet" title="Instant Wallet">`;
  const nextNonce = () => Math.max(info!.nonce, ...queue.map((t) => +t.nonce + 1));
  const threshOpts = (n: number, at: number) => Array.from({ length: n }, (_, i) => `<option${i + 1 === at ? " selected" : ""}>${i + 1}</option>`).join("");
  const label = (a: string) => mine(a) ? " <b>this wedgie</b>" : eqA(a, account) ? " <b>your wallet</b>" : "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const chainOpts = (at: number) => IDS.map((id) => [id, CHAINS[id]] as const).map(([id, c]) => `<option value="${id}"${+id === at ? " selected" : ""}>${esc(c.name)}${c.test ? " (test)" : ""}</option>`).join("");
  /** Run one thing at a time; buttons say so while it runs. */
  async function job(fn: () => Promise<unknown>, reads = true) {     // reads false: fn signs nothing (Connect wallet)
    if (busy) return;
    busy = true; paintAll();
    try {
      // the saved copy is up: read the chain first, so nothing signs off an old nonce
      if (reads && stale && safeAddr) { say("Reading the Safe from the chain."); await load(true); if (stale) throw new Error(`Can't read the Safe from ${CHAINS[chain].name} right now. Try again in a minute.`); say(""); }
      await fn();
    } catch (e) { fail(e); } finally { busy = false; paintAll(); }
  }
  // a button that's off says why on hover. stale (the saved copy on screen) doesn't turn them off: job reads first
  const dis = (extra = false) => {
    const why = busy ? "Wait: something is running." : asking ? "Answer your wedgie first." : "";
    return why ? ` disabled title="${why}"` : extra ? " disabled" : "";
  };
  /** Why the wedgie can't sign right now, in plain words (the wedgie buttons stay on and say this when pressed). */
  const noWedgie = () => {
    if (Drive.inApp()) return driveState === "here" ? "Reading your wedgie. Try again in a second." : "Plug in your wedgie.";
    const ws = W.wedgies().filter((w) => w.state === "ready");
    if (!ws.length) return "Plug in your wedgie and press Connect.";
    if (!ws.some((w) => w.running === "safe")) return "Your wedgie isn't running Safe Signer.";
    return noKey ? "Press green on your wedgie to make its key." : "Reading your wedgie. Try again in a second.";
  };

  // ---- plain words for a transaction (src/safe/describe.ts) ----
  const asked = new Set<string>();     // token contracts whose metadata is being fetched
  const ctx = (): Ctx => ({
    safe: safeAddr, owners: info?.owners.length || 1, native: nat(chain),
    addr: (a) => eqA(a, safeAddr) ? "this Safe" : address(a, { size: "sm", chain, link: CHAINS[chain].scan }),
    token: (a) => {
      const m = knownMeta(chain, a);
      if (!m && !asked.has(a.toLowerCase())) { asked.add(a.toLowerCase()); const c = chain; tokenMeta(c, a, (m, p) => rpc(c, m, p)).then((x) => { if (x && c === chain) paintAll(); }); }
      return m;
    },
    price: (t) => priceOf(t),
  });
  /** A coin's dollar price from the Assets card, when it's already loaded (null: the coin itself). */
  const priceOf = (token: string | null) => assets?.find((a) => token === null ? a.token === null : !!a.token && eqA(a.token, token))?.price ?? null;
  // what describe.ts can't read: clear signing, else 🤖 (src/safe/explain.ts)
  const said = (t: any) => { const s = describe(t, ctx(), t.dataDecoded?.method); return explain(s, callsOf(t, s), chain, safeAddr, ctx().addr, paintAll); };
  // the copy icon, the same one Instant Wallet draws
  const COPY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>`;
  const ICON: Record<Said["kind"], string> = { send: "↑", approve: "✓", owners: "👥", cancel: "⨯", batch: "≡", call: "⚙", danger: "!" };
  const subsOf = (s: Said) => s.subs?.length ? `<ol class="sx-subs">${s.subs.map((x) => `<li>${x.title}</li>`).join("")}</ol>` : "";
  /** The Safe's total in dollars, when every price that matters is known; else null. */
  const total = () => assets && assets[0].price !== null ? assets.reduce((n, a) => n + (a.usd || 0), 0) : null;
  const ago = (iso: string) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago`
      : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 3e7 ? "numeric" : undefined });
  };
  const tokenBadge = (sym: string, logo?: string | null) => {
    if (logo) return `<img class="sx-tok sx-tok-img" src="${esc(logo)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'sx-tok',textContent:${esc(JSON.stringify(sym.slice(0, 1).toUpperCase()))}}))">`;
    let h = 0; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="sx-tok" style="--h:${h}">${esc(sym.slice(0, 1).toUpperCase())}</span>`;
  };
  const can = () => wedgieOwns() || isOwner(account);    // someone here can sign for this Safe
  /** A token as a row: its logo (this chain's in the corner), symbol and name, its dollars and amount (Assets, and Send's picker). */
  const assetInner = (a: Asset) => `<span class="sx-tok-on">${tokenBadge(a.symbol, a.logo)}${chainLogo(chain)}</span>
      <span class="sx-asset-name"><b>${esc(a.symbol)}</b><span class="fine">${esc(a.name)}</span></span>
      <span class="sx-asset-amt">${a.usd !== null ? `<b>${esc(usd(a.usd))}</b><span class="fine">${esc(E.fmt(a.balance, a.decimals, 4))} ${esc(a.symbol)}</span>` : `<b>${esc(E.fmt(a.balance, a.decimals, 4))}</b>`}</span>`;

  // Safes made or opened in this browser, per wedgie: Safe's API lists a new one only seconds later
  const memKey = () => `wedgie.safes.${signer.toLowerCase()}`;
  const remembered = (): string[] => { try { return JSON.parse(localStorage.getItem(memKey()) || "[]"); } catch { return []; } };
  const remember = (c: number, a: string) => {
    const k = `${CHAINS[c].key}:${E.checksum(a)}`, m = remembered();
    if (signer && !m.includes(k)) localStorage.setItem(memKey(), JSON.stringify([k, ...m]));
  };
  const forget = (c: number, a: string) => localStorage.setItem(memKey(), JSON.stringify(remembered().filter((k) => k !== `${CHAINS[c].key}:${E.checksum(a)}`)));

  // The last list, saved: a reload shows it at once (before the wedgie answers, before every chain is asked),
  // then the page checks again and repaints. Only addresses and balances: nothing that signs.
  const LAST = "wedgie.safe.last";
  const saveLast = () => {
    try {
      localStorage.setItem(LAST, JSON.stringify({ x: key?.x, y: key?.y, px: ethPx, rows: rows.filter((r) => r.wedgie && r.info).map((r) => ({ ...r, wallet: false,
        info: { ...r.info, balance: String(r.info!.balance), usdc: r.info!.usdc === null ? null : String(r.info!.usdc) } })) }));
    } catch {}
    dispatchEvent(new Event("wedgie-safes"));
  };
  const loadLast = () => {
    try {
      const l = JSON.parse(localStorage.getItem(LAST) || "null");
      if (!l?.x || !l?.y || !Array.isArray(l.rows)) return;
      signer = E.signerAddress(l.x, l.y); signers = E.signerAddresses(l.x, l.y);
      Object.assign(ethPx, l.px || {});
      rows = l.rows.filter((r: any) => CHAINS[r.chain]).map((r: any) => ({ ...r, info: { ...r.info, balance: BigInt(r.info.balance), usdc: r.info.usdc === null ? null : BigInt(r.info.usdc) } }));
    } catch { rows = []; }
  };
  // which chains a Safe is on, saved: its chain buttons show at once on the next visit (then checked again)
  const SEEN = "wedgie.safe.chains";
  const seenOn = (a: string): Record<number, boolean> => {
    try { const ids: number[] = JSON.parse(localStorage.getItem(SEEN) || "{}")[a.toLowerCase()] || []; return Object.fromEntries(ids.filter((t) => CHAINS[t]).map((t) => [t, true])); } catch { return {}; }
  };
  const saveSeen = (a: string, on: Record<number, boolean | undefined>) => {
    try { const all = JSON.parse(localStorage.getItem(SEEN) || "{}"); all[a.toLowerCase()] = IDS.filter((t) => on[t]); localStorage.setItem(SEEN, JSON.stringify(all)); } catch {}
  };
  // Each Safe as last seen (owners, balances, tokens, its other chains), saved: opening it shows that at once, then
  // the chain's answer replaces it. A button pressed before that reads the chain first (job). Never the queue (always read fresh), never
  // the history (big: a full localStorage would stop every other save on the page). The last 20 Safes.
  const VIEW = "wedgie.safe.view";
  let stale = false;
  const big = (_k: string, v: unknown) => typeof v === "bigint" ? { $n: String(v) } : v;
  const unbig = (_k: string, v: any) => v && typeof v === "object" && "$n" in v ? BigInt(v.$n) : v;
  const saveView = (c: number, a: string) => {
    if (!info || !assets) return;
    try {
      const all = JSON.parse(localStorage.getItem(VIEW) || "{}");
      delete all[`${c}:${a.toLowerCase()}`];      // re-added last: the newest at the end
      all[`${c}:${a.toLowerCase()}`] = JSON.stringify({ info, assets: assets.slice(0, 30), worths, at: Date.now() }, big);
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
      localStorage.setItem(VIEW, JSON.stringify(all));
    } catch {}
  };
  const dropView = (c: number, a: string) => {
    try { const all = JSON.parse(localStorage.getItem(VIEW) || "{}"); delete all[`${c}:${a.toLowerCase()}`]; localStorage.setItem(VIEW, JSON.stringify(all)); } catch {}
  };
  const loadView = (c: number, a: string) => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW) || "{}")[`${c}:${a.toLowerCase()}`];
      if (!v) return false;
      const o = JSON.parse(v, unbig);
      info = o.info; assets = o.assets; Object.assign(worths, o.worths || {}); stale = true; looked = true;
      return true;
    } catch { return false; }
  };
  let lastFind = 0, findAgain = false;      // when the list was last checked: back from a Safe within a minute, no new check
  // a Safe this browser made or opened that the list doesn't have yet
  const unlisted = () => remembered().some((k) => { const [c, x] = k.split(":"); return !rows.some((r) => r.chain === KEYS[c] && eqA(r.addr, x)); });

  /** Put a Safe on the wedgie's own list, so every computer it's plugged into lists it (safe-4+). */
  async function tellWedgie(c: number, a: string) {
    const k = `${c}:${a.toLowerCase()}`;
    if (!wedgie || onWedgie === null || onWedgie.includes(k)) return;
    try {
      const r = await ask(wedgie, (r) => r.request({ type: "safe_note", chainId: c, safe: a }, 5000));
      if (r.type === "ok") onWedgie = [k, ...onWedgie.filter((x) => x !== k)];
    } catch {}
  }

  // ---- the route ----
  function go(path: string) { history.pushState(null, "", path); show(); }
  function show() {
    const m = location.pathname.match(/^\/safe\/(\w+):(0x[0-9a-fA-F]{40})(\/settings)?\/?$/);
    say("");
    closeSheet();
    if (m && KEYS[m[1]]) {
      const same = KEYS[m[1]] === chain && eqA(m[2], safeAddr) && !!info;
      sub = m[3] ? "settings" : "home";
      if (same) { paintAll(); window.scrollTo(0, 0); return; }     // Settings and back: the same Safe, already read
      const was = chain, sameAddr = eqA(m[2], safeAddr);    // another chain of this Safe: keep what's known of the others
      chain = KEYS[m[1]]; safeAddr = E.checksum(m[2]); info = null; queue = []; recipe = null;
      if (sameAddr) copies[was] = true; else { copies = seenOn(m[2]); worths = {}; looked = false; }
      assets = null; assetsErr = false; activity = null; activityErr = ""; addons = null;
      $("s-new").innerHTML = ""; $("s-owner").innerHTML = ""; $("s-wc").innerHTML = "";
      stale = false; loadView(chain, safeAddr);
      paintAll();
      checkDeployed();
      load();                 // not job(): a create that lands here is still a job
      linkIn();
    } else {
      sub = "home";
      if (location.pathname !== "/safe") history.replaceState(null, "", "/safe");
      safeAddr = ""; info = null; stale = false; queue = []; assets = null; activity = null;
      paintAll();
      if (signer && !listing && (Date.now() - lastFind > 60_000 || unlisted())) findSafes();
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener("popstate", show);
  /** A link to a waiting transaction, opened on its Safe's page: into the queue (takeLink). */
  function linkIn() {
    if (!safeAddr || !location.hash.startsWith(TX_LINK)) return;
    const code = location.hash.slice(TX_LINK.length);
    history.replaceState(null, "", location.pathname);
    takeLink(chain, safeAddr, code);
  }
  window.addEventListener("hashchange", linkIn);
  watch(main, readUrl(1));   // ENS names and avatars on every address, from Ethereum
  main.addEventListener("click", (e) => {        // in-page links: no reload, the wedgie stays read
    const a = (e.target as HTMLElement).closest?.("a[data-nav]") as HTMLAnchorElement | null;
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); go(a.getAttribute("href")!);
  });

  // ---- the wedgie ----
  // The spinner, top left: something is still loading (the wedgie, the list, this Safe). Never moves the page.
  // The first time (nothing known yet) it's big, in the middle. waited: a few seconds for a wedgie to show up.
  let wedgieWait = false, waited = false, opening = false, assetsErr = false;
  setTimeout(() => { waited = true; paintWedgie(); paintSpin(); }, 4000);
  function paintSpin() {
    const on = wedgieWait || listing || opening || (!!safeAddr && !!info && !assets && !assetsErr);
    const big = on && !safeAddr && !signer && !rows.length;
    // on the list: after its heading instead
    const inList = document.getElementById("l-spin");
    if (inList) inList.hidden = !on || big || $("s-list").hidden;
    // on a Safe: in its card, where the number lands (s-hspin)
    const inSafe = document.getElementById("s-hspin");
    if (inSafe) inSafe.hidden = !on;
    $("s-spin").hidden = !on || big || !!(inList && !$("s-list").hidden) || !!(inSafe && !$("s-safe").hidden);
    $("s-first").hidden = !big;
  }
  // No wedgie here: the way back to get one (same as /connect without one).
  const HOME = `<a class="btn btn-red" href="/">Back to wedgie.dev</a>`;   // Back = an exit: red
  function paintWedgie() {
    // the wedgie whose key we read was unplugged: read the next one's (another wedgie = another list)
    if (wedgie && wedgie !== DRIVE && !present(wedgie)) { wedgie = null; key = null; }
    const ws = Drive.inApp() ? (driveState === "here" ? [DRIVE] : []) : W.wedgies().filter((w) => w.state === "ready");
    const app = ws.filter((w) => w.running === "safe");
    // Only what needs a hand from you shows here. Connecting, reading the key: just the spinner (paintSpin), and
    // with a saved list nothing at all: the list is already there (Austin, 10-21: no boxes that push the page down).
    const known = !!signer, all = Drive.inApp() ? [] : W.wedgies().filter((w) => w.state !== "gone");
    const bad = all.find((w) => w.state === "error");
    const gone = `<p class="sx-row">${HOME}<a class="btn btn-green" href="/connect">Connect a wedgie</a></p>`;
    let h = "";
    if (Drive.inApp() && !ws.length) h += driveState === "unpicked"
      ? `<p>Plug in your wedgie, then <button class="btn btn-sm btn-green" id="s-drive">Find it</button></p>`
      : driveState === "readonly" ? `<p><button class="btn btn-sm btn-green" id="s-drive">Allow phone txns</button> then press green on your wedgie.</p>`
      : known || !driveState ? "" : `<p>Plug in your wedgie. <button class="btn btn-sm" id="s-drive">Help</button></p>`;
    else if (!Drive.inApp() && !W.supported()) h += `<p>This browser can't talk to a wedgie. Use Chrome, Edge or Brave on a computer.</p>${HOME}`;
    else if (!Drive.inApp() && !W.armed()) h += known || safeAddr ? "" : gone;
    else if (!ws.length) h += bad ? `<p><b>${esc(bad.error || "The wedgie didn't answer.")}</b></p>` : all.length || known || safeAddr || !waited ? "" : gone;
    else if (!app.length) h += `<p>It isn't running Safe Signer. <a class="btn btn-sm btn-green" href="/connect/${esc(ws[0].short)}">Install it</a></p>`;
    else if (!key) h += noKey === "swap" ? `<p><b>This wedgie's chip is locked with a key that isn't Safe Signer's.</b> It never signs with it. Swap the chip.</p>`
      : noKey === "lock" ? `<p><b>Its key is from before keys were locked.</b> On the wedgie: green locks it for good (only if you made it), red makes your own.</p>`
      : noKey ? `<p><b>Press green on the wedgie to make its key.</b></p>` : "";
    else if (safeAddr && info && wedgieOwns() && deployed[chain] === false)
      h += `<p><b>Set up your wedgie on ${esc(CHAINS[chain].name)}</b> before it signs here. <button class="btn btn-sm btn-green" id="s-deploy"${dis()}>Set it up</button></p>
        <p class="fine">Once per chain. Your wallet pays a little gas.</p>`;
    wedgieWait = !h && (Drive.inApp() ? driveState !== "here" && !known : W.armed() && (!ws.length ? !bad && (all.length > 0 || !waited) : !!app.length && !key && !noKey));
    paintSpin();
    $("s-wedgie").innerHTML = h;
    $("s-wedgie").hidden = !h || sub === "settings";
    // up top, under Connected: the wedgie's Safe owner address (what you'd add to another Safe), a tap copies it
    const me = $("s-me");
    me.hidden = !signer;
    me.innerHTML = signer ? `<span class="safe-id-tag">wedgie</span>${address(signer)}` : "";
    $("s-deploy")?.addEventListener("click", () => job(deploy));
    $("s-drive")?.addEventListener("click", () => Drive.panel());
    if (app.length && !key && wedgie !== app[0]) readKey(app[0]);
  }

  /** A newer clear-review round than its app saved: the app checks its signature with the key built into it. */
  async function sendReview(w: W.Wedgie) {
    const l = await fetch("/clear/review/latest.json", { cache: "no-cache" }).then((x) => x.json());
    if (!(l?.round > reviewRound)) return;
    const rd = await fetch(`/clear/review/${l.round}/round.json`).then((x) => x.json());
    const a = await ask(w, (r) => r.request({ type: "safe_review", ...rd }, 30000));
    if (a.type === "safe_review" && typeof a.round === "number") reviewRound = a.round;
  }

  let keyTries = 0;
  async function readKey(w: W.Wedgie) {
    wedgie = w;
    try {
      const h = await ask(w, (r) => r.request({ type: "hello" }, 5000));
      if (!h.safe) {                  // no key yet: the wedgie's own A makes it; look again in a moment
        noKey = h.safe_state === "swap" || h.safe_state === "lock" ? h.safe_state : true; paintWedgie();
        await sleep(3000);
        if (present(w)) { wedgie = null; paintWedgie(); }
        return;
      }
      noKey = false;
      const before = signer;
      key = h.safe; signer = E.signerAddress(key!.x, key!.y); signers = E.signerAddresses(key!.x, key!.y); chunk = +h.safe_chunk || 0;
      clearTag = typeof h.safe_clear === "string" ? h.safe_clear : "";
      simOk = h.safe_sim === "p256";
      reviewRound = typeof h.safe_review === "number" ? h.safe_review : 0;
      if (typeof h.safe_review === "number") await sendReview(w).catch(() => {});   // robot-checked descriptors
      // newer apps work out the address themselves and show it: the two must agree
      if (h.signer && !eqA(h.signer, signer)) { key = null; signer = ""; signers = []; throw new Error(`The wedgie says its address is ${h.signer}, this page works out ${E.signerAddress(h.safe.x, h.safe.y)}. Not using it: tell us.`); }
      const om = oldSaved.match(/^(\w+):(0x[0-9a-fA-F]{40})$/);
      if (om && KEYS[om[1]]) remember(KEYS[om[1]], om[2]);     // checked on chain like every other before it's listed
      try { localStorage.removeItem("wedgie.safe"); } catch {}
      try {
        const l = await ask(w, (r) => r.request({ type: "safe_list" }, 5000));
        onWedgie = l.type === "safe_list" && Array.isArray(l.safes) ? l.safes : null;
      } catch { onWedgie = null; }
      if (!eqA(before, signer)) {      // another wedgie than last time: not its list, nor its open Safe
        rows = []; lastFind = 0;
        if (safeAddr && !wedgieOwns()) go("/safe");
        else if (listing) findAgain = true;
      }
      paintAll();
      const news = (onWedgie || []).some((k) => !rows.some((r) => `${r.chain}:${r.addr.toLowerCase()}` === k.toLowerCase()));
      if (safeAddr) { checkDeployed(); if (info && wedgieOwns()) remember(chain, safeAddr); }
      else if (!listing && (news || Date.now() - lastFind > 60_000)) findSafes();
      keyTries = 0;
    } catch (e) {
      // Right after a reload the port is often still held by the page that just closed, or the wedgie is busy:
      // the first asks fail. Try again on our own instead of waiting for the wedgie to change (Austin: the list
      // came up empty after a reload until he went to /connect and back).
      if (!key && ++keyTries <= 6 && present(w)) { await sleep(800 * keyTries); wedgie = null; paintWedgie(); return; }
      fail(e); wedgie = null;
    }
  }

  async function checkDeployed() {
    if (!signer || !safeAddr) return;
    const c = chain, a = ownedBy()[0] || signer;
    // "no code" is read twice, a few seconds apart: just after Make it, the node can be a block behind and say no.
    // That showed "Set up your wedgie" for one already set up; its button then found it there and did nothing (Austin, 10-22)
    try { deployed[c] = await hasCode(c, a) || (await sleep(4000), await hasCode(c, a)); } catch { deployed[c] = undefined; }
    paintWedgie();
  }

  /** createSigner for each of the wedgie's addresses in `owners` (one, or Instant Wallet's two). */
  const signerCalls = (owners: string[]) => owners.map((o) => signers.findIndex((s) => eqA(s, o))).filter((k) => k >= 0)
    .map((k) => ({ to: E.FACTORY, allowFailure: true, data: E.createSignerData(key!.x, key!.y, [E.VERIFIERS, ...E.IW_VERIFIERS][k]) }));

  async function deploy() {
    const need: string[] = [];
    for (const a of ownedBy().length ? ownedBy() : [signer]) if (!(await hasCode(chain, a))) need.push(a);
    if (!need.length) { deployed[chain] = true; return; }
    const calls = signerCalls(need);
    await send(chain, calls.length > 1 ? E.MULTICALL3 : E.FACTORY, calls.length > 1 ? E.aggregate3(calls) : calls[0].data, say);
    deployed[chain] = true;
    say(`Your wedgie is set up on ${CHAINS[chain].name}.`);
  }

  // ---- the wallet ----
  function paintWallet() {
    // up top, under the wedgie: the browser wallet (pays gas, can sign as an owner too)
    const box = $("s-wallet");
    box.hidden = false;
    box.innerHTML = !account ? `<button class="btn btn-sm btn-grey btn-wallet" id="w-go"${dis()}>Connect wallet</button>`
      : `<span class="safe-id-tag">wallet</span>${address(account)}${isOwner(account) ? `<span class="good">owner</span>` : ""}
      <button class="btn btn-sm btn-red" id="w-off">Disconnect</button>`;
    $("w-go")?.addEventListener("click", () => job(async () => {
      account = await wallet(safeAddr ? chain : newChain);
      (await rainbow()).watch(onWallet); hear(wcp);
      try { localStorage.removeItem(OFF); } catch {}
      if (!safeAddr) findSafes();
      else if (stale) load(true);      // the chain couldn't be read (/api/rpc down): the wallet's RPC can now
    }, false));
    $("w-off")?.addEventListener("click", async () => {
      account = ""; showWallet = false;
      try { localStorage.setItem(OFF, "1"); localStorage.removeItem(WCP); } catch {}
      rows = rows.filter((r) => r.wedgie).map((r) => ({ ...r, wallet: false }));
      // the page lets go at once; the wallet hears it after. A WalletConnect wallet may never answer the revoke:
      // awaiting it left Disconnect doing nothing (Austin, 10-21)
      const p = wcp; wcp = null;
      paintAll();
      p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
      rainbow().then((r) => r.disconnect()).catch(() => {});
    });
  }
  // the wallet's side: an account switch shows here, and ending it there (WalletConnect: Disconnect on the phone)
  // ends it here, whichever way it connected (Austin, 10-21: it stayed connected on the site)
  const listened = new WeakSet<object>();
  const hear = (p: any) => {
    if (!p || listened.has(p)) return;
    listened.add(p);
    p.on?.("accountsChanged", onAccounts);
    p.on?.("disconnect", () => { if (wcp === p) onWallet(null); });
  };
  const onWallet = async (p: any | null) => {
    if (!p) { if (wcp) { wcp = null; try { localStorage.removeItem(WCP); } catch {} } return onAccounts([]); }
    wcp = p; hear(p);
    onAccounts(await p.request({ method: "eth_accounts" }));
    if (linkWait && linkWait.c === chain && eqA(linkWait.a, safeAddr)) { const w = linkWait; linkWait = null; takeLink(w.c, w.a, w.code); }
  };
  const onAccounts = (a: string[]) => {
    if (localStorage.getItem(OFF)) return;
    account = a[0] ? E.checksum(a[0]) : "";
    if (!account) { showWallet = false; rows = rows.filter((r) => r.wedgie).map((r) => ({ ...r, wallet: false })); }
    paintAll(); if (!safeAddr && account) findSafes();
  };

  // ---- /safe: every Safe the wedgie (and the wallet) owns, on every chain ----
  // Each address's Safes per chain, as Safe's service said, kept a day: the list opens without asking it 14 chains ×
  // each address again (its free plan is 50K reads a month: /api/safe). Refresh asks again.
  const OWNED = "wedgie.safe.owned", DAY = 86_400_000;
  const owned = (): Record<string, { at: number; safes: string[] }> => { try { return JSON.parse(localStorage.getItem(OWNED) || "{}"); } catch { return {}; } };
  async function findSafes(fresh = false) {
    if (!signer && !account) return;
    if (listing) { findAgain = true; return; }    // a wallet or wedgie arrived mid-check: once more after
    listing = true; listPct = 8; lastFind = Date.now(); paintList();
    const me = signer;
    // the bar: asking Safe's API on every chain is the first 70%, reading each Safe from its chain the rest
    let asked = 0, read = 0, nAsk = IDS.length * (signers.length + (account ? 1 : 0)), nRead = 0;
    const tick = () => {
      listPct = Math.max(8, nRead ? 70 + 30 * read / nRead : 70 * asked / nAsk);
      const f = document.getElementById("l-fill"); if (f) f.style.width = `${listPct}%`;
    };
    const found = new Map<string, Row>();
    const add = (c: number, a: string, who: "wedgie" | "wallet") => {
      const k = `${c}:${a.toLowerCase()}`, r = found.get(k) || { chain: c, addr: E.checksum(a), wedgie: false, wallet: false };
      r[who] = true; found.set(k, r);
    };
    // Safe's API, asked for six chains at once, sometimes says 429 or fails: try again before giving up on a chain
    const of = async (c: number, a: string) => {
      const k = `${c}:${a.toLowerCase()}`, had = owned()[k];
      if (!fresh && had && Date.now() - had.at < DAY) return had.safes;
      for (let i = 0; ; i++) {
        try {
          const safes = (await get(`${api(c)}/owners/${E.checksum(a)}/safes/${fresh ? "?fresh" : ""}`)).safes as string[];
          try { const all = owned(); all[k] = { at: Date.now(), safes }; localStorage.setItem(OWNED, JSON.stringify(all)); } catch {}
          return safes;
        } catch (e: any) {
          if (e.status === 404 || e.status === 400) return [];
          if (e.status === 429 || i >= 3) return had?.safes || [];     // 429: our daily share of Safe's service is used
          await sleep(700 * 2 ** i);
        }
      }
    };
    const ours = ourSafes([...signers, ...(account ? [account] : [])]);
    await Promise.all(IDS.map(async (c) => {
      await Promise.all(signers.map(async (a) => { for (const s of await of(c, a)) add(c, s, "wedgie"); asked++; tick(); }));
      if (account) { for (const s of await of(c, account)) add(c, s, "wallet"); asked++; tick(); }
    }));
    for (const o of await ours) if (CHAINS[o.chain] && E.isAddress(o.safe)) add(o.chain, o.safe, signers.some((a) => eqA(a, o.owner)) ? "wedgie" : "wallet");
    for (const k of signer ? remembered() : []) { const [ck, a] = k.split(":"); if (KEYS[ck]) add(KEYS[ck], a, "wedgie"); }
    for (const k of onWedgie || []) { const [c, a] = k.split(":"); if (CHAINS[+c] && E.isAddress(a)) add(+c, a, "wedgie"); }
    if (me !== signer) { listing = false; findAgain = false; return findSafes(); }   // another wedgie mid-check
    const list = [...found.values()];
    nRead = list.length;
    for (let i = 0; i < list.length; i += 4)      // a few at a time: a burst gets rate-limited
      await Promise.all(list.slice(i, i + 4).map(async (r) => { try { r.info = await readSafe(r.chain, r.addr); } catch (e: any) { r.info = null; r.err = msgOf(e); r.gone = !!e?.gone; } read++; tick(); }));
    for (const r of list) {          // the chain is the truth: who really is an owner now
      if (!r.info) continue;
      r.wedgie = r.info.owners.some(mine);
      if (r.wedgie) remember(r.chain, r.addr);   // seen once, listed in this browser even when Safe's API isn't answering
      r.wallet = !!account && r.info.owners.some((o) => eqA(o, account));
      if (r.wedgie || r.wallet) tellOurs(r.chain, r.addr);
    }
    if (me !== signer) { listing = false; findAgain = false; return findSafes(); }
    // a Safe the chain couldn't be read for stays listed (as its sources said): never hidden by a busy RPC.
    // No Safe there at all (an address on the wedgie's own list that isn't one): never listed
    rows = list.filter((r) => !r.gone && (!r.info || r.wedgie || r.wallet))
      .sort((a, b) => +b.wedgie - +a.wedgie || +!!CHAINS[a.chain].test - +!!CHAINS[b.chain].test || a.chain - b.chain);
    listing = false;
    paintList();
    // each chain's coin price, for the cards' dollar totals (USDC counts as a dollar)
    await Promise.all([...new Set(rows.map((r) => r.chain))].map(async (c) => {
      try { ethPx[c] = (await rpc(c, "wedgie_prices", []))?.eth ?? null; } catch { ethPx[c] = null; }
    }));
    paintList();
    if (key) saveLast();
    if (fresh) priced.clear();
    await priceRows();
    if (findAgain) { findAgain = false; findSafes(); }
  }

  /** A Safe's dollars on one chain (native coin + USDC), null with no price yet; a test chain's coins: none. */
  const worthUsd = (c: number, i: Info, a: string) => {
    if (CHAINS[c].test) return 0;
    const f = fullUsd[fk(c, a)];
    if (f && f.b === String(i.balance) && f.u === String(i.usdc)) return f.usd;
    return ethPx[c] ? Number(i.balance) / 1e18 * ethPx[c]! + Number(i.usdc || 0n) / 1e6 : null;
  };
  /** Every token on each card, a few Safes at a time (wallet Safes only once shown), then repaint. */
  async function priceRows() {
    const todo = rows.filter((r) => r.info && !CHAINS[r.chain].test && (r.wedgie || showWallet) && !priced.has(fk(r.chain, r.addr)));
    todo.forEach((r) => priced.add(fk(r.chain, r.addr)));
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (r) => {
        try { const n = await worthOn(r.chain, r.addr, r.info!); if (n !== null) setFull(r.chain, r.addr, r.info!, n); } catch { priced.delete(fk(r.chain, r.addr)); }
      }));
      if (!safeAddr) paintList();
    }
  }
  /** A Safe's worth for its card: dollars when the coin's price is known, else its coin and USDC. */
  const worth = (c: number, i: Info) => {
    const p = ethPx[c];
    if (p) return usd(Number(i.balance) / 1e18 * p + Number(i.usdc || 0n) / 1e6);
    return `${E.fmt(i.balance, 18, 4)} ${nat(c)}${i.usdc ? ` · ${E.fmt(i.usdc, 6, 2)} USDC` : ""}`;
  };

  function paintList() {
    const box = $("s-list");
    box.hidden = !!safeAddr || !signer;
    if (box.hidden) { paintSpin(); return; }
    // one card per address: the same Safe on several chains is one Safe, its worth all of them together
    const groups = (list: Row[]) => {
      const by = new Map<string, Row[]>();
      for (const r of list) by.set(r.addr.toLowerCase(), [...(by.get(r.addr.toLowerCase()) || []), r]);
      return [...by.values()];
    };
    const card = (g: Row[]) => {
      const read = g.filter((r) => r.info), $s = read.map((r) => worthUsd(r.chain, r.info!, r.addr));
      const n = $s.every((x) => x !== null) ? $s.reduce((a, x) => a! + x!, 0)! : null;
      // opens on the chain with the most in it
      const top = read.slice().sort((x, y) => (worthUsd(y.chain, y.info!, y.addr) ?? 0) - (worthUsd(x.chain, x.info!, x.addr) ?? 0))[0] || g[0], i = top.info;
      const chains = IDS.filter((t) => g.some((r) => r.chain === t));
      return `<li><a class="safe-row sx-safe${g.some((r) => r.wedgie) ? " sx-mine" : ""}" data-nav href="${route(top.chain, top.addr)}">
        <span class="sx-safe-top">${i && isIW(i.owners) ? iwMark : ""}${address(top.addr, { chain: top.chain })}</span>
        ${read.length ? `<span class="sx-safe-worth">${esc(n !== null ? usd(n) : read.map((r) => worth(r.chain, r.info!)).join(" · "))}</span>` : ""}
        ${i ? `<span class="fine">${i.threshold} of ${plural(i.owners.length, "owner")}${g.some((r) => r.wedgie) ? "" : " · add your wedgie"}</span>`
          : `<span class="fine">Couldn't read it just now. Open it, or Refresh.</span>`}
        <span class="sx-chains sx-chains-sm">${chains.map((t) => `<span class="sx-pill${CHAINS[t].test ? " sx-test" : ""}" title="${esc(CHAINS[t].name)}">${chainLogo(t)}</span>`).join("")}</span></a></li>`;
    };
    // most money first (a Safe that couldn't be priced yet: after the ones that could)
    const sum = (g: Row[]) => g.reduce((n, r) => n + (r.info ? worthUsd(r.chain, r.info, r.addr) ?? 0 : 0), 0);
    const all = groups(rows).sort((x, y) => sum(y) - sum(x)), mine = all.filter((g) => g.some((r) => r.wedgie)), theirs = all.filter((g) => !g.some((r) => r.wedgie));
    let h = `<div class="sx-head"><h1>Your wedgie's Safes<span class="sx-spin sx-spin-h" id="l-spin" hidden></span></h1><button class="btn btn-green" id="l-new"${dis()}>＋ New Safe</button></div>`;
    h += mine.length ? `<ul class="sx-safes">${mine.map(card).join("")}</ul>`
      : listing ? ``
      : `<div class="sx-card sx-empty"><p><b>No Safes yet.</b></p><p class="fine">Make one, or add your wedgie to a Safe you have.</p></div>`;
    if (theirs.length) h += `<p class="sx-fold"><button class="btn btn-sm" id="l-wallet">${showWallet ? "Hide your wallet's Safes" : `Your wallet's Safes (${theirs.length})`}</button></p>`
      + (showWallet ? `<ul class="sx-safes">${theirs.map(card).join("")}</ul>` : "");
    const typed = (document.getElementById("l-addr") as HTMLInputElement | null)?.value || "", open = !!document.querySelector("#l-more[open]");
    h += `<details class="sx-more" id="l-more"${open ? " open" : ""}><summary>Open another Safe</summary>
      <p class="sx-row">${addressInput("l-addr", "0x… or ENS name of a Safe")} <select id="l-chain">${chainOpts(newChain)}</select> <button class="btn btn-sm" id="l-open">Open</button></p></details>
      <p class="sx-foot"><button class="btn btn-sm" id="l-refresh"${dis(listing)}>Refresh</button></p>`;
    box.innerHTML = h;
    paintSpin();
    if (typed) { const el = $("l-addr") as HTMLInputElement; el.value = typed; el.dispatchEvent(new Event("input")); }
    $("l-new").onclick = () => openSheet("create");
    $("l-refresh").onclick = () => findSafes(true);
    $("l-wallet")?.addEventListener("click", () => { showWallet = !showWallet; paintList(); if (showWallet) priceRows(); });
    $("l-open").onclick = () => {
      const el = $("l-addr") as HTMLInputElement;
      el.value = el.value.trim().replace(/^\w+:/, "");    // a pasted "base:0x…"
      const a = addressOf(el);
      if (!a) { say("That isn't an address.", true); return; }
      go(route(+($("l-chain") as HTMLSelectElement).value, a));
    };
  }

  // ---- /safe: a new Safe with the wedgie as an owner; a browser wallet pays the gas ----
  function paintCreate() {
    const box = $("s-create");
    box.hidden = sheet !== "create" || !key;
    if (box.hidden) return;
    if (document.getElementById("c-go")) { ($("c-go") as HTMLButtonElement).disabled = busy; return; }   // keep what's typed
    box.innerHTML = `<h2>New Safe</h2>
      <p class="sx-label">Owners</p>
      <div class="safe-owners" id="c-owners"><div class="safe-owner">${address(signer)} <span class="sx-pill">this wedgie</span></div></div>
      <p class="sx-row"><button class="btn btn-sm" id="c-add" aria-label="Add an owner">＋ Owner</button> <button class="btn btn-sm" id="c-me">Add my wallet</button></p>
      <p class="sx-row"><select id="c-th"></select> <span id="c-of"></span> must sign</p>
      <p class="sx-row">On <select id="c-chain">${chainOpts(newChain)}</select></p>
      <p><button class="btn btn-green sx-wide" id="c-go">Make it</button></p>
      <p class="fine">Your wallet sends one transaction and pays the gas.</p>`;
    const list = $("c-owners"), th = $("c-th") as HTMLSelectElement;
    let rowN = 0;
    const addRow = (v = "") => {                  // one input per owner; × takes it off
      const d = document.createElement("div");
      d.className = "safe-owner";
      d.innerHTML = `${addressInput("c-o" + ++rowN, "0x… or ENS name")} <button class="btn btn-sm btn-red" type="button" aria-label="Take this owner off">×</button>`;
      list.append(d);
      const inp = d.querySelector("input")!;
      if (v) { inp.value = v; inp.dispatchEvent(new Event("input")); }
      d.querySelector("button")!.onclick = () => { d.remove(); count(); };
      return inp;
    };
    const count = () => {                         // only the count: never rebuild the box under someone typing
      const n = 1 + new Set(owners().map((a) => a.toLowerCase()).filter((a) => a !== signer.toLowerCase())).size;
      th.innerHTML = threshOpts(n, Math.min(n, Math.max(+th.value || 2, 1)));
      const of = document.getElementById("c-of");   // an ENS name can resolve after the box is gone
      if (of) of.textContent = `of ${plural(n, "owner")}`;
    };
    list.addEventListener("address", count);
    $("c-add").onclick = () => addRow().focus();
    addRow();
    count();
    $("c-chain").onchange = () => { newChain = +($("c-chain") as HTMLSelectElement).value; };
    $("c-me").onclick = () => job(async () => {
      const me = account = await wallet(newChain);
      if (!owners().some((a) => eqA(a, me))) {
        const empty = [...list.querySelectorAll<HTMLInputElement>("input")].find((i) => !i.value.trim());
        if (empty) { empty.value = me; empty.dispatchEvent(new Event("input")); } else addRow(me);
      }
      count();
    });
    $("c-go").onclick = () => job(createSafe);
  }

  const ownerInputs = () => [...document.querySelectorAll<HTMLInputElement>("#c-owners input")].map(addressOf).filter(Boolean);
  const owners = ownerInputs;

  async function createSafe() {
    const c = newChain;
    const bad = [...$("c-owners").querySelectorAll<HTMLInputElement>("input")].find((i) => i.value.trim() && !addressOf(i));
    if (bad) throw new Error(`${bad.value.trim()} isn't an address (or an ENS name that has one).`);
    const owners = [signer];
    for (const a of ownerInputs()) if (!owners.some((o) => eqA(o, a))) owners.push(a);
    const th = +($("c-th") as HTMLSelectElement).value;
    account = await wallet(c);
    const data = E.newSafeData(key!.x, key!.y, owners, th, BigInt(Date.now()));
    const r = await send(c, E.MULTICALL3, data, say);
    const log = (r.logs || []).find((l: any) => eqA(l.address, E.SAFE_FACTORY) && l.topics[0] === E.PROXY_CREATION);
    if (!log) throw new Error("It ran, but no new Safe showed up in it: " + r.transactionHash);
    deployed[c] = true;
    const a = E.checksum("0x" + log.topics[1].slice(26));
    try { saveRecipe(a, await recipeIn(c, E.SAFE_FACTORY, data, a)); } catch {}   // to copy it to other chains at once
    remember(c, a);
    await tellWedgie(c, a);
    $("s-create").innerHTML = "";
    rows = [];
    go(route(c, a));
    say(`Made your Safe on ${CHAINS[c].name}. Receive puts money in it.`);
  }

  // ---- /safe/<chain>:<address>: one Safe. The top: its name, its worth, three buttons ----
  function paintSafe() {
    const box = $("s-safe"), iw = $("s-iw");
    box.hidden = !safeAddr;
    // an Instant Wallet Safe: say so on top, and send them there (it has no link to one Safe: its passkey opens it)
    iw.hidden = !(safeAddr && info && isIW(info.owners));
    // with its recovery and daily limit under it (repainted only when they change: the button stays put under a tap)
    const iwh = iw.hidden ? "" : `<div class="sx-iw-top"><img src="/img/instantwallet.png" alt=""><b>Instant Wallet</b>
      <a class="btn btn-sm sx-end" href="https://instantwallet.io" target="_blank" rel="noopener">Open ↗</a></div>`
      + (addons ? `<ul class="sx-rows">${addonRows(addons.mods.filter((m) => m.kind === "recovery" || m.kind === "limit"), false)}</ul>` : "");
    if (iw.dataset.h !== iwh) { iw.dataset.h = iwh; iw.innerHTML = iwh; }
    if (box.hidden) { paintSpin(); return; }
    const c = CHAINS[chain], i = info, home = route(chain, safeAddr), $t = total(), g = grand();
    const on = IDS.filter((t) => t === chain || copies[t]);   // fixed order: a tap only recolors
    // no number till the dollars are known (a coin amount first, then dollars, is a jump); no price at all: the coin
    const worthOf = !i || (!assets && !assetsErr) ? "" : $t !== null ? usd($t) : `${E.fmt(i.balance, 18, 4)} ${nat(chain)}`;
    const who = !i ? "" : `${i.threshold} of ${plural(i.owners.length, "owner")}`
      + (signer ? wedgieOwns() ? " · your wedgie is one" : " · your wedgie isn't one" : "");
    let h = `<div class="sx-hero-top">${sub === "settings" ? `<a class="sx-back" data-nav href="${home}">← Back</a>` : `<a class="sx-back" data-nav href="/safe">← Safes</a>`}
      ${sub === "home" ? `<a class="sx-gear" id="a-settings" data-nav href="${home}/settings">${i ? `<span class="sx-faces">${i.owners.map((o) => face(o, chain)).join("")}</span>` : ""}Settings</a>` : ""}</div>
      <div class="sx-hero-id">${address(safeAddr, { size: "lg", long: true, chain })}${g !== null ? `<span class="sx-grand"><b>${esc(usd(g))}</b> on all chains</span>` : ""}</div>
      <div class="sx-chains">${on.map((t) => t === chain ? `<span class="sx-pill sx-on">${chainLogo(t)}${esc(c.name)}</span>`
        : `<a class="sx-pill" data-nav href="${route(t, safeAddr)}${sub === "settings" ? "/settings" : ""}">${chainLogo(t)}${esc(CHAINS[t].name)}</a>`).join("")}</div>`;
    const spin = `<span class="sx-spin sx-spin-h sx-spin-dark" id="s-hspin" hidden aria-label="Loading"></span>`;
    if (sub === "settings") h += `<div class="sx-total sx-total-sm">Settings${spin}</div><div class="sx-sub">${esc(who)}</div>`;
    else {
      h += `<div class="sx-total">${worthOf ? esc(worthOf) + spin : spin.replace("sx-spin-dark", "sx-spin-dark sx-spin-solo")}&#8203;</div><div class="sx-sub">${i ? esc(who) : "Opening the Safe"}</div>`;
      if (i) h += `<div class="sx-actions">
        ${can() ? `<button class="sx-act" id="a-send"${dis()}><span>↑</span>Send</button>` : ""}
        <button class="sx-act" id="a-receive"><span>↓</span>Receive</button>
        ${can() ? `<button class="sx-act" id="a-connect"${dis()}><span>⇄</span>Connect app</button>` : ""}</div>`;
    }
    box.innerHTML = h;
    box.classList.toggle("sx-hero-set", sub === "settings");   // Settings: a lighter gray, so it reads as a level down
    paintSpin();
    $("a-send")?.addEventListener("click", () => openSheet("send"));
    $("a-receive")?.addEventListener("click", () => openSheet("receive"));
    $("a-connect")?.addEventListener("click", () => openSheet("connect"));
  }

  // ---- add-ons (readAddons): a line each, in Instant Wallet's card and in Settings ----
  const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const every = (d: number) => d === 1 ? "a day" : d === 7 ? "a week" : d ? `every ${+d.toFixed(1)} days` : "in all";
  const amt = (n: bigint, l: Limit) => `${E.fmt(n, l.dec, l.dec > 6 ? 4 : 2)} ${esc(l.sym)}`;
  const limits = (ls: Limit[]) => ls.length ? `<b>${ls.map((l) => amt(l.max, l)).join(" + ")} ${every(ls[0].days)}</b> <span class="fine">${ls.map((l) => amt(l.left, l)).join(" + ")} left</span>` : "nothing set";
  const waits = (s: number) => s >= 86400 ? plural(Math.round(s / 86400), "day") : s >= 3600 ? plural(Math.round(s / 3600), "hour") : plural(Math.round(s / 60), "minute");
  /** One add-on: its name (and in Settings the module's address), then what it does. */
  const addonRow = (k: string, body: string, m: string, full: boolean) => `<li class="sx-addon"><div class="sx-addon-k"><b>${k}</b>${full && m
    ? `<span class="sx-end">${address(m, { link: CHAINS[chain].scan, chain })}</span>` : ""}</div>${body ? `<div class="sx-addon-v">${body}</div>` : ""}</li>`;
  function addonRows(list: Addon[], full: boolean) {
    const who = (as: string[]) => as.map((g) => `<div>${address(g, { chain })}</div>`).join("");
    return list.map((m) => {
      if (m.kind === "recovery") return addonRow(`Recovery${m.days ? ` · ${m.days} days` : ""}`, (m.guardians!.length ? who(m.guardians!) : "No one yet")
        + (m.need! > 1 ? `<div class="fine">${m.need} of ${m.guardians!.length} must agree</div>` : ""), m.addr, full)
        + (m.running ? `<li class="sx-warn">Recovery running: new owners ${Date.now() < m.running.at ? `on ${when(m.running.at)}` : "any time now"} (${m.running.approvals} of ${m.need} agreed)</li>` : "");
      if (m.kind === "limit") return addonRow("Spending limit", limits(m.limits!) + (full && m.members!.length ? `<div class="fine">for</div>${who(m.members!)}` : ""), m.addr, full);
      if (m.kind === "allowance") return addonRow("Spending limit", m.who?.length ? m.who.map((w) => `${who([w.addr])}<div>${limits(w.limits)}</div>`).join("") : "No one yet", m.addr, full);
      if (m.kind === "roles") return addonRow("Zodiac Roles", `${plural(m.members!.length, "key")} can act within set rules`, m.addr, full);
      if (m.kind === "delay") return addonRow("Delay", `A module's transaction waits ${waits(m.wait!)}`, m.addr, full);
      if (m.kind === "4337") return addonRow("4337", "Owners sign, any bundler sends", m.addr, full);
      return addonRow(esc(m.name) || "Unknown module", `<span class="sx-warn">Can move money without the owners</span>`, m.addr, full);
    }).join("");
  }
  function paintAddons() {
    const box = $("s-addons");
    box.hidden = !(safeAddr && info && sub === "settings");
    if (box.hidden) return;
    const a = addons, rows = a ? addonRows(a.mods, true) + a.guards.map((g) => addonRow("Guard", "Checks every transaction", g, true)).join("") : "";
    box.innerHTML = `<h3>Add-ons</h3>${!a ? `<p class="fine">Checking.</p>` : rows ? `<ul class="sx-rows">${rows}</ul>` : `<p class="fine">None: a plain Safe.</p>`}`;
  }

  // ---- Settings: owners and threshold ----
  function paintOwners() {
    const box = $("s-owners");
    box.hidden = !(safeAddr && info && sub === "settings");
    if (box.hidden) return;
    const i = info!, c = CHAINS[chain], change = can() && i.owners.length > 1;
    box.innerHTML = `<h3>Owners</h3>
      <ul class="sx-rows">${i.owners.map((o) => `<li>${address(o, { link: c.scan, chain })}${label(o)}${change ? `<button class="btn btn-sm btn-red sx-end" data-rm="${esc(o)}"${dis()}>Remove</button>` : ""}</li>`).join("")}</ul>
      <p class="sx-row"><b>${i.threshold} of ${i.owners.length}</b>&nbsp;must sign${change ? `<span class="sx-end"><select id="o-th"${dis()}>${threshOpts(i.owners.length, i.threshold)}</select> <button class="btn btn-sm" id="o-th-go"${dis()}>Change</button></span>` : ""}</p>`;
    box.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) => b.onclick = () => removeOwner(b.dataset.rm!));
    $("o-th-go")?.addEventListener("click", () => changeThreshold(+($("o-th") as HTMLSelectElement).value));
  }

  // ---- Settings: the same Safe on other chains, and the ways out (Safe{Wallet}, the explorer) ----
  function paintChains() {
    const box = $("s-chains");
    box.hidden = !(safeAddr && info && sub === "settings");
    if (box.hidden) return;
    const i = info!, c = CHAINS[chain];
    const others = IDS.filter((t) => t !== chain);
    const differs = recipe && recipe.owners.length && (recipe.threshold !== i.threshold || recipe.owners.length !== i.owners.length || recipe.owners.some((o) => !i.owners.some((x) => eqA(x, o))));
    box.innerHTML = `<h3>Other chains</h3><p class="fine">Same address on every chain.</p>
      <ul class="sx-rows">${others.map((t) => `<li><span>${chainLogo(t)}${esc(CHAINS[t].name)}${CHAINS[t].test ? ` <span class="fine">test</span>` : ""}</span>${copies[t]
        ? `<a class="btn btn-sm sx-end" data-nav href="${route(t, safeAddr)}">Open</a>`
        : copies[t] === false ? `<button class="btn btn-sm sx-end" data-copy="${t}"${dis()}>Deploy</button>` : checked ? `<button class="btn btn-sm sx-end" disabled title="This chain didn't answer">Can't check</button>`
          : `<span class="btn btn-sm sx-end sx-btn-wait" aria-label="Checking"><span class="sx-spin sx-spin-in"></span></span>`}</li>`).join("")}</ul>
      ${differs ? `<p class="fine">A new copy starts with this Safe's first owners (${recipe!.threshold} of ${recipe!.owners.length}), not today's.</p>` : ""}
      <h3>More</h3>
      <p class="sx-row"><a class="btn btn-sm" href="${appLink(chain, safeAddr)}" target="_blank" rel="noopener">Open in Safe{Wallet} ↗</a>
        <a class="btn btn-sm" href="${c.scan}/address/${safeAddr}" target="_blank" rel="noopener">Explorer ↗</a></p>
      <p class="fine">Execute here: Safe{Wallet} can't run a transaction a wedgie signed yet (GS021, <a href="https://github.com/safe-global/safe-wallet-monorepo/issues/8808" target="_blank" rel="noopener">their bug</a>).</p>`;
    box.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => b.onclick = () => job(() => copyTo(+b.dataset.copy!)));
  }

  /** The Safe from the chain (the truth), its queue from Safe's API. */
  async function load(quiet = false, bg = false, refresh = false) {   // bg: the background check (recheck); svcGet
    const fresh = refresh || (quiet && !bg);    // Refresh, or a quiet load just after a sign: Safe's newest
    if (!quiet) say("Opening the Safe.");
    const c = chain, a = safeAddr;
    opening = true; paintSpin();
    try {
      let i: Info;
      for (let t = 0; ; t++) {       // just made: an RPC can lag a few seconds behind, so watch before saying it isn't there
        try { i = await readSafe(c, a); break; } catch (e: any) {
          if (!e?.gone || t >= 8 || c !== chain || a !== safeAddr) throw e;
          if (!quiet) say(`Watching for the Safe on ${CHAINS[c].name}.`, 10 + 10 * t);
          await sleep(2000);
        }
      }
      opening = false;
      if (c !== chain || a !== safeAddr) return;
      info = i; stale = false;
      tellOurs(c, a);
      if (signer) { if (wedgieOwns()) { remember(c, a); tellWedgie(c, a); } else forget(c, a); }
      if (!quiet) say("");
      paintAll();             // the Safe from the chain now; its queue, tokens and history as the sources answer
      if (!quiet) checkCopies(c, a);
      loadAssets(c, a, i).catch(() => { if (c === chain && a === safeAddr) { assetsErr = true; paintSpin(); } });
      loadActivity(c, a, { bg, fresh });
      readAddons(c, a).then((x) => { if (c === chain && a === safeAddr) { addons = x; paintSafe(); paintAddons(); } }, () => {});
      const q = await readQueue(c, a, i.nonce, { bg, fresh });
      if (c !== chain || a !== safeAddr) return;
      queue = q; queueOf = `${c}:${a}`;
      takeAsks();
    } catch (e: any) {
      opening = false; paintSpin();
      if (e?.gone) dropView(c, a);       // not there (any more): no saved copy of it
      // couldn't read it just now (busy): the saved copy stays up, buttons off, till Refresh works
      if (c === chain && a === safeAddr) { if (!stale || e?.gone) { info = null; stale = false; } queue = []; if (!quiet) fail(e); paintAll(); }
    }
    paintAll();
  }

  // Money that comes in shows without a reload: every 8 s (tab in view) one cheap read (the same Multicall3 as
  // load); anything changed, or a minute gone, or the tab back in view: a quiet load (tokens, queue, history).
  let ticks = 0;
  async function recheck(full = false) {
    if (!safeAddr || !info || opening || busy || asking || document.hidden) return;
    const c = chain, a = safeAddr, was = info;
    if (!full && !stale && ++ticks % 8) {      // the saved copy: a full load, only that clears it
      const i = await readSafe(c, a).catch(() => null);
      if (!i || c !== chain || a !== safeAddr || info !== was) return;
      if (i.balance === was.balance && i.usdc === was.usdc && i.nonce === was.nonce && i.threshold === was.threshold && i.owners.join() === was.owners.join()) return;
    }
    ticks = 0;
    load(true, true);
  }
  setInterval(() => recheck(), 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recheck(true); });

  /** Every token it holds, with dollars (src/safe/assets.ts). */
  async function loadAssets(c: number, a: string, i: Info) {
    const got = await readAssets(c, a, CHAINS[c].native, i.balance, CHAINS[c].usdc ? { address: CHAINS[c].usdc!, balance: i.usdc } : null, (m, p) => rpc(c, m, p));
    if (got[0].price !== null && !CHAINS[c].test) setFull(c, a, i, got.reduce((n, x) => n + (x.usd || 0), 0));
    if (c === chain && a === safeAddr) { assets = got; paintSafe(); paintAssets(); paintNew(); saveView(c, a); }
  }


  // Safe's service, light (the site has 1,500 calls a day, /api/safe): the background check (each minute, the tab back
  // in view) asks again only when the Safe changed on chain (its number, its coins) or keepMs passed. The history goes
  // with that version (v), so /api/safe keeps it for everyone till it changes; the queue, 2 min (a proposal in
  // Safe{Wallet} changes nothing on chain). fresh: Refresh, or just after a sign: past every keep.
  const svcKept = new Map<string, { at: number; j: any }>();
  const version = () => info ? `${info.nonce}.${info.balance}.${info.usdc}` : "";
  async function svcGet(url: string, o: { bg: boolean; fresh: boolean; keepMs: number; v?: boolean }) {
    const k = `${url}|${version()}`, hit = svcKept.get(k);
    if (o.bg && !o.fresh && hit && Date.now() - hit.at < o.keepMs) return hit.j;
    const j = await within(get(o.fresh ? url + "?fresh" : url, o.v && version() ? `&v=${version()}` : ""));
    if (svcKept.size > 50) svcKept.clear();
    svcKept.set(k, { at: Date.now(), j });
    return j;
  }

  /** What happened: Safe's API (its executed transactions, and money that came in). */
  async function loadActivity(c: number, a: string, o = { bg: false, fresh: false }) {
    try {
      const list = await either("history", c, a,
        () => svcGet(`${api(c)}/safes/${a}/all-transactions/?executed=true&queued=false&limit=25`, { ...o, keepMs: 30 * 60_000, v: true }).then((j) => (j.results || []) as any[]),
        () => Hist.chainHistory(rpcOf(c), c, a, CHAINS[c].usdc), (sv, h) => Hist.diffHistory(c, sv, h, a, CHAINS[c].usdc));
      if (c === chain && a === safeAddr) { activity = list; activityErr = ""; }
    } catch (e: any) {
      if (c === chain && a === safeAddr) { activity = activity || []; activityErr = e.status === 404 ? "" : e.status === 429 ? REST : "Couldn't load it just now."; }
    }
    if (c === chain && a === safeAddr) paintActivity();
  }

  // ---- the same Safe on another chain: its creation call again, so the same address ----
  /** Dollars this Safe holds on chain t (a test chain's coins: none), or null with no price. */
  async function worthOn(t: number, a: string, i: Info) {
    if (CHAINS[t].test) return 0;
    const got = await readAssets(t, a, CHAINS[t].native, i.balance, CHAINS[t].usdc ? { address: CHAINS[t].usdc!, balance: i.usdc } : null, (m, p) => rpc(t, m, p));
    return got[0].price === null ? null : got.reduce((n, x) => n + (x.usd || 0), 0);
  }
  /** All chains together, once every one was looked at; null till then (or with no price somewhere). */
  const grand = () => {
    const $t = total(), others = IDS.filter((t) => t !== chain && copies[t]);
    if ($t === null || !others.length || !looked) return null;     // a chain that couldn't be read: left out
    let n = $t;
    for (const t of others) { const w = worths[t]; if (w === undefined || w === null) return null; n += w; }
    return n;
  };
  async function checkCopies(c: number, a: string) {
    checked = false;
    await Promise.all(IDS.filter((t) => t !== c).map(async (t) => {
      try {
        // one read says if it's there and what it holds (readSafe), not a getCode and then that
        const i = await readSafe(t, a).catch((e) => { if (e?.gone) return null; throw e; });
        if (c !== chain || a !== safeAddr) return;
        copies[t] = !!i;
        if (i) { worths[t] = await worthOn(t, a, i); if (worths[t] !== null) setFull(t, a, i, worths[t]!); paintSafe(); }
      } catch {}
    }));
    if (c === chain && a === safeAddr) { looked = true; checked = true; copies[c] = true; saveSeen(a, copies); saveView(c, a); paintSafe(); paintChains(); }
    try { const r = await recipeOf(c, a); if (c === chain && a === safeAddr) { recipe = r; paintChains(); } } catch {}
  }

  // How each Safe was made, saved in this browser (the same on every chain): one made or read here copies at once,
  // without waiting for Safe's API to index it.
  const RECIPES = "wedgie.safe.recipe";
  const savedRecipe = (a: string): E.Recipe | null => {
    try { const r = JSON.parse(localStorage.getItem(RECIPES) || "{}")[a.toLowerCase()]; return r ? { ...r, salt: BigInt(r.salt) } : null; } catch { return null; }
  };
  const saveRecipe = (a: string, r: E.Recipe) => {
    try { const all = JSON.parse(localStorage.getItem(RECIPES) || "{}"); all[a.toLowerCase()] = { ...r, salt: String(r.salt) }; localStorage.setItem(RECIPES, JSON.stringify(all)); } catch {}
  };
  /** The factory call that made `a`, found in a transaction's input and checked against the address. */
  async function recipeIn(c: number, factory: string, input: string, a: string) {
    const ret = E.bytes(await view(c, factory, E.selector("proxyCreationCode()")));
    const at = Number(BigInt(E.hex(ret.slice(0, 32)))), n = Number(BigInt(E.hex(ret.slice(at, at + 32))));
    const r = input && E.findRecipe(input, a, factory, E.hex(ret.slice(at + 32, at + 32 + n)));
    if (!r) throw new Error("Couldn't find how this Safe was made, so it can't be copied to another chain.");
    return r;
  }
  /** How the Safe was made: saved here, else its creation transaction from Safe's API (this chain, then any other it's on). */
  async function recipeOf(c: number, a: string): Promise<E.Recipe> {
    const kept = savedRecipe(a);
    if (kept) return kept;
    let err: any = null;
    for (const t of [c, ...IDS.filter((t) => t !== c && copies[t])]) {
      try {
        const cr = await either("creation", t, a, () => get(`${api(t)}/safes/${a}/creation/`) as Promise<{ transactionHash: string; factoryAddress: string }>,
          () => Hist.chainCreation(rpcOf(t), a), (sv, h) => ["transactionHash", "factoryAddress"].filter((f) => String((sv as any)[f]).toLowerCase() !== String((h as any)[f]).toLowerCase())
            .map((f) => `${f}: safe ${(sv as any)[f]} chain ${(h as any)[f]}`));
        const tx = await rpc(t, "eth_getTransactionByHash", [cr.transactionHash]) as any;
        const r = await recipeIn(t, cr.factoryAddress, tx?.input, a);
        saveRecipe(a, r);
        return r;
      } catch (e: any) { err ||= e; }
    }
    throw new Error(err?.status === 404 ? "Safe's API hasn't seen this Safe yet. Try again in a minute." : msgOf(err));
  }

  async function copyTo(t: number) {
    const r = recipe || (recipe = await recipeOf(chain, safeAddr));
    if (!(await hasCode(t, r.factory)) || !(await hasCode(t, r.singleton))) throw new Error(`Safe's contracts aren't on ${CHAINS[t].name}.`);
    const calls = [...(key ? signerCalls(r.owners) : []), { to: r.factory, allowFailure: false, data: r.data }];
    await send(t, calls.length > 1 ? E.MULTICALL3 : r.factory, calls.length > 1 ? E.aggregate3(calls) : r.data, say);
    const a = safeAddr;
    if (r.owners.some(mine)) remember(t, a);
    go(route(t, a));
    say(`Your Safe is on ${CHAINS[t].name} now, same address.`);
  }

  // ---- the queue: Safe's API + Instant Wallet's queue + this browser, merged by safeTxHash ----
  let queueOf = "";                     // whose queue is in `queue` (chain:safe), once read
  const hKey = (c: number, a: string) => `wedgie.safe.hidden.${c}:${a.toLowerCase()}`;   // removed here: safeTxHash → nonce
  const hiddenQ = (c: number, a: string): Record<string, number> => { try { return JSON.parse(localStorage.getItem(hKey(c, a)) || "{}"); } catch { return {}; } };
  const qKey = (c: number, a: string) => `wedgie.safe.q.${c}:${a.toLowerCase()}`;
  const localQ = (c: number, a: string): Record<string, any> => { try { return JSON.parse(localStorage.getItem(qKey(c, a)) || "{}"); } catch { return {}; } };
  const useIW = (c: number) => !CHAINS[c].test;
  const TX_FIELDS = ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"] as const;
  const txOf = (t: any): E.SafeTx => Object.fromEntries(TX_FIELDS.map((k) => [k, k === "data" ? t.data || "0x" : t[k]])) as any;

  async function readQueue(c: number, a: string, nonce: number, o = { bg: false, fresh: false }): Promise<any[]> {
    const all = new Map<string, any>(), dropped = new Set<string>();
    const add = (t: any, sigs: { owner: string; signature: string | null }[], fromSafe = false) => {
      if (+t.nonce < nonce) return;
      const h = String(t.safeTxHash || t.hash).toLowerCase();
      const m = all.get(h) || { ...txOf(t), safeTxHash: t.safeTxHash || t.hash, confirmations: [], confirmationsRequired: t.confirmationsRequired, dataDecoded: t.dataDecoded };
      m.inSafe ||= fromSafe;
      if (fromSafe && t.proposer) m.proposer = t.proposer;
      if (t.dataDecoded) m.dataDecoded = t.dataDecoded;
      for (const s of sigs) if (!m.confirmations.some((x: any) => eqA(x.owner, s.owner))) m.confirmations.push(s);
      all.set(h, m);
    };
    const missed: string[] = [];
    let rest = false;
    await Promise.all([
      svcGet(`${api(c)}/safes/${a}/multisig-transactions/?executed=false&nonce__gte=${nonce}&ordering=nonce&limit=20`, { ...o, keepMs: 2 * 60_000 })
        .then((j) => (j.results || []).forEach((t: any) => add(t, t.confirmations || [], true)))
        .catch((e: any) => { if (e.status === 429) rest = true; else if (e.status !== 404) missed.push("Safe's service"); }),   // 404: a Safe made seconds ago
      useIW(c) ? within(fetch(`${IWQ}?chainId=${c}&safe=${a}`).then((r) => r.json()))
        .then((j) => { if (j.error) throw new Error(j.error); (j.txs || []).forEach((t: any) => add({ ...t.tx, hash: t.hash }, t.sigs)); (j.dropped || []).forEach((h: string) => dropped.add(h.toLowerCase())); })
        .catch(() => missed.push("Instant Wallet")) : null,
    ]);
    const mine = localQ(c, a);
    for (const [h, t] of Object.entries(mine))
      if (+t.nonce >= nonce) { add(t, t.confirmations); if (t.wc) all.get(h)!.wc = t.wc; }
      else if (t.wc) tellApp(c, a, h, t.wc);      // its number is used: the app hears how, then it goes
      else delete mine[h];
    // removed: by an owner's signed delete (Instant Wallet's list, for every page) or in this browser. Safe's service
    // can still have it (it deletes only for the wallet that proposed it): hidden here all the same
    const hid = hiddenQ(c, a);
    for (const [h, n] of Object.entries(hid)) if (+n < nonce) delete hid[h]; else dropped.add(h);
    try { localStorage.setItem(hKey(c, a), JSON.stringify(hid)); } catch {}
    for (const h of dropped) all.delete(h);
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); } catch {}
    queueNote = [rest ? REST : "", missed.length ? `${missed.join(" and ")} didn't answer just now.` : ""].filter(Boolean).join(" ");
    return [...all.values()].sort((x, y) => +x.nonce - +y.nonce);
  }

  /** An app's request whose number the Safe has passed: it ran (the app gets its tx hash) or something else took it. */
  const telling = new Set<string>();
  async function tellApp(c: number, a: string, h: string, wc: any, ran?: string) {
    if (telling.has(h)) return;
    telling.add(h);
    try { await tellOnce(c, a, h, wc, ran); } catch {} finally { telling.delete(h); }
  }
  async function tellOnce(c: number, a: string, h: string, wc: any, ran?: string) {
    // the chain is trusted only when it has the run (its logs can trail a block); "it didn't run" needs Safe's API
    const [sv, onChain] = ran ? [null, null] : await Promise.all([get(`${api(c)}/multisig-transactions/${h}/`).catch((e: any) => e.status === 404 ? {} : null),
      within(Hist.ranOnChain(rpcOf(c), c, a, h, true), 20_000).catch(() => null)]);
    if (sv?.isExecuted && onChain) report("ran", c, a, String(sv.transactionHash).toLowerCase() === onChain.transactionHash.toLowerCase() ? [] : [`safe ${sv.transactionHash} chain ${onChain.transactionHash}`]);
    const j = ran ? { isExecuted: true, transactionHash: ran } : sv?.isExecuted ? sv : onChain ? { isExecuted: true, transactionHash: onChain.transactionHash } : sv;
    if (!j) return;           // neither answered: next time
    const m = await wcStart();
    await (j.isExecuted && j.transactionHash ? m.answerDone(wc, j.transactionHash) : m.answerError(wc.topic, wc.id, "It didn't run: another transaction took its number."));
    const mine = localQ(c, a);
    delete mine[h];
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); } catch {}
  }

  /** A transaction and its signatures, everywhere the queue lives. Fine as long as one place took it. */
  async function share(t: E.SafeTx, sigs: { owner: string; signature: string }[], known?: any) {
    const c = chain, a = safeAddr, h = E.safeTxHash(c, a, t);
    // the signatures already known (from either place) go along, so each place ends up with all of them
    const all = [...(known?.confirmations || []).filter((x: any) => x.signature), ...sigs]
      .filter((s, k, l) => l.findIndex((x) => eqA(x.owner, s.owner)) === k);
    const mine = localQ(c, a), m = mine[h.toLowerCase()] || { ...txOf(t), safeTxHash: h, confirmations: [] };
    for (const s of sigs) if (!m.confirmations.some((x: any) => eqA(x.owner, s.owner))) m.confirmations.push(s);
    mine[h.toLowerCase()] = m;
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); } catch {}
    const toSafe = async () => {
      const had = (known?.inSafe ? known.confirmations : []).map((x: any) => x.owner);
      let rest = all.filter((s) => !had.some((o: string) => eqA(o, s.owner)));
      if (!known?.inSafe && rest.length) {
        const [first, ...more] = rest;
        await post(`${api(c)}/safes/${a}/multisig-transactions/`, { ...t, contractTransactionHash: h, sender: first.owner, signature: first.signature, origin: "wedgie.dev/safe" });
        rest = more;
      }
      for (const s of rest) await post(`${api(c)}/multisig-transactions/${h}/confirmations/`, { signature: s.signature });
    };
    const toIW = async () => {
      const r = await fetch(IWQ, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: c, safe: a, tx: t, sigs: all, origin: "wedgie.dev/safe" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Instant Wallet: ${r.status}`);
    };
    const got = await Promise.allSettled([within(toSafe()), useIW(c) ? within(toIW()) : Promise.reject(new Error("off"))]);
    if (got.every((g) => g.status === "rejected"))
      say("Saved in this browser only: Safe's service and Instant Wallet didn't take it. Other owners won't see it yet.", true);
  }

  // ---- add the wedgie as an owner, from a browser wallet that already is one ----
  function paintAdd() {
    const box = $("s-add");
    box.hidden = !(safeAddr && info && signer && !wedgieOwns());
    if (box.hidden) return;
    const i = info!, n = i.owners.length;
    box.innerHTML = `<p><b>Add your wedgie as an owner</b></p>
      <p class="sx-row">Then <select id="a-th"${dis()}>${threshOpts(n + 1, i.threshold)}</select> of ${n + 1} must sign.
        <button class="btn btn-green" id="a-go"${dis()}>Add it with my wallet</button></p>
      <p class="fine">${i.threshold > 1 ? `${i.threshold} owners must sign this before it runs.` : "Your wallet must be an owner."}</p>`;
    $("a-go").onclick = () => job(addSigner);
  }

  async function addSigner() {
    const from = account = await wallet(chain);
    if (!isOwner(from)) throw new Error(`This wallet (${short(from)}) isn't an owner of this Safe. Switch to one that is.`);
    if (!(await hasCode(chain, signer))) {
      say("First your wallet sets up your wedgie on this chain (once per chain).");
      await send(chain, E.FACTORY, E.createSignerData(key!.x, key!.y), say);
      deployed[chain] = true;
    }
    const th = +($("a-th") as HTMLSelectElement).value;
    await propose(safeTx(safeAddr, "0", E.addOwnerData(signer, th)), "wallet", `add owner ${short(signer)} (this wedgie)`);
  }

  // ---- owners and threshold: proposed by the wedgie if it's an owner, else the wallet ----
  const by = (): "wedgie" | "wallet" => (wedgieOwns() ? "wedgie" : "wallet");
  function removeOwner(o: string) {
    const i = info!, at = i.owners.findIndex((x) => eqA(x, o));
    const th = Math.min(i.threshold, i.owners.length - 1);
    if (mine(o)) { askYes("Remove this wedgie as an owner? It won't be able to sign for this Safe.", "Remove owner").then((y) => y && go()); return; }
    go();
    function go() { job(() => propose(safeTx(safeAddr, "0", E.removeOwnerData(at ? i.owners[at - 1] : E.SENTINEL, o, th)), by(), `remove owner ${short(o)}, then ${th} must sign`)); }
  }
  // ---- add any owner (a wallet, another wedgie): its own box, built once per Safe so typing survives repaints ----
  function paintOwner() {
    const box = $("s-owner");
    box.hidden = !(safeAddr && info && can() && sub === "settings");
    if (box.hidden) return;
    const i = info!;
    if (!document.getElementById("ow-addr")) {
      box.innerHTML = `<h3>Add an owner</h3>
        <p>${addressInput("ow-addr", "0x… or ENS name")}</p>
        <p class="fine">A wallet, or another wedgie (its screen shows its address).</p>
        <p class="sx-row">Then <select id="ow-th"></select> <span id="ow-of"></span> must sign.</p>
        <p class="sx-row" id="ow-btns"></p>`;
    }
    const th = $("ow-th") as HTMLSelectElement, keep = +th.value || i.threshold;
    th.innerHTML = threshOpts(i.owners.length + 1, Math.min(keep, i.owners.length + 1));
    $("ow-of").textContent = `of ${i.owners.length + 1} owners`;
    $("ow-btns").innerHTML = `${isOwner(account) ? `<button class="btn${wedgieOwns() ? "" : " btn-green sx-end"}" id="ow-wallet"${dis()}>Sign with wallet</button>` : ""}${wedgieOwns() ? `<button class="btn btn-green sx-end" id="ow-wedgie"${dis()}>Sign with wedgie</button>` : ""}`;   // primary on the right
    $("ow-wedgie")?.addEventListener("click", () => job(() => addOwner("wedgie")));
    $("ow-wallet")?.addEventListener("click", () => job(() => addOwner("wallet")));
  }
  async function addOwner(who: "wedgie" | "wallet") {
    const a = addressOf($("ow-addr") as HTMLInputElement), th = +($("ow-th") as HTMLSelectElement).value;
    if (!a) throw new Error("That isn't an address (or an ENS name that has one).");
    if (isOwner(a)) throw new Error("That's already an owner.");
    await propose(safeTx(safeAddr, "0", E.addOwnerData(E.checksum(a), th)), who, `add owner ${short(a)}, then ${th} of ${info!.owners.length + 1} must sign`);
    ($("ow-addr") as HTMLInputElement).value = "";
    $("ow-addr").dispatchEvent(new Event("input"));
  }

  function changeThreshold(th: number) {
    if (th === info!.threshold) { say(`It's already ${th}.`); return; }
    job(() => propose(safeTx(safeAddr, "0", E.changeThresholdData(th)), by(), `${th} of ${info!.owners.length} must sign`));
  }

  // ---- the queue: each one in words, who signed, and its one next step ----
  // ---- a link to a waiting transaction: it and its signatures ride in the link, after the # (no server sees it).
  // Opened by another owner, it lands in their queue here, with no server needed at all. Each signature counts only
  // once the Safe itself says it's an owner's (checkNSignatures, one at a time, eth_call).
  const txLink = (t: any) => location.origin + route(chain, safeAddr) + TX_LINK + btoa(JSON.stringify({ t: txOf(t),
    s: (t.confirmations || []).filter((x: any) => x.signature).map((x: any) => [x.owner, x.signature]) })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let linkWait: { c: number; a: string; code: string } | null = null;
  async function takeLink(c: number, a: string, code: string) {
    let t: E.SafeTx, sigs: { owner: string; signature: string }[];
    try {
      const j = JSON.parse(atob(code.replace(/-/g, "+").replace(/_/g, "/")));
      t = txOf(j.t);
      sigs = (j.s || []).filter((x: any) => Array.isArray(x) && E.isAddress(x[0]) && /^0x[0-9a-fA-F]+$/.test(x[1])).map((x: any) => ({ owner: E.checksum(x[0]), signature: x[1] }));
      if (!E.isAddress(t.to)) throw 0;
    } catch { return say("That link is broken: ask for it again.", true); }
    const h = E.safeTxHash(c, a, t), data = E.safeTxData(c, a, t);
    say("Checking the link's signatures.");
    // true: the Safe took it; false: it reverted (not an owner's); null: no answer (the chain can't be read now)
    const ok = await Promise.all(sigs.map((s) => within(view(c, a, E.call("checkNSignatures(bytes32,bytes,bytes,uint256)",
      [E.bytes(h), E.dynBytes(data), E.dynBytes(E.packSignatures([s])), E.word(1)])), 15_000).then(() => true, (e: any) => /revert|GS0\d\d/i.test(msgOf(e)) ? false : null)));
    if (c !== chain || a !== safeAddr) return;
    if (ok.includes(null)) {     // checked again once a wallet connects (its RPC reads the chain)
      linkWait = { c, a, code };
      return say(wcp ? "Can't read the chain to check the link right now. Try it again in a minute." : "Can't read the chain to check the link right now. Connect your wallet: it checks through that.", true);
    }
    const good = sigs.filter((_, k) => ok[k]);
    const mine = localQ(c, a), m = mine[h.toLowerCase()] || { ...t, safeTxHash: h, confirmations: [] };
    for (const s of good) if (!m.confirmations.some((x: any) => eqA(x.owner, s.owner))) m.confirmations.push(s);
    mine[h.toLowerCase()] = m;
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); } catch {}
    const hid = hiddenQ(c, a);
    if (hid[h.toLowerCase()]) { delete hid[h.toLowerCase()]; try { localStorage.setItem(hKey(c, a), JSON.stringify(hid)); } catch {} }
    say(good.length < sigs.length ? `Added to Waiting. ${sigs.length - good.length} of its signatures didn't check out, so they don't count.` : "Added to Waiting.", good.length < sigs.length);
    await load(true);
  }

  function paintQueue() {
    const box = $("s-queue");
    box.hidden = !(safeAddr && info && sub === "home" && (queue.length || queueNote));
    if (box.hidden) return paintDock();       // an empty queue still takes the bottom bar away
    const i = info!;
    const signed = (t: any, a: string) => !!a && (t.confirmations || []).some((c: any) => eqA(c.owner, a));
    const cancelled = (n: number) => queue.some((x) => +x.nonce === n && said(x).kind === "cancel");
    // one green action on the page (Austin): the bottom bar's (Execute, or Execute all), and any button here that does
    // the same thing; with nothing ready, the first sign button
    let green = !readyNext();
    const run = readyRun();
    const items = queue.map((t, k) => {
      const n = (t.confirmations || []).length, need = t.confirmationsRequired ?? i.threshold, first = +t.nonce === i.nonce, s = said(t);
      const btns: string[] = [], marks: string[] = [];
      if (wedgieOwns()) {
        if (ownedBy().every((o) => signed(t, o))) marks.push("wedgie ✓");
        else { btns.push(`<button class="btn btn-sm${green ? " btn-green" : ""}" data-sign="${k}"${dis()}>Sign with wedgie</button>`); green = false; }
      }
      if (account && isOwner(account)) signed(t, account) ? marks.push("wallet ✓")
        : n < need && (btns.push(`<button class="btn btn-sm${green ? " btn-green" : ""}" data-wsign="${k}"${dis()}>Sign with wallet</button>`), green = false);
      // Execute's green is the bottom bar's (one green on the page): here it's white
      if (n >= need) btns.push(first ? `<button class="btn btn-sm" data-exec="${k}"${dis()}>Execute</button>` : `<span class="fine">runs after #${i.nonce}</span>`);
      const rej = t.wc && !n ? `<button class="btn btn-sm" data-wcno="${k}"${dis()}>Reject</button>`      // only here: nothing to cancel
        // a red ✕ (Remove) far left, then a white Reject (Austin, as in Instant Wallet). Any owner here can remove
        : (can() ? `<button class="btn btn-sm btn-red sx-x" data-remove="${k}" title="Remove" aria-label="Remove"${dis()}>✕</button> ` : "")
        + (can() && s.kind !== "cancel" && !cancelled(+t.nonce) ? `<button class="btn btn-sm" data-reject="${k}"${dis()}>Reject</button>` : "");
      const app = t.inSafe ? appLink(chain, safeAddr, "transactions/tx") + `&id=multisig_${safeAddr}_${t.safeTxHash}` : "";
      const dots = Array.from({ length: need }, (_, d) => `<i class="${d < n ? "on" : ""}"></i>`).join("");
      return `<li class="sx-tx sx-k-${s.kind}">
        <div class="sx-tx-head"><span class="sx-ic">${ICON[s.kind]}</span><span class="sx-tx-what">${s.title}</span><span class="sx-tx-n">#${esc(t.nonce)}</span>${app ? `<a class="pill sx-pill" href="${esc(app)}" target="_blank" rel="noopener" title="Open in Safe{Wallet}">Safe ↗</a>` : ""}<button class="btn btn-grey sx-copy" data-link="${k}" title="Copy a link to it" aria-label="Copy a link to it">${COPY_ICON}</button></div>
        ${t.wc ? `<p class="fine">From ${esc(t.wc.dapp.name)}: it gets the result when this runs.</p>` : ""}${subsOf(s)}${s.more || ""}${s.kind === "danger" ? `<p class="sx-warn">This can change how the Safe works. Only sign if you know why.</p>` : ""}
        <div class="sx-tx-sigs"><span class="sx-dots">${dots}</span>${n} of ${need} signed${marks.length ? ` · ${marks.join(" · ")}` : ""}</div>
        ${btns.length || rej ? `<div class="sx-row">${rej}<span class="sx-row sx-end">${btns.map((b) => [+/btn-green/.test(b) * 10 + (/data-wsign/.test(b) ? 0 : /data-sign/.test(b) ? 1 : 2), b] as const)
          .sort((x, y) => x[0] - y[0]).map((x) => x[1]).join(" ")}</span></div>` : ""}
        <details class="sx-more"><summary>Details</summary><dl class="sx-dl">
          <dt>To</dt><dd>${address(t.to, { link: CHAINS[chain].scan, size: "sm", chain })}</dd>
          ${BigInt(t.value || 0) ? `<dt>${nat(chain)}</dt><dd>${esc(E.fmt(BigInt(t.value), 18))}${priceOf(null) !== null ? ` <span class="fine">(${esc(usd(Number(BigInt(t.value)) / 1e18 * priceOf(null)!))})</span>` : ""}</dd>` : ""}
          ${t.data && t.data !== "0x" ? `<dt>Data</dt><dd><code>${esc(t.data.length > 202 ? t.data.slice(0, 202) + `… (${(t.data.length - 2) / 2} bytes)` : t.data)}</code></dd>` : ""}
          ${+t.operation === 1 ? `<dt>Kind</dt><dd>delegate call</dd>` : ""}
          <dt>Hash</dt><dd><code>${esc(String(t.safeTxHash).slice(0, 10))}…${esc(String(t.safeTxHash).slice(-8))}</code></dd></dl></details></li>`;
    }).join("");
    const ready = /data-exec/.test(items);
    box.innerHTML = `<h3 class="sx-row">${ready ? "Ready: press Execute" : "Waiting"}${queue.length ? ` <span class="sx-count">${queue.length}</span>` : ""}${run.length > 1 ? `<button class="btn btn-sm sx-end" id="s-execall"${dis()}>Execute all ${run.length}</button>` : ""}</h3>
      ${items ? `<ul class="sx-txs">${items}</ul>` : `<p class="fine">Nothing waiting.</p>`}
      ${queueNote ? `<p class="fine">${esc(queueNote)}</p>` : ""}
      <p class="sx-foot"><button class="btn btn-sm" id="s-refresh"${dis()}>Refresh</button></p>`;
    $("s-refresh").onclick = () => job(() => load(false, false, true));
    document.getElementById("s-execall")?.addEventListener("click", () => job(async () => {
      running = run[0]; runningAll = run; paintDock();
      try { await executeAll(run); } finally { running = null; runningAll = []; }
    }));
    box.querySelectorAll<HTMLButtonElement>("[data-sign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.sign!], "wedgie")));
    box.querySelectorAll<HTMLButtonElement>("[data-wsign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.wsign!], "wallet")));
    box.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach((b) => b.onclick = () => job(async () => { running = queue[+b.dataset.exec!]; paintDock(); try { await execute(running); } finally { running = null; } }));
    box.querySelectorAll<HTMLButtonElement>("[data-reject]").forEach((b) => b.onclick = () => {
      const t = queue[+b.dataset.reject!];
      // a Safe can't delete a queued one: an empty one at the same nonce runs instead, and the first can never run
      job(() => propose(safeTx(safeAddr, "0", "0x", +t.nonce), by(), `cancel #${t.nonce}`));
    });
    box.querySelectorAll<HTMLButtonElement>("[data-wcno]").forEach((b) => b.onclick = () => job(async () => {
      const t = queue[+b.dataset.wcno!];
      await dropAsk(t, "Rejected on wedgie.dev");
      say(`Rejected. ${t.wc.dapp.name} was told no.`);
    }));
    box.querySelectorAll<HTMLButtonElement>("[data-link]").forEach((b) => b.onclick = () =>
      navigator.clipboard.writeText(txLink(queue[+b.dataset.link!])).then(() => say("Link copied. Share it with the other signers."),
        () => say("Couldn't copy the link.", true)));
    box.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.onclick = () => job(() => removeQueued(queue[+b.dataset.remove!])));
    paintDock();
  }

  /**
   * Off the list with no transaction on chain: the next one takes its nonce. One signature (a message, no gas: Safe's
   * own DeleteRequest), by a wallet owner or the wedgie (safe_remove, a press on it). Safe's service deletes it only
   * for the wallet that proposed it; Instant Wallet's queue takes any owner's and lists it as dropped, so every
   * wedgie.dev page hides it. Its signatures still exist: it can run till another tx takes its number.
   */
  async function removeQueued(t: any) {
    const c = chain, a = safeAddr, h = String(t.safeTxHash).toLowerCase(), n = +t.nonce;
    const real = !t.inSafe || (!!account && isOwner(account) && !!t.proposer && eqA(t.proposer, account));   // gone from Safe's service too
    if (!real && !await askYes(`Remove #${n}? It's hidden on wedgie.dev, but Safe{Wallet} still shows it, and it can still run until another transaction takes #${n}. Only Reject stops it for sure.`, "Remove"))
      return;
    if (real && (t.confirmations || []).length >= (t.confirmationsRequired ?? info!.threshold)
      && !await askYes(`#${n} is fully signed. Anyone with its signatures can still run it until another transaction takes #${n}. Only Reject stops it for sure.`, "Remove anyway"))
      return;
    const useWallet = !!account && isOwner(account) && (real || !wedgieOwns());
    let signature: string;
    if (useWallet) {
      const from = account = await wallet(chain);
      say("Sign the remove in your wallet. It's a message, not a transaction: no gas.");
      signature = E.ecdsa(await eth().request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(E.deleteTypedData(c, a, h))] }));
    } else signature = await wedgieRemove(t);
    const kept: string[] = [];
    const toSafe = async () => {
      if (!t.inSafe || !useWallet || !real) return;
      const r = await safeFetch(`${SAFE}${CHAINS[c].key}/api/v2/multisig-transactions/${h}/`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ safeTxHash: h, signature }) });
      if (!r.ok && r.status !== 404) kept.push(`Safe's service said no: ${r.status} ${(await r.text()).slice(0, 200)}`);
    };
    const toIW = async () => {
      if (!useIW(c)) return;
      const r = await fetch(IWQ, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: c, safe: a, hash: h, nonce: String(n), signature }) });
      if (!r.ok) kept.push(`Instant Wallet said no: ${(await r.json().catch(() => ({}))).error || r.status}`);
    };
    await Promise.all([within(toSafe()).catch(() => kept.push("Safe's service didn't answer.")), within(toIW()).catch(() => kept.push("Instant Wallet didn't answer."))]);
    const mine = localQ(c, a), hid = hiddenQ(c, a);
    delete mine[h];
    hid[h] = n;                       // hidden in this browser either way
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); localStorage.setItem(hKey(c, a), JSON.stringify(hid)); } catch {}
    if (t.wc) await wcStart().then((m) => m.answerError(t.wc.topic, t.wc.id, "Removed on wedgie.dev")).catch(() => {});
    await load(true);
    say(kept.length ? `Removed here, but ${kept.join(" ")} Other pages may still show it.` : `Removed #${n}. Your next transaction takes #${n}.`, !!kept.length);
  }
  /** The wedgie signs Safe's DeleteRequest for t (safe-23+): it works out the hash, shows "Remove #n?", waits for A. */
  async function wedgieRemove(t: any) {
    if (!wedgie || !key) throw new Error(noWedgie());
    const slots = ownedBy();
    if (!slots.length) throw new Error("Your wedgie isn't an owner of this Safe.");
    const totp = Math.floor(Date.now() / 3600_000);
    const tx = { chainId: chain, safe: safeAddr, to: t.to, value: String(t.value), dataHash: E.hex(E.keccak256(E.bytes(t.data || "0x"))), operation: +t.operation,
      safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice), gasToken: t.gasToken || Z,
      refundReceiver: t.refundReceiver || Z, nonce: +t.nonce };
    asking = true; paintAll();
    say(`Look at the wedgie: it asks to remove #${t.nonce}. Press the green button (red says no).`);
    try {
      const g = await ask(wedgie, (r) => r.request({ type: "safe_remove", tx, totp }, 200000));
      if (g.type === "refused") throw new Error("The wedgie said no.");
      if (g.type !== "safe_sig") throw new Error(/unknown|safe_remove/i.test(String(g.error || "")) || !g.type
        ? "Your wedgie's Safe Signer is too old to remove: update it (its page, Software)." : g.error || "The wedgie didn't sign.");
      if (String(g.safeTxHash).toLowerCase() !== String(t.safeTxHash).toLowerCase()) throw new Error("The wedgie signed for a different transaction: not sent.");
      return E.safeSignature(slots[0], g as E.WedgieSig);
    } finally { asking = false; }
  }
  /** Stuck to the bottom of the screen while a transaction is ready to run (Austin): its Execute, then its progress. */
  let running: any = null;
  let runningAll: any[] = [];
  const readyNext = () => { const i = info; return i ? queue.find((t) => +t.nonce === i.nonce && (t.confirmations || []).length >= (t.confirmationsRequired ?? i.threshold)) : undefined; };
  function paintDock() {
    const t = running || readyNext() || null;
    const all = running ? runningAll : t && info ? readyRun() : [];
    const dock = $("s-dock");
    dock.hidden = !(safeAddr && t && sub === "home");
    document.body.classList.toggle("has-dock", !dock.hidden);
    document.body.classList.toggle("dock-running", !dock.hidden && !!running);   // the dock shows the progress: no second bar
    document.body.classList.toggle("in-app", Drive.inApp());
    if (dock.hidden) return;
    $("s-dock-tx").innerHTML = all.length > 1
      ? `<span class="safe-dock-what"><b>#${esc(all[0].nonce)}–#${esc(all.at(-1).nonce)}</b> ${all.length} transactions, in one go</span>
        ${running ? "" : `<button class="btn btn-green" id="s-dock-all"${dis()}>Execute all ${all.length}</button>`}`
      : `<span class="safe-dock-what"><b>#${esc(t.nonce)}</b> ${said(t).title}</span>
        ${running ? "" : `<button class="btn btn-green" id="s-dock-go"${dis()}>Execute</button>`}`;
    $("s-dock-msg").hidden = !running;
    $("s-dock-go")?.addEventListener("click", () => job(async () => { running = t; paintDock(); try { await execute(t); } finally { running = null; } }));
    $("s-dock-all")?.addEventListener("click", () => job(async () => {
      running = all[0]; runningAll = all; paintDock();
      try { await executeAll(all); } finally { running = null; runningAll = []; }
    }));
  }

  // ---- Assets: every token, biggest first; ones with no price folded away ----
  function paintAssets() {
    paintSpin();
    const box = $("s-assets");
    // zero, or priced under a penny (dust, often fake tokens sent to it), isn't shown, as in Instant Wallet; nothing left = no card
    const list = (assets || (info ? [{ token: null, ...CHAINS[chain].native, decimals: 18, balance: info.balance, usd: null, price: null } as Asset] : []))
      .filter((a) => a.balance > 0n && !(a.usd !== null && a.usd < 0.01));
    box.hidden = !(safeAddr && info && sub === "home" && (assets || assetsErr) && list.length);
    if (box.hidden) return;
    const row = (a: Asset) => `<li><button class="sx-asset" type="button" data-tok="${a.token || ""}"${can() ? "" : " disabled"}>${assetInner(a)}</button></li>`;
    const priced = list.filter((a) => a.token === null || a.price !== null), other = list.filter((a) => a.token !== null && a.price === null);
    const open = !!document.querySelector("#s-other[open]");
    box.innerHTML = `<h3>Assets</h3><ul class="sx-assets">${priced.map(row).join("")}</ul>
      ${other.length ? `<details class="sx-more" id="s-other"${open ? " open" : ""}><summary>Other tokens (${other.length})</summary>
        <p class="fine">No price. Tokens nobody asked for land here: don't trust their names.</p><ul class="sx-assets">${other.map(row).join("")}</ul></details>` : ""}`;
    box.querySelectorAll<HTMLButtonElement>("[data-tok]").forEach((b) => b.onclick = () => { sendToken = b.dataset.tok || null; openSheet("send"); });
  }

  // ---- Activity: what ran, and money that came in ----
  function paintActivity() {
    const box = $("s-activity");
    box.hidden = !(safeAddr && info && sub === "home");
    if (box.hidden) return;
    const scan = CHAINS[chain].scan, rows: string[] = [];
    for (const t of activity || []) {
      if (rows.length >= 15) break;
      const when = t.executionDate ? ago(t.executionDate) : "";
      const link = t.transactionHash || t.txHash ? `${scan}/tx/${t.transactionHash || t.txHash}` : "";
      if (t.txType === "MULTISIG_TRANSACTION") {
        const s = describe(t, { ...ctx(), past: true }, t.dataDecoded?.method), failed = t.isSuccessful === false;
        rows.push(`<li><span class="sx-ic">${ICON[s.kind]}</span><span class="sx-act-what"><b>${s.title}</b><span class="fine">#${esc(t.nonce)} · ${esc(when)}${failed ? ` · <span class="bad">failed</span>` : ""}</span></span>${link ? `<a class="sx-end fine" href="${link}" target="_blank" rel="noopener">↗</a>` : ""}</li>`);
        continue;
      }
      // in: the coin, or a token Safe's API trusts (a 0-value or untrusted "transfer" is address poisoning: never shown)
      for (const x of t.transfers || []) {
        if (!eqA(x.to, safeAddr) || x.value === "0" || !x.value) continue;
        const tok = x.type === "ETHER_TRANSFER" ? { symbol: nat(chain), decimals: 18 } : x.tokenInfo?.trusted && x.tokenInfo.type === "ERC20" ? x.tokenInfo : null;
        if (!tok) continue;
        const p = priceOf(x.type === "ETHER_TRANSFER" ? null : x.tokenAddress || x.tokenInfo?.address || "-");
        const $usd = p !== null ? ` <span class="fine">(${esc(usd(Number(BigInt(x.value)) / 10 ** tok.decimals * p))})</span>` : "";
        rows.push(`<li><span class="sx-ic sx-in">↓</span><span class="sx-act-what"><b>Received ${esc(E.fmt(BigInt(x.value), tok.decimals, 4))} ${esc(tok.symbol)}${$usd}</b><span class="fine">from ${address(x.from, { size: "sm", chain })} · ${esc(when)}</span></span>${link ? `<a class="sx-end fine" href="${link}" target="_blank" rel="noopener">↗</a>` : ""}</li>`);
      }
    }
    box.innerHTML = `<h3>Activity</h3>${rows.length ? `<ul class="sx-acts">${rows.join("")}</ul>`
      : `<p class="fine">${activity === null ? "Loading." : activityErr || "Nothing yet."}</p>`}
      <p class="sx-foot"><a class="fine" href="${appLink(chain, safeAddr, "transactions/history")}" target="_blank" rel="noopener">All of it in Safe{Wallet} ↗</a></p>`;
  }
  /** After a sign: the queue is at the bottom, so take the page there (once it's repainted). */
  const toQueue = () => requestAnimationFrame(() => $("s-queue").scrollIntoView({ behavior: "smooth", block: "center" }));
  const safeTx = (to: string, value: string, data: string, nonce = nextNonce()): E.SafeTx =>
    ({ to: E.checksum(to), value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce });

  /**
   * The wedgie signs t; the page checks it signed the same hash, and that its signer contract can be checked on chain.
   * One signature per owner slot it has here: Instant Wallet's two slots take the same press.
   */
  async function wedgieSig(t: E.SafeTx) {
    if (!wedgie || !key) throw new Error(noWedgie());
    const slots = ownedBy();
    if (!slots.length) throw new Error("Your wedgie isn't an owner of this Safe.");
    for (const a of slots) if (!(await hasCode(chain, a))) { deployed[chain] = false; throw new Error(`The wedgie's signer contract isn't on ${CHAINS[chain].name} yet: Deploy it (above) first. Safe checks its signatures through it.`); }
    const tx = { chainId: chain, safe: safeAddr, to: t.to, value: String(t.value), data: t.data || "0x", operation: +t.operation,
      safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice), gasToken: t.gasToken || Z,
      refundReceiver: t.refundReceiver || Z, nonce: +t.nonce };      // only the fields: the wedgie reads one line of at most 6 KB
    const big = JSON.stringify({ id: 1000, type: "safe_sign", tx }).length > LINE_MAX;
    const n = (tx.data.length - 2) / 2;
    if (big && (!chunk || n > DATA_MAX))
      throw new Error(chunk ? `This transaction has ${n} bytes of data: a wedgie takes up to ${DATA_MAX}. Sign it another way.`
        : "This transaction is too big for the wedgie to read in one go: update the Safe Signer app on it (its page, Software).");
    asking = true; paintAll();
    say("Look at the wedgie: check what it shows, then press the green button to sign (red says no).");
    // what the registry says about it (ERC-7730), sent ahead: the wedgie checks it against its own roots
    const cb = clearTag && chunk ? await Clear.bundle(clearTag, chain, { ...t, safe: safeAddr }, reviewRound).catch(() => null) : null;
    const close = pressModal("Check it", "then sign", "sign");     // its pages say next, then sign
    try {
      const g = await ask(wedgie, async (r) => {
        for (let o = 0; cb && o < cb.length; o += chunk) {
          const a = await r.request({ type: "safe_clear", at: o / 2, hex: cb.slice(o, o + chunk) }, 20000);
          if (a.type !== "safe_clear") break;           // it can still sign; it just can't read the call
        }
        // a simulation, asked with the wedgie's own nonce. None (no internet, a revert, too big): the usual pages
        // a batch too (Safe Signer 47+: older ones ignore a batch's and show the usual pages)
        const sim = simOk ? await simulate(r, tx).catch(() => null) : null;
        if (!big) {
          const withSim = sim ? { ...tx, sim } : tx;
          return r.request({ type: "safe_sign", tx: JSON.stringify({ id: 1000, type: "safe_sign", tx: withSim }).length > LINE_MAX ? tx : withSim }, 200000);
        }
        say("Sending the transaction to the wedgie in pieces.");
        const hex = tx.data.slice(2);
        for (let o = 0; o < hex.length; o += chunk) {        // its data first, then the tx with data "@"
          const a = await r.request({ type: "safe_data", at: o / 2, hex: hex.slice(o, o + chunk) }, 20000);
          if (a.type !== "safe_data") throw new Error(a.error || "The wedgie didn't take a piece.");
        }
        say("Look at the wedgie: check what it shows, then press the green button to sign (red says no).");
        return r.request({ type: "safe_sign", tx: { ...tx, data: "@", ...(sim ? { sim } : {}) } }, 200000);
      });
      if (g.type === "refused") throw new Error("The wedgie said no.");
      if (g.type !== "safe_sig") throw new Error(g.error || "The wedgie didn't sign.");
      if (g.safeTxHash !== E.safeTxHash(chain, safeAddr, t)) throw new Error("The wedgie signed a different hash: not sent.");
      return slots.map((a) => ({ owner: a, signature: E.safeSignature(a, g as E.WedgieSig) }));
    } finally { asking = false; close(); }
  }
  /** clear-sim's signed answer for tx, from the Safe, with a nonce the wedgie just picked (the wedgie checks it). */
  async function simulate(r: Drive.Asker, tx: { chainId: number; safe: string; to: string; value: string; data: string; operation: number }) {
    const n = await r.request({ type: "safe_nonce" }, 5000);
    if (n.type !== "safe_nonce") return null;
    return Sim.simulate({ chain: tx.chainId, safe: tx.safe, tx: { to: tx.to, value: BigInt(tx.value), data: tx.data as `0x${string}`, operation: tx.operation },
      url: SIM_URL, nonce: n.nonce, check: false, timeout: 15000 });
  }
  async function walletSig(t: E.SafeTx) {
    const from = account = await wallet(chain);
    if (!isOwner(from)) throw new Error(`This wallet (${short(from)}) isn't an owner of this Safe.`);
    say("Sign it in your wallet.");
    const sig = await eth().request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(E.typedData(chain, safeAddr, t))] });
    return { owner: from, signature: E.ecdsa(sig) };
  }

  /**
   * One signature on a new Safe transaction, into Safe's queue, where every owner sees it. Never run from
   * here, even when one is enough: the dock's Execute does that, so the wallet opens only on a tap (Austin).
   */
  async function propose(t: E.SafeTx, who: "wedgie" | "wallet", what: string) {
    if (who === "wallet") say(`Sign it in your wallet: ${what}.`);
    const sigs = who === "wedgie" ? await wedgieSig(t) : [await walletSig(t)];
    say("Putting it in the Safe's queue.");
    await share(t, sigs);
    if (sub === "settings") go(route(chain, safeAddr));     // the queue is on the Safe's page
    await load(true);
    toQueue();
    const left = Math.max(0, info!.threshold - sigs.length);
    say(left ? `In the queue with ${who === "wedgie" ? "the wedgie's" : "your"} signature: ${what}. ${plural(left, "more owner")} to sign, then Execute.`
      : `Signed: ${what}. Press Execute (a browser wallet pays the gas).`);
  }

  async function signQueued(t: any, who: "wedgie" | "wallet") {
    const sigs = who === "wedgie" ? await wedgieSig(t) : [await walletSig(t)];
    if (E.safeTxHash(chain, safeAddr, txOf(t)).toLowerCase() !== String(t.safeTxHash).toLowerCase()) throw new Error("The queue has a different hash for this one: not sent.");
    say("Sending the signature.");
    await share(txOf(t), sigs, t);
    await load(true);
    toQueue();
    const u = queue.find((x) => x.safeTxHash === t.safeTxHash);
    say(u && (u.confirmations || []).length >= (u.confirmationsRequired ?? info!.threshold) ? "Signed. That's enough: press Execute." : "Signed. Execute it here: Safe{Wallet} can't yet.");
  }

  /** After nonce n ran: the RPC and Safe's API catch up seconds later, so read again until both have moved on. */
  async function settle(n: number) {
    for (let i = 0; i < 20; i++) {
      say("It ran. Updating the Safe.", 75 + 20 * (1 - 0.8 ** i));
      await load(true, true);      // as the background check: Safe's service again once the nonce moves (a new version)
      if (info && info.nonce > n && !queue.some((x) => +x.nonce <= n)) return;
      await sleep(2000);
    }
  }

  /** Every owner's signature from Safe's API, packed; a browser wallet sends it (and pays the gas). */
  /**
   * The signed ones in a row from the Safe's nonce, the first ready one at each number. Only ones with every
   * signature in hand: an on-chain approval with no approveHash counts only when its owner sends the tx itself.
   */
  function readyRun() {
    const i = info!, run: any[] = [];
    for (let n = i.nonce; ; n++) {
      const t = queue.find((x) => +x.nonce === n && (x.confirmations || []).length >= (x.confirmationsRequired ?? i.threshold)
        && x.confirmations.every((c: any) => c.signature));
      if (!t) return run;
      run.push(t);
    }
  }
  /** Several in one wallet transaction: Multicall3 calls execTransaction for each, in order. One fails: none run. */
  async function executeAll(run: any[]) {
    if (+run[0].nonce !== info!.nonce) throw new Error(`#${info!.nonce} runs first: a Safe runs its transactions in order.`);
    say("Getting it ready.", 2);
    const calls = run.map((t) => ({ to: safeAddr, allowFailure: false, data: E.execData(t, E.packSignatures(t.confirmations)) }));
    const rc = await send(chain, E.MULTICALL3, E.aggregate3(calls), say);
    for (const t of run) if (t.wc) await tellApp(chain, safeAddr, String(t.safeTxHash).toLowerCase(), t.wc, rc.transactionHash).catch(() => {});
    await settle(+run.at(-1).nonce);
    say(`Done: all ${run.length} ran.`);
  }
  async function execute(t: any) {
    if (+t.nonce !== info!.nonce) throw new Error(`#${info!.nonce} runs first: a Safe runs its transactions in order.`);
    say("Getting it ready.", 2);
    const sigs = (t.confirmations || []).map((c: any) => ({ owner: c.owner,
      signature: c.signature || E.hex(E.cat(E.aword(c.owner), E.word(0), new Uint8Array([1]))) }));   // an approveHash on chain
    const rc = await send(chain, safeAddr, E.execData(t, E.packSignatures(sigs)), say);
    if (t.wc) await tellApp(chain, safeAddr, String(t.safeTxHash).toLowerCase(), t.wc, rc.transactionHash).catch(() => {});
    await settle(+t.nonce);
    say(t.wc ? `Done: it ran. ${t.wc.dapp.name} has its hash.` : "Done: it ran.");
  }

  // ---- Send (a sheet): a token, an amount, who to; the review says it in words before anyone signs ----
  const sendList = (): Asset[] => assets || [{ token: null, ...CHAINS[chain].native, decimals: 18, balance: info?.balance || 0n, usd: null, price: null },
    ...(CHAINS[chain].usdc && info?.usdc !== null ? [{ token: CHAINS[chain].usdc!, symbol: "USDC", name: "USD Coin", decimals: 6, balance: info!.usdc!, usd: null, price: null, logo: null }] : [])];
  const picked = () => { const v = (document.getElementById("n-tok") as HTMLSelectElement | null)?.value || ""; return sendList().find((a) => (a.token || "") === v) || sendList()[0]; };
  function paintNew() {
    const box = $("s-new");
    box.hidden = !(sheet === "send" && safeAddr && info && can());
    if (box.hidden) return;
    if (!document.getElementById("n-to")) {      // built once per open: keep what's typed across repaints
      box.innerHTML = `<h2>Send</h2>
        <div class="sx-amount"><input id="n-amt" placeholder="0" inputmode="decimal" autocomplete="off"><button class="sx-tokbtn" id="n-tokbtn" type="button" aria-haspopup="listbox"></button><select id="n-tok" hidden></select>
          <ul class="sx-assets sx-toklist" id="n-toklist" role="listbox" hidden></ul></div>
        <p class="sx-row sx-under"><span class="fine" id="n-usd"></span><span class="sx-end"><span class="fine" id="n-has"></span> <button class="btn btn-sm" id="n-max" type="button">Max</button></span></p>
        <p class="sx-label">To</p><p>${addressInput("n-to", "0x… or ENS name")}</p>
        <details class="sx-more"><summary>Contract call data</summary><p><input id="n-data" class="sx-mono" placeholder="0x…" spellcheck="false" autocomplete="off"></p><p class="fine">Only with ${esc(nat(chain))}. Leave it empty to just send.</p></details>
        <div class="sx-review" id="n-review" hidden></div>
        <p class="sx-row" id="n-btns"></p>`;
      // all of it: the Safe pays no gas itself (the wallet that executes does), so the whole balance can go
      $("n-max").onclick = () => { const a = picked(); ($("n-amt") as HTMLInputElement).value = E.fmt(a.balance, a.decimals, a.decimals); review(); };
      for (const id of ["n-amt", "n-tok", "n-data"]) $(id).addEventListener("input", review);
      $("n-to").addEventListener("input", review);
      box.addEventListener("address", review);
      // the token picker: a list like Assets (logo, name, dollars), over the form; the hidden select keeps the choice
      const list = $("n-toklist");
      $("n-tokbtn").onclick = (e) => { e.stopPropagation(); list.hidden = !list.hidden; };
      list.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
        if (!b) return;
        const sel = $("n-tok") as HTMLSelectElement;
        sel.value = b.dataset.pick!; list.hidden = true; paintTok(); review();
      };
      box.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("#n-toklist")) list.hidden = true; });
      requestAnimationFrame(() => ($("n-amt") as HTMLInputElement).focus());
    }
    const sel = $("n-tok") as HTMLSelectElement, keep = sendToken !== null ? sendToken : sel.value;
    sendToken = null;
    sel.innerHTML = sendList().map((a) => `<option value="${a.token || ""}"${(a.token || "") === keep ? " selected" : ""}>${esc(a.symbol)}</option>`).join("");
    paintTok();
    $("n-btns").innerHTML = `${isOwner(account) ? `<button class="btn${wedgieOwns() ? "" : " btn-green sx-end"}" id="n-wallet"${dis()}>Sign with wallet</button>` : ""}${wedgieOwns() ? `<button class="btn btn-green sx-end" id="n-wedgie"${dis()}>Sign with wedgie</button>` : ""}`;   // primary on the right
    $("n-wedgie")?.addEventListener("click", () => job(() => newTx("wedgie")));
    $("n-wallet")?.addEventListener("click", () => job(() => newTx("wallet")));
    review();
  }
  function paintTok() {
    const a = picked(), list = sendList().filter((x) => x.token === null || x.price !== null || x.token === a.token);   // no spam in the picker
    $("n-tokbtn").innerHTML = `<span class="sx-tok-on">${tokenBadge(a.symbol, a.logo)}${chainLogo(chain)}</span><b>${esc(a.symbol)}</b><span class="sx-caret">▾</span>`;
    $("n-toklist").innerHTML = list.map((x) => `<li><button class="sx-asset${x === a ? " sx-picked" : ""}" type="button" role="option" data-pick="${x.token || ""}">${assetInner(x)}</button></li>`).join("");
  }
  /** What the inputs make, or why they don't make one yet. */
  function draft(): { t: E.SafeTx; what: string } {
    const to = addressOf($("n-to") as HTMLInputElement) || ($("n-to") as HTMLInputElement).value.trim(), amt = ($("n-amt") as HTMLInputElement).value.trim() || "0";
    const a = picked(), data = ($("n-data") as HTMLInputElement).value.trim() || "0x";
    if (!E.isAddress(to)) throw new Error("Who to? An address or an ENS name.");
    E.bytes(data);
    const n = E.units(amt, a.decimals);
    if (n > a.balance) throw new Error(`The Safe has ${E.fmt(a.balance, a.decimals)} ${a.symbol}.`);
    if (a.token) {
      if (data !== "0x") throw new Error(`Data goes with ${nat(chain)}, not ${a.symbol}.`);
      if (!n) throw new Error("How much?");
      return { t: safeTx(a.token, "0", E.transferData(E.checksum(to), n)), what: `send ${amt} ${a.symbol} to ${short(to)}` };
    }
    if (!n && data === "0x") throw new Error("How much?");
    return { t: safeTx(to, n.toString(), data), what: data === "0x" ? `send ${amt} ${nat(chain)} to ${short(to)}` : `call ${short(to)}` };
  }
  function review() {
    const a = picked(), amt = ($("n-amt") as HTMLInputElement | null)?.value.trim() || "";
    $("n-has").textContent = `${E.fmt(a.balance, a.decimals, 4)} ${a.symbol}`;
    let v = 0; try { v = Number(E.units(amt || "0", a.decimals)) / 10 ** a.decimals; } catch {}
    $("n-usd").textContent = a.price !== null && v ? `≈ ${usd(v * a.price)}` : "";
    const box = $("n-review");
    try {
      const { t } = draft(), s = describe(t, ctx()), left = Math.max(0, info!.threshold - (wedgieOwns() ? ownedBy().length : 1));
      box.innerHTML = `<p><b>${s.title}</b></p>${left ? `<p class="fine">Then ${plural(left, "more owner")} must sign.</p>` : ""}`;
      box.hidden = false; box.classList.remove("sx-review-no");
    } catch (e) {
      box.hidden = !amt && !($("n-to") as HTMLInputElement).value.trim();
      box.innerHTML = `<p class="fine">${esc(msgOf(e))}</p>`; box.classList.add("sx-review-no");
    }
  }
  async function newTx(who: "wedgie" | "wallet") {
    const { t, what } = draft();
    await propose(t, who, what);
    closeSheet();
  }

  // ---- Receive (a sheet): the address big, a QR, which chain ----
  function paintReceive() {
    const box = $("s-receive");
    box.hidden = !(sheet === "receive" && safeAddr);
    if (box.hidden || box.dataset.for === `${chain}:${safeAddr}`) return;
    box.dataset.for = `${chain}:${safeAddr}`;
    box.innerHTML = `<h2>Receive</h2>
      <div class="sx-qr">${addressQr(safeAddr, safeAddr)}</div>
      <p class="sx-recv-addr">${esc(safeAddr)}</p>
      <p><button class="btn btn-green sx-wide" id="r-copy">Copy address</button></p>
      <p class="sx-warn-soft">Only on <b>${esc(CHAINS[chain].name)}</b>. On another chain it may be lost.</p>`;
    $("r-copy").onclick = () => navigator.clipboard.writeText(safeAddr).then(() => { $("r-copy").textContent = "Copied"; setTimeout(() => { const b = document.getElementById("r-copy"); if (b) b.textContent = "Copy address"; }, 1500); });
  }

  // ---- the sheet ----
  function openSheet(k: typeof sheet) {
    sheet = k; say("");
    if (k === "send") $("s-new").innerHTML = "";        // a fresh form each time
    if (k === "receive") delete $("s-receive").dataset.for;
    $("s-sheet").hidden = false;
    document.body.classList.add("sx-sheet-open");
    paintAll();
  }
  function closeSheet() {
    if (!sheet) return;
    sheet = ""; stopScan();
    $("s-sheet").hidden = true;
    document.body.classList.remove("sx-sheet-open");
    paintAll();
  }
  $("s-sheet-x").onclick = closeSheet;
  $("s-sheet").addEventListener("click", (e) => { if (e.target === $("s-sheet") && !busy) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet && !busy) closeSheet(); });

  // ---- WalletConnect: this Safe in an app (Uniswap, …); its batches signed on the wedgie (src/safe/walletconnect.ts) ----
  let wcm: typeof import("../safe/walletconnect") | null = null, wcSessions: import("../safe/walletconnect").Session[] = [];
  let asks: import("../safe/walletconnect").Ask[] = [];
  const WC_ON = "wedgie.wc";       // set once an app was connected here: WalletKit starts with the page from then on
  async function wcStart() {
    if (wcm) return wcm;
    const m = await import("../safe/walletconnect");
    await m.start({
      onAsk: (a) => {
        if (asks.some((x) => x.id === a.id && x.topic === a.topic)) return;
        asks.push(a);
        if (sheet === "connect") closeSheet();
        if (!eqA(a.safe, safeAddr) || a.chainId !== chain) say(`${a.dapp.name} is waiting for Safe ${short(a.safe)}: open it to sign.`);
        takeAsks();
      },
      onChange: () => { m.sessions().then((l) => { wcSessions = l; paintApps(); }); },
      onError: (msg) => say(msg, true),
      receipt: (c, h) => rpc(c, "eth_getTransactionReceipt", [h]).then((x: any) => x),
    });
    wcm = m;
    return m;
  }
  try { if (localStorage.getItem(WC_ON)) wcStart().catch(() => {}); } catch {}

  // an app's logo through /api/icon (the site's COEP blocks other sites' <img>); its first letter if none
  const icon = (d: { name: string; icon?: string }) =>
    tokenBadge(d.name, d.icon && /^https:\/\//.test(d.icon) ? `/api/icon?u=${encodeURIComponent(d.icon)}` : null);
  // Connect app (a sheet): scan the app's WalletConnect code, or paste its link; the apps connected here
  let scanning: { stop: () => void } | null = null;
  const stopScan = () => { scanning?.stop(); scanning = null; const v = document.getElementById("wc-cam"); if (v) v.hidden = true; };
  async function pairWith(uri: string) {
    const m = await wcStart();
    say("Connecting to the app.");
    await m.pair(uri.trim(), safeAddr, chain);
    try { localStorage.setItem(WC_ON, "1"); } catch {}
    closeSheet();
    say(`Connected. What the app asks for shows up here.`);
  }
  function paintWc() {
    const box = $("s-wc");
    box.hidden = !(sheet === "connect" && safeAddr && info && can());
    if (box.hidden) return;
    if (!document.getElementById("wc-uri")) {     // built once per Safe: keep a pasted link across repaints
      box.innerHTML = `<h2>Connect an app</h2>
        <p class="fine">In the app (Uniswap, Aave, …) pick WalletConnect and copy its link. Paste it here (or anywhere on this page). Its requests come here, and your wedgie signs them.</p>
        ${canScan() ? `<p><button class="btn btn-grey sx-wide" id="wc-scan">Scan its code</button></p><div class="sx-cam" id="wc-cam" hidden></div>` : ""}
        <p class="sx-label">Or paste its link</p>
        <p class="sx-row wc-pair"><input id="wc-uri" class="sx-mono" placeholder="wc:…" spellcheck="false" autocomplete="off"> <button class="btn btn-sm btn-green" id="wc-go">Connect</button></p>
`;
      const uri = $("wc-uri") as HTMLInputElement, go = $("wc-go");
      go.onclick = () => job(async () => { await pairWith(uri.value); uri.value = ""; });
      $("wc-scan")?.addEventListener("click", () => {
        if (scanning) return stopScan();
        const cam = $("wc-cam"); cam.hidden = false;
        const s = scanning = scan(cam);
        s.done.then((uri) => { stopScan(); if (!/^wc:/.test(uri)) return say("That code isn't a WalletConnect link.", true); job(() => pairWith(uri)); },
          (e: Error) => { if (e.message !== "stopped") say(e.message, true); stopScan(); });
      });
    }
  }

  // the apps connected to this Safe: on its page, above Assets, each with Disconnect
  function paintApps() {
    const box = $("s-apps");
    const mine = wcSessions.filter((x) => eqA(x.safe, safeAddr) && x.chainId === chain);
    box.hidden = !(safeAddr && info && mine.length && sub === "home");
    if (box.hidden) return;
    box.innerHTML = `<h3>Connected</h3><ul class="sx-rows">${mine.map((x) => `<li class="wc-app">${icon(x.dapp)}<span class="sx-asset-name"><b>${esc(x.dapp.name)}</b><span class="fine">${esc(x.dapp.url.replace(/^https?:\/\//, ""))}</span></span><button class="btn btn-sm btn-red sx-end" data-wcoff="${esc(x.topic)}"${dis()}>Disconnect</button></li>`).join("")}</ul>`;
    box.querySelectorAll<HTMLButtonElement>("[data-wcoff]").forEach((b) => b.onclick = () => job(() => wcm!.disconnect(b.dataset.wcoff!)));
  }

  /**
   * What connected apps ask for goes straight into this Safe's queue, unsigned, kept in this browser: sign it
   * there, Execute it there, and the app gets the tx hash (execute → tellApp). WalletKit replays an unanswered
   * request on every load: one already in the queue isn't added twice.
   */
  function takeAsks() {
    if (!info || queueOf !== `${chain}:${safeAddr}`) return;      // its number needs this Safe's queue
    const here = asks.filter((a) => eqA(a.safe, safeAddr) && a.chainId === chain);
    if (!here.length) return;
    asks = asks.filter((a) => !here.includes(a));
    const mine = localQ(chain, safeAddr);
    let added = 0;
    for (const a of here) {
      if (Object.values(mine).some((t: any) => t.wc && t.wc.topic === a.topic && t.wc.id === a.id)) continue;
      const t = a.calls.length === 1 ? safeTx(a.calls[0].to, a.calls[0].value.toString(), a.calls[0].data)
        : { ...safeTx(E.MULTISEND_CALL_ONLY, "0", E.multiSendData(a.calls)), operation: 1 };
      const h = E.safeTxHash(chain, safeAddr, t).toLowerCase();
      mine[h] = { ...t, safeTxHash: h, confirmations: [], wc: { topic: a.topic, id: a.id, method: a.method, dapp: a.dapp } };
      queue = [...queue, mine[h]].sort((x, y) => +x.nonce - +y.nonce);
      added++;
    }
    try { localStorage.setItem(qKey(chain, safeAddr), JSON.stringify(mine)); } catch {}
    if (!added) return;
    paintAll();
    toQueue();
    say(`${here[0].dapp.name} asks: it's in Waiting. Sign it there, then Execute.`);
  }
  /** An app's request off the queue before anyone signed it: only this browser had it. */
  async function dropAsk(t: any, why: string) {
    const mine = localQ(chain, safeAddr);
    delete mine[String(t.safeTxHash).toLowerCase()];
    try { localStorage.setItem(qKey(chain, safeAddr), JSON.stringify(mine)); } catch {}
    queue = queue.filter((x) => x !== t);
    await wcStart().then((m) => m.answerError(t.wc.topic, t.wc.id, why)).catch(() => {});
  }

  function paintAll() {
    paintWedgie(); paintWallet(); paintList(); paintCreate(); paintSafe(); paintAdd(); paintQueue(); paintApps(); paintAssets(); paintActivity();
    paintOwners(); paintAddons(); paintOwner(); paintChains(); paintNew(); paintReceive(); paintWc();
    if (wcLink && safeAddr && info && !busy) { const u = wcLink; wcLink = ""; setTimeout(() => job(() => pairWith(u), false)); }
  }
  // A wc: link pasted anywhere on a Safe's page (not into a box) connects that app: copy it in the app, Cmd+V here.
  document.addEventListener("paste", (e) => {
    const t = (e.clipboardData?.getData("text") || "").trim();
    if (!/^wc:[0-9a-f]+@2\?/i.test(t) || !safeAddr || !info || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    job(() => pairWith(t), false);
  });

  W.onChange(paintWedgie);
  W.start();          // serial ports only once armed (start waits for it); virtual wedgies right away
  if (localStorage.getItem(WCP) && !localStorage.getItem(OFF))      // the wallet from last time, back on its own
    rainbow().then((r) => r.start(onWallet), () => {});
  else (window.requestIdleCallback ?? setTimeout)(() => rainbow().catch(() => {}));
  loadLast();
  show();
}
