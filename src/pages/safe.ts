// wedgie.dev/safe: a wedgie as a signer on a Safe. The wedgie runs the Safe Signer app
// (clawdbotatg/wedgie-safe): its key lives in the secure chip (ATECC608 or Trust M), it shows each transaction and signs on A.
// Its key is a Safe owner through Safe's passkey signer contract (eth.ts signerAddress, no RPC).
// Three views, one page (history.pushState between them, so the wedgie's key is read once), laid out like
// Instant Wallet: a big balance, three buttons, then what's waiting, what it holds, what happened.
//   /safe                    every Safe the wedgie owns on every chain, as cards (Safe's API, plus the ones made
//                            or opened in this browser), the wallet's Safes it could join, New Safe (a sheet)
//   /safe/<chain>:<address>  one Safe: its balance in dollars, Send / Receive / Connect app (sheets), apps'
//                            requests, Waiting (sign, execute, reject), Assets (every token), Activity
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
import * as W from "../serial/wedgies";
import * as Drive from "../serial/drive";
import * as E from "../safe/eth";
import { address, addressInput, addressOf, watch } from "../safe/address";
import { describe, type Ctx, type Said } from "../safe/describe";
import { explain, callsOf } from "../safe/explain";
import { readAssets, tokenMeta, knownMeta, usd, type Asset } from "../safe/assets";
import { canScan, scan } from "../safe/scan";
import { addressQr } from "../safe/qr";

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
const LINE_MAX = 6000;      // the wedgie drops a USB line over 6 KB
const DATA_MAX = 8000;      // wedgie-safe safe_data pieces: up to this many bytes (what an RP2040 heap joins safely)

// Safe's service goes through /api/safe (our key: without one Safe allows 5,000 reads a month per IP, and one person's
// page used that up, 10-21), at most 3 at a time (the key: 5 a second). A local preview has no /api: straight there.
const SAFE = "https://api.safe.global/tx-service/";
const via = (url: string) => {
  const fresh = url.endsWith("?fresh"), u = fresh ? url.slice(0, -6) : url;
  return u.startsWith(SAFE) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? `${location.origin}/api/safe?u=${encodeURIComponent(u.slice(SAFE.length))}${fresh ? "&fresh=1" : ""}` : u;
};
/** Our daily share of Safe's service is used (/api/safe's 429): the rest comes from the chain till tomorrow. */
const REST = "Safe's service is resting till tomorrow.";
let safeBusy = 0;
const safeWait: (() => void)[] = [];
async function safeFetch(url: string, init?: RequestInit) {
  if (safeBusy >= 3) await new Promise<void>((r) => safeWait.push(r));
  safeBusy++;
  try { return await fetch(via(url), init); } finally { safeBusy--; safeWait.shift()?.(); }
}
async function get(url: string) {
  const r = await safeFetch(url);
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
/** A burst can be rate-limited (a list of Safes reads several at once): wait and try again. */
async function rpc(chain: number, method: string, params: unknown[]): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(readUrl(chain), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      // 429: /api/rpc's own limit ("Too many reads") or Alchemy's ("Busy."): say which
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`${CHAINS[chain].name}: ${(await res.json().catch(() => null))?.error || "busy"} (${res.status})`), { again: true });
      const r = await res.json();
      if (r.error) throw new Error(`${CHAINS[chain].name}: ${r.error.message || r.error}`);    // a JSON-RPC error, or /api/rpc's own
      return r.result;
    } catch (e: any) {
      if (i >= 5 || !(e.again || e instanceof TypeError)) throw e;     // TypeError: the fetch itself failed (~20 s of tries)
      await sleep(600 * 2 ** i);
    }
  }
}
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
    const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) { if (r.status !== "0x1") throw new Error(`It failed on chain: ${CHAINS[chain].scan}/tx/${hash}`); return r; }
    await sleep(1500);
  }
  throw new Error("Still not in a block: " + hash);
}

type Info = { owners: string[]; threshold: number; nonce: number; balance: bigint; usdc: bigint | null };
type Row = { chain: number; addr: string; wedgie: boolean; wallet: boolean; info?: Info | null; err?: string; gone?: boolean };
const KEYS = Object.fromEntries(IDS.map((id) => [CHAINS[id].key, id]));
const route = (chain: number, a: string) => `/safe/${CHAINS[chain].key}:${a}`;

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
    <div class="sx-card" id="s-asks" hidden></div>
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
  // a sheet over the page (a bottom sheet on a phone): one at a time
  let sheet: "" | "create" | "send" | "receive" | "connect" = "", sendToken: string | null = null;

  // the old page's "last Safe" (it opened that one every time): moved into the list once the wedgie is read
  let oldSaved = "";
  try { oldSaved = localStorage.getItem("wedgie.safe") || ""; } catch {}
  const old = new URLSearchParams(location.search).get("safe")?.match(/^(\w+):(0x[0-9a-fA-F]{40})$/);
  if (old && KEYS[old[1]]) history.replaceState(null, "", route(KEYS[old[1]], E.checksum(old[2])));

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
  async function job(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true; paintAll();
    try { await fn(); } catch (e) { fail(e); } finally { busy = false; paintAll(); }
  }
  // stale: the Safe on screen is the saved copy (viewCache) till the chain answers: nothing signs off an old nonce
  const dis = (extra = false) => (busy || asking || stale || extra ? " disabled" : "");

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
  });
  // what describe.ts can't read: clear signing, else 🤖 (src/safe/explain.ts)
  const said = (t: any) => { const s = describe(t, ctx(), t.dataDecoded?.method); return explain(s, callsOf(t, s), chain, safeAddr, ctx().addr, paintAll); };
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
  /** A token as a row: its logo, symbol and name, its dollars and amount (Assets, and Send's picker). */
  const assetInner = (a: Asset) => `${tokenBadge(a.symbol, a.logo)}
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
  // the chain's answer replaces it. Buttons wait for the fresh one (stale). Never the queue (always read fresh), never
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
    $("s-spin").hidden = !on || big || !!(inList && !$("s-list").hidden);
    $("s-first").hidden = !big;
  }
  // No wedgie here: the way back to get one (same as /connect without one).
  const HOME = `<a class="btn btn-green" href="/">Back to wedgie.dev</a>`;
  function paintWedgie() {
    // the wedgie whose key we read was unplugged: read the next one's (another wedgie = another list)
    if (wedgie && wedgie !== DRIVE && !present(wedgie)) { wedgie = null; key = null; }
    const ws = Drive.inApp() ? (driveState === "here" ? [DRIVE] : []) : W.wedgies().filter((w) => w.state === "ready");
    const app = ws.filter((w) => w.running === "safe");
    // Only what needs a hand from you shows here. Connecting, reading the key: just the spinner (paintSpin), and
    // with a saved list nothing at all: the list is already there (Austin, 10-21: no boxes that push the page down).
    const known = !!signer, all = Drive.inApp() ? [] : W.wedgies().filter((w) => w.state !== "gone");
    const bad = all.find((w) => w.state === "error");
    const gone = `<p class="sx-row">${HOME}<a class="btn" href="/connect">Connect a wedgie</a></p>`;
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
    const c = chain;
    try { deployed[c] = await hasCode(c, ownedBy()[0] || signer); } catch { deployed[c] = undefined; }
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
    box.innerHTML = !account ? `<button class="btn btn-sm btn-wallet" id="w-go"${dis()}>Connect wallet</button>`
      : `<span class="safe-id-tag">wallet</span>${address(account)}${isOwner(account) ? `<span class="good">owner</span>` : ""}
      <button class="btn btn-sm" id="w-off">Disconnect</button>`;
    $("w-go")?.addEventListener("click", () => job(async () => {
      account = await wallet(safeAddr ? chain : newChain);
      (await rainbow()).watch(onWallet); hear(wcp);
      try { localStorage.removeItem(OFF); } catch {}
      if (!safeAddr) findSafes();
    }));
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
    await Promise.all(IDS.map(async (c) => {
      await Promise.all(signers.map(async (a) => { for (const s of await of(c, a)) add(c, s, "wedgie"); asked++; tick(); }));
      if (account) { for (const s of await of(c, account)) add(c, s, "wallet"); asked++; tick(); }
    }));
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
    }
    if (me !== signer) { listing = false; findAgain = false; return findSafes(); }
    // a Safe the chain couldn't be read for stays listed (as its sources said): never hidden by a busy RPC
    rows = list.filter((r) => (!r.info && !r.gone) || r.wedgie || r.wallet)
      .sort((a, b) => +b.wedgie - +a.wedgie || +!!CHAINS[a.chain].test - +!!CHAINS[b.chain].test || a.chain - b.chain);
    listing = false;
    paintList();
    // each chain's coin price, for the cards' dollar totals (USDC counts as a dollar)
    await Promise.all([...new Set(rows.map((r) => r.chain))].map(async (c) => {
      try { ethPx[c] = (await rpc(c, "wedgie_prices", []))?.eth ?? null; } catch { ethPx[c] = null; }
    }));
    paintList();
    if (key) saveLast();
    if (findAgain) { findAgain = false; findSafes(); }
  }

  /** A Safe's dollars on one chain (native coin + USDC), null with no price yet; a test chain's coins: none. */
  const worthUsd = (c: number, i: Info) => CHAINS[c].test ? 0 : ethPx[c] ? Number(i.balance) / 1e18 * ethPx[c]! + Number(i.usdc || 0n) / 1e6 : null;
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
      const read = g.filter((r) => r.info), $s = read.map((r) => worthUsd(r.chain, r.info!));
      const n = $s.every((x) => x !== null) ? $s.reduce((a, x) => a! + x!, 0)! : null;
      // opens on the chain with the most in it
      const top = read.slice().sort((x, y) => (worthUsd(y.chain, y.info!) ?? 0) - (worthUsd(x.chain, x.info!) ?? 0))[0] || g[0], i = top.info;
      const chains = IDS.filter((t) => g.some((r) => r.chain === t));
      return `<li><a class="safe-row sx-safe${g.some((r) => r.wedgie) ? " sx-mine" : ""}" data-nav href="${route(top.chain, top.addr)}">
        <span class="sx-safe-top">${i && isIW(i.owners) ? iwMark : ""}${address(top.addr, { chain: top.chain })}</span>
        ${read.length ? `<span class="sx-safe-worth">${esc(n !== null ? usd(n) : read.map((r) => worth(r.chain, r.info!)).join(" · "))}</span>` : ""}
        ${i ? `<span class="fine">${i.threshold} of ${plural(i.owners.length, "owner")}${g.some((r) => r.wedgie) ? "" : " · add your wedgie"}</span>`
          : `<span class="fine">Couldn't read it just now. Open it, or Refresh.</span>`}
        <span class="sx-chains sx-chains-sm">${chains.map((t) => `<span class="sx-pill${CHAINS[t].test ? " sx-test" : ""}" title="${esc(CHAINS[t].name)}">${chainLogo(t)}</span>`).join("")}</span></a></li>`;
    };
    // most money first (a Safe that couldn't be priced yet: after the ones that could)
    const sum = (g: Row[]) => g.reduce((n, r) => n + (r.info ? worthUsd(r.chain, r.info) ?? 0 : 0), 0);
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
    $("l-wallet")?.addEventListener("click", () => { showWallet = !showWallet; paintList(); });
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
      d.innerHTML = `${addressInput("c-o" + ++rowN, "0x… or ENS name")} <button class="btn btn-sm" type="button" aria-label="Take this owner off">×</button>`;
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
    paintSpin();
    const box = $("s-safe"), iw = $("s-iw");
    box.hidden = !safeAddr;
    // an Instant Wallet Safe: say so on top, and send them there (it has no link to one Safe: its passkey opens it)
    iw.hidden = !(safeAddr && info && isIW(info.owners));
    // with its recovery and daily limit under it (repainted only when they change: the button stays put under a tap)
    const iwh = iw.hidden ? "" : `<div class="sx-iw-top"><img src="/img/instantwallet.png" alt=""><b>Instant Wallet</b>
      <a class="btn btn-green btn-sm sx-end" href="https://instantwallet.io" target="_blank" rel="noopener">Open</a></div>`
      + (addons ? `<ul class="sx-rows">${addonRows(addons.mods.filter((m) => m.kind === "recovery" || m.kind === "limit"), false)}</ul>` : "");
    if (iw.dataset.h !== iwh) { iw.dataset.h = iwh; iw.innerHTML = iwh; }
    if (box.hidden) return;
    const c = CHAINS[chain], i = info, home = route(chain, safeAddr), $t = total(), g = grand();
    const on = IDS.filter((t) => t === chain || copies[t]);   // fixed order: a tap only recolors
    // no number till the dollars are known (a coin amount first, then dollars, is a jump); no price at all: the coin
    const worthOf = !i || (!assets && !assetsErr) ? "" : $t !== null ? usd($t) : `${E.fmt(i.balance, 18, 4)} ${nat(chain)}`;
    const who = !i ? "" : `${i.threshold} of ${plural(i.owners.length, "owner")}`
      + (signer ? wedgieOwns() ? " · your wedgie is one" : " · your wedgie isn't one" : "");
    let h = `<div class="sx-hero-top">${sub === "settings" ? `<a class="sx-back" data-nav href="${home}">← Back</a>` : `<a class="sx-back" data-nav href="/safe">← Safes</a>`}
      ${sub === "home" ? `<a class="sx-gear" id="a-settings" data-nav href="${home}/settings">Settings</a>` : ""}</div>
      <div class="sx-hero-id">${address(safeAddr, { size: "lg", chain })}${g !== null ? `<span class="sx-grand"><b>${esc(usd(g))}</b> on all chains</span>` : ""}</div>
      <div class="sx-chains">${on.map((t) => t === chain ? `<span class="sx-pill sx-on">${chainLogo(t)}${esc(c.name)}</span>`
        : `<a class="sx-pill" data-nav href="${route(t, safeAddr)}${sub === "settings" ? "/settings" : ""}">${chainLogo(t)}${esc(CHAINS[t].name)}</a>`).join("")}</div>`;
    if (sub === "settings") h += `<div class="sx-total sx-total-sm">Settings</div><div class="sx-sub">${esc(who)}</div>`;
    else {
      h += `<div class="sx-total">${worthOf ? esc(worthOf) : "&nbsp;"}</div><div class="sx-sub">${i ? esc(who) : "Opening the Safe"}</div>`;
      if (i) h += `<div class="sx-actions">
        ${can() ? `<button class="sx-act" id="a-send"${dis()}><span>↑</span>Send</button>` : ""}
        <button class="sx-act" id="a-receive"><span>↓</span>Receive</button>
        ${can() ? `<button class="sx-act" id="a-connect"${dis()}><span>⇄</span>Connect app</button>` : ""}</div>`;
    }
    box.innerHTML = h;
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
      <ul class="sx-rows">${i.owners.map((o) => `<li>${address(o, { link: c.scan, chain })}${label(o)}${change ? `<button class="btn btn-sm sx-end" data-rm="${esc(o)}"${dis()}>Remove</button>` : ""}</li>`).join("")}</ul>
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
  async function load(quiet = false) {
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
      if (signer) { if (wedgieOwns()) { remember(c, a); tellWedgie(c, a); } else forget(c, a); }
      if (!quiet) say("");
      paintAll();             // the Safe from the chain now; its queue, tokens and history as the sources answer
      if (!quiet) checkCopies(c, a);
      loadAssets(c, a, i).catch(() => { if (c === chain && a === safeAddr) { assetsErr = true; paintSpin(); } });
      loadActivity(c, a);
      readAddons(c, a).then((x) => { if (c === chain && a === safeAddr) { addons = x; paintSafe(); paintAddons(); } }, () => {});
      const q = await readQueue(c, a, i.nonce);
      if (c !== chain || a !== safeAddr) return;
      queue = q;
    } catch (e: any) {
      opening = false; paintSpin();
      if (e?.gone) dropView(c, a);       // not there (any more): no saved copy of it
      // couldn't read it just now (busy): the saved copy stays up, buttons off, till Refresh works
      if (c === chain && a === safeAddr) { if (!stale || e?.gone) { info = null; stale = false; } queue = []; if (!quiet) fail(e); paintAll(); }
    }
    paintAll();
  }

  /** Every token it holds, with dollars (src/safe/assets.ts). */
  async function loadAssets(c: number, a: string, i: Info) {
    const got = await readAssets(c, a, CHAINS[c].native, i.balance, CHAINS[c].usdc ? { address: CHAINS[c].usdc!, balance: i.usdc } : null, (m, p) => rpc(c, m, p));
    if (c === chain && a === safeAddr) { assets = got; paintSafe(); paintAssets(); paintNew(); saveView(c, a); }
  }


  /** What happened: Safe's API (its executed transactions, and money that came in). */
  async function loadActivity(c: number, a: string) {
    try {
      const j = await within(get(`${api(c)}/safes/${a}/all-transactions/?executed=true&queued=false&limit=25`));
      if (c === chain && a === safeAddr) { activity = j.results || []; activityErr = ""; }
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
        if (i) { worths[t] = await worthOn(t, a, i); paintSafe(); }
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
        const cr = await get(`${api(t)}/safes/${a}/creation/`);
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
  const qKey = (c: number, a: string) => `wedgie.safe.q.${c}:${a.toLowerCase()}`;
  const localQ = (c: number, a: string): Record<string, any> => { try { return JSON.parse(localStorage.getItem(qKey(c, a)) || "{}"); } catch { return {}; } };
  const useIW = (c: number) => !CHAINS[c].test;
  const TX_FIELDS = ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"] as const;
  const txOf = (t: any): E.SafeTx => Object.fromEntries(TX_FIELDS.map((k) => [k, k === "data" ? t.data || "0x" : t[k]])) as any;

  async function readQueue(c: number, a: string, nonce: number): Promise<any[]> {
    const all = new Map<string, any>();
    const add = (t: any, sigs: { owner: string; signature: string | null }[], fromSafe = false) => {
      if (+t.nonce < nonce) return;
      const h = String(t.safeTxHash || t.hash).toLowerCase();
      const m = all.get(h) || { ...txOf(t), safeTxHash: t.safeTxHash || t.hash, confirmations: [], confirmationsRequired: t.confirmationsRequired, dataDecoded: t.dataDecoded };
      m.inSafe ||= fromSafe;
      if (t.dataDecoded) m.dataDecoded = t.dataDecoded;
      for (const s of sigs) if (!m.confirmations.some((x: any) => eqA(x.owner, s.owner))) m.confirmations.push(s);
      all.set(h, m);
    };
    const missed: string[] = [];
    let rest = false;
    await Promise.all([
      within(get(`${api(c)}/safes/${a}/multisig-transactions/?executed=false&nonce__gte=${nonce}&ordering=nonce&limit=20`))
        .then((j) => (j.results || []).forEach((t: any) => add(t, t.confirmations || [], true)))
        .catch((e: any) => { if (e.status === 429) rest = true; else if (e.status !== 404) missed.push("Safe's service"); }),   // 404: a Safe made seconds ago
      useIW(c) ? within(fetch(`${IWQ}?chainId=${c}&safe=${a}`).then((r) => r.json()))
        .then((j) => { if (j.error) throw new Error(j.error); (j.txs || []).forEach((t: any) => add({ ...t.tx, hash: t.hash }, t.sigs)); })
        .catch(() => missed.push("Instant Wallet")) : null,
    ]);
    const mine = localQ(c, a);
    for (const [h, t] of Object.entries(mine)) if (+t.nonce < nonce) delete mine[h]; else add(t, t.confirmations);
    try { localStorage.setItem(qKey(c, a), JSON.stringify(mine)); } catch {}
    queueNote = [rest ? REST : "", missed.length ? `${missed.join(" and ")} didn't answer just now.` : ""].filter(Boolean).join(" ");
    return [...all.values()].sort((x, y) => +x.nonce - +y.nonce);
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
    if (mine(o) && !confirm("Remove this wedgie as an owner? It won't be able to sign for this Safe.")) return;
    job(() => propose(safeTx(safeAddr, "0", E.removeOwnerData(at ? i.owners[at - 1] : E.SENTINEL, o, th)), by(), `remove owner ${short(o)}, then ${th} must sign`));
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
    $("ow-btns").innerHTML = `${wedgieOwns() ? `<button class="btn btn-green" id="ow-wedgie"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" id="ow-wallet"${dis()}>Sign with wallet</button>` : ""}`;
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
  function paintQueue() {
    const box = $("s-queue");
    box.hidden = !(safeAddr && info && sub === "home" && (queue.length || queueNote));
    if (box.hidden) return paintDock();       // an empty queue still takes the bottom bar away
    const i = info!;
    const signed = (t: any, a: string) => !!a && (t.confirmations || []).some((c: any) => eqA(c.owner, a));
    const cancelled = (n: number) => queue.some((x) => +x.nonce === n && said(x).kind === "cancel");
    const items = queue.map((t, k) => {
      const n = (t.confirmations || []).length, need = t.confirmationsRequired ?? i.threshold, first = +t.nonce === i.nonce, s = said(t);
      const btns: string[] = [], marks: string[] = [];
      if (wedgieOwns()) ownedBy().every((o) => signed(t, o)) ? marks.push("wedgie ✓")
        : btns.push(`<button class="btn btn-sm btn-green" data-sign="${k}"${dis(!key)}>Sign with wedgie</button>`);
      if (account && isOwner(account)) signed(t, account) ? marks.push("wallet ✓")
        : n < need && btns.push(`<button class="btn btn-sm" data-wsign="${k}"${dis()}>Sign with wallet</button>`);
      if (n >= need) btns.push(first ? `<button class="btn btn-sm btn-green" data-exec="${k}"${dis()}>Execute</button>` : `<span class="fine">runs after #${i.nonce}</span>`);
      if (can() && s.kind !== "cancel" && !cancelled(+t.nonce)) btns.push(`<button class="btn btn-sm sx-end" data-reject="${k}"${dis()}>Reject</button>`);
      const dots = Array.from({ length: need }, (_, d) => `<i class="${d < n ? "on" : ""}"></i>`).join("");
      return `<li class="sx-tx sx-k-${s.kind}">
        <div class="sx-tx-head"><span class="sx-ic">${ICON[s.kind]}</span><span class="sx-tx-what">${s.title}</span><span class="sx-tx-n">#${esc(t.nonce)}</span></div>
        ${subsOf(s)}${s.more || ""}${s.kind === "danger" ? `<p class="sx-warn">This can change how the Safe works. Only sign if you know why.</p>` : ""}
        <div class="sx-tx-sigs"><span class="sx-dots">${dots}</span>${n} of ${need} signed${marks.length ? ` · ${marks.join(" · ")}` : ""}</div>
        ${btns.length ? `<div class="sx-row">${btns.join(" ")}</div>` : ""}
        <details class="sx-more"><summary>Details</summary><dl class="sx-dl">
          <dt>To</dt><dd>${address(t.to, { link: CHAINS[chain].scan, size: "sm", chain })}</dd>
          ${BigInt(t.value || 0) ? `<dt>${nat(chain)}</dt><dd>${esc(E.fmt(BigInt(t.value), 18))}</dd>` : ""}
          ${t.data && t.data !== "0x" ? `<dt>Data</dt><dd><code>${esc(t.data.length > 202 ? t.data.slice(0, 202) + `… (${(t.data.length - 2) / 2} bytes)` : t.data)}</code></dd>` : ""}
          ${+t.operation === 1 ? `<dt>Kind</dt><dd>delegate call</dd>` : ""}
          <dt>Hash</dt><dd><code>${esc(String(t.safeTxHash).slice(0, 10))}…${esc(String(t.safeTxHash).slice(-8))}</code></dd></dl></details></li>`;
    }).join("");
    const ready = /data-exec/.test(items);
    box.innerHTML = `<h3>${ready ? "Ready: press Execute" : "Waiting"}${queue.length ? ` <span class="sx-count">${queue.length}</span>` : ""}</h3>
      ${items ? `<ul class="sx-txs">${items}</ul>` : `<p class="fine">Nothing waiting.</p>`}
      ${queueNote ? `<p class="fine">${esc(queueNote)}</p>` : ""}
      <p class="sx-foot"><button class="btn btn-sm" id="s-refresh"${dis()}>Refresh</button></p>`;
    $("s-refresh").onclick = () => job(() => load());
    box.querySelectorAll<HTMLButtonElement>("[data-sign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.sign!], "wedgie")));
    box.querySelectorAll<HTMLButtonElement>("[data-wsign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.wsign!], "wallet")));
    box.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach((b) => b.onclick = () => job(async () => { running = queue[+b.dataset.exec!]; paintDock(); try { await execute(running); } finally { running = null; } }));
    box.querySelectorAll<HTMLButtonElement>("[data-reject]").forEach((b) => b.onclick = () => {
      const t = queue[+b.dataset.reject!];
      // a Safe can't delete a queued one: an empty one at the same nonce runs instead, and the first can never run
      job(() => propose(safeTx(safeAddr, "0", "0x", +t.nonce), by(), `cancel #${t.nonce}`));
    });
    paintDock();
  }
  /** Stuck to the bottom of the screen while a transaction is ready to run (Austin): its Execute, then its progress. */
  let running: any = null;
  function paintDock() {
    const i = info, k = i ? queue.findIndex((t) => +t.nonce === i.nonce && (t.confirmations || []).length >= (t.confirmationsRequired ?? i.threshold)) : -1;
    const t = running || (k >= 0 ? queue[k] : null);
    const dock = $("s-dock");
    dock.hidden = !(safeAddr && t && sub === "home");
    document.body.classList.toggle("has-dock", !dock.hidden);
    document.body.classList.toggle("dock-running", !dock.hidden && !!running);   // the dock shows the progress: no second bar
    document.body.classList.toggle("in-app", Drive.inApp());
    if (dock.hidden) return;
    $("s-dock-tx").innerHTML = `<span class="safe-dock-what"><b>#${esc(t.nonce)}</b> ${said(t).title}</span>
      ${running ? "" : `<button class="btn btn-green" id="s-dock-go"${dis()}>Execute</button>`}`;
    $("s-dock-msg").hidden = !running;
    $("s-dock-go")?.addEventListener("click", () => job(async () => { running = t; paintDock(); try { await execute(t); } finally { running = null; } }));
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
        rows.push(`<li><span class="sx-ic sx-in">↓</span><span class="sx-act-what"><b>Received ${esc(E.fmt(BigInt(x.value), tok.decimals, 4))} ${esc(tok.symbol)}</b><span class="fine">from ${address(x.from, { size: "sm", chain })} · ${esc(when)}</span></span>${link ? `<a class="sx-end fine" href="${link}" target="_blank" rel="noopener">↗</a>` : ""}</li>`);
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
    if (!wedgie || !key) throw new Error("No wedgie running the Safe Signer.");
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
    try {
      const g = await ask(wedgie, async (r) => {
        if (!big) return r.request({ type: "safe_sign", tx }, 200000);
        say("Sending the transaction to the wedgie in pieces.");
        const hex = tx.data.slice(2);
        for (let o = 0; o < hex.length; o += chunk) {        // its data first, then the tx with data "@"
          const a = await r.request({ type: "safe_data", at: o / 2, hex: hex.slice(o, o + chunk) }, 20000);
          if (a.type !== "safe_data") throw new Error(a.error || "The wedgie didn't take a piece.");
        }
        say("Look at the wedgie: check what it shows, then press the green button to sign (red says no).");
        return r.request({ type: "safe_sign", tx: { ...tx, data: "@" } }, 200000);
      });
      if (g.type === "refused") throw new Error("The wedgie said no.");
      if (g.type !== "safe_sig") throw new Error(g.error || "The wedgie didn't sign.");
      if (g.safeTxHash !== E.safeTxHash(chain, safeAddr, t)) throw new Error("The wedgie signed a different hash: not sent.");
      return slots.map((a) => ({ owner: a, signature: E.safeSignature(a, g as E.WedgieSig) }));
    } finally { asking = false; }
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
   * run: a WalletConnect app waiting for a tx hash; one signature enough and next in line, it runs now.
   */
  async function propose(t: E.SafeTx, who: "wedgie" | "wallet", what: string, run = false): Promise<string | null> {
    if (who === "wallet") say(`Sign it in your wallet: ${what}.`);
    const sigs = who === "wedgie" ? await wedgieSig(t) : [await walletSig(t)];
    if (run && sigs.length >= info!.threshold && +t.nonce === info!.nonce && account) {
      const rc = await send(chain, safeAddr, E.execData(t, E.packSignatures(sigs)), say);
      await settle(+t.nonce);
      say(`Done: ${what}.`);
      return rc.transactionHash as string;
    }
    say("Putting it in the Safe's queue.");
    await share(t, sigs);
    if (sub === "settings") go(route(chain, safeAddr));     // the queue is on the Safe's page
    await load(true);
    toQueue();
    const left = Math.max(0, info!.threshold - sigs.length);
    say(left ? `In the queue with ${who === "wedgie" ? "the wedgie's" : "your"} signature: ${what}. ${plural(left, "more owner")} to sign, then Execute.`
      : `Signed: ${what}. Press Execute (a browser wallet pays the gas).`);
    return null;
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
      await load(true);
      if (info && info.nonce > n && !queue.some((x) => +x.nonce <= n)) return;
      await sleep(2000);
    }
  }

  /** Every owner's signature from Safe's API, packed; a browser wallet sends it (and pays the gas). */
  async function execute(t: any) {
    if (+t.nonce !== info!.nonce) throw new Error(`#${info!.nonce} runs first: a Safe runs its transactions in order.`);
    say("Getting it ready.", 2);
    const sigs = (t.confirmations || []).map((c: any) => ({ owner: c.owner,
      signature: c.signature || E.hex(E.cat(E.aword(c.owner), E.word(0), new Uint8Array([1]))) }));   // an approveHash on chain
    await send(chain, safeAddr, E.execData(t, E.packSignatures(sigs)), say);
    await settle(+t.nonce);
    say("Done: it ran.");
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
    $("n-btns").innerHTML = `${wedgieOwns() ? `<button class="btn btn-green" id="n-wedgie"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" id="n-wallet"${dis()}>Sign with wallet</button>` : ""}`;
    $("n-wedgie")?.addEventListener("click", () => job(() => newTx("wedgie")));
    $("n-wallet")?.addEventListener("click", () => job(() => newTx("wallet")));
    review();
  }
  function paintTok() {
    const a = picked(), list = sendList().filter((x) => x.token === null || x.price !== null || x.token === a.token);   // no spam in the picker
    $("n-tokbtn").innerHTML = `${tokenBadge(a.symbol, a.logo)}<b>${esc(a.symbol)}</b><span class="sx-caret">▾</span>`;
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
      box.innerHTML = `<p><b>${s.title}</b></p><p class="fine">${left ? `Then ${plural(left, "more owner")} must sign.` : "Then press Execute."} Your wedgie shows it before it signs.</p>`;
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
      onAsk: (a) => { asks.push(a); if (sheet === "connect") closeSheet(); paintAll(); if (!eqA(a.safe, safeAddr)) say(`${a.dapp.name} is waiting for Safe ${short(a.safe)}: open it to sign.`); },
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
        <p class="fine">In the app (Uniswap, Aave, …) pick WalletConnect. Its requests come here, and your wedgie signs them.</p>
        ${canScan() ? `<p><button class="btn btn-green sx-wide" id="wc-scan">Scan its code</button></p><div class="sx-cam" id="wc-cam" hidden></div>` : ""}
        <p class="sx-label">Or paste its link</p>
        <p class="sx-row wc-pair"><input id="wc-uri" class="sx-mono" placeholder="wc:…" spellcheck="false" autocomplete="off"> <button class="btn btn-sm" id="wc-go">Connect</button></p>
`;
      $("wc-go").onclick = () => job(async () => { const el = $("wc-uri") as HTMLInputElement; await pairWith(el.value); el.value = ""; });
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
    box.innerHTML = `<h3>Connected</h3><ul class="sx-rows">${mine.map((x) => `<li class="wc-app">${icon(x.dapp)}<span class="sx-asset-name"><b>${esc(x.dapp.name)}</b><span class="fine">${esc(x.dapp.url.replace(/^https?:\/\//, ""))}</span></span><button class="btn btn-sm sx-end" data-wcoff="${esc(x.topic)}"${dis()}>Disconnect</button></li>`).join("")}</ul>`;
    box.querySelectorAll<HTMLButtonElement>("[data-wcoff]").forEach((b) => b.onclick = () => job(() => wcm!.disconnect(b.dataset.wcoff!)));
  }

  // what connected apps ask for: on the Safe's page, above the queue
  function paintAsks() {
    const box = $("s-asks");
    const here = asks.filter((a) => eqA(a.safe, safeAddr) && a.chainId === chain);
    box.hidden = !(safeAddr && info && here.length && sub === "home");
    if (box.hidden) return;
    box.innerHTML = `<h3>Apps asking</h3>` + here.map((a, k) => {
      const x = explain({ title: "", kind: "batch", subs: a.calls.map((c) => describe({ to: c.to, value: c.value, data: c.data }, ctx())) },
        a.calls, chain, safeAddr, ctx().addr, paintAll), calls = x.subs!;
      return `<div class="sx-tx wc-ask"><div class="sx-tx-head">${icon(a.dapp)}<span class="sx-tx-what"><b>${esc(a.dapp.name)}</b> asks for ${plural(a.calls.length, "action")}${a.calls.length > 1 ? ", run as one" : ""}</span></div>
      <ol class="sx-subs">${calls.map((s) => `<li>${s.title}</li>`).join("")}</ol>${x.more || ""}
      <div class="sx-row">${wedgieOwns() ? `<button class="btn btn-sm btn-green" data-wcsign="${k}"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn btn-sm" data-wcwallet="${k}"${dis()}>Sign with wallet</button> ` : ""}<button class="btn btn-sm sx-end" data-wcno="${k}"${dis()}>Reject</button></div></div>`;
    }).join("");
    const run = (a: (typeof asks)[0], who: "wedgie" | "wallet") => job(async () => {
      try {
        if (!account) account = await wallet(chain);       // it sends the Safe tx and pays the gas
        const t = a.calls.length === 1 ? safeTx(a.calls[0].to, a.calls[0].value.toString(), a.calls[0].data)
          : { ...safeTx(E.MULTISEND_CALL_ONLY, "0", E.multiSendData(a.calls)), operation: 1 };
        const hash = await propose(t, who, `${a.dapp.name}: ${plural(a.calls.length, "call")}`, true);
        asks = asks.filter((x) => x !== a);
        if (hash) await wcm!.answerDone(a, hash);
        else await wcm!.answerError(a.topic, a.id, "It's in the Safe's queue: more owners have to sign before it runs.");
      } catch (e: any) {
        asks = asks.filter((x) => x !== a);
        await wcm!.answerError(a.topic, a.id, e?.message || "Rejected").catch(() => {});
        throw e;
      }
    });
    box.querySelectorAll<HTMLButtonElement>("[data-wcsign]").forEach((b) => b.onclick = () => run(here[+b.dataset.wcsign!], "wedgie"));
    box.querySelectorAll<HTMLButtonElement>("[data-wcwallet]").forEach((b) => b.onclick = () => run(here[+b.dataset.wcwallet!], "wallet"));
    box.querySelectorAll<HTMLButtonElement>("[data-wcno]").forEach((b) => b.onclick = () => {
      const a = here[+b.dataset.wcno!];
      asks = asks.filter((x) => x !== a);
      wcm!.answerError(a.topic, a.id, "Rejected on wedgie.dev").catch(() => {});
      paintAll();
    });
  }

  function paintAll() {
    paintWedgie(); paintWallet(); paintList(); paintCreate(); paintSafe(); paintAdd(); paintAsks(); paintQueue(); paintApps(); paintAssets(); paintActivity();
    paintOwners(); paintAddons(); paintOwner(); paintChains(); paintNew(); paintReceive(); paintWc();
  }

  W.onChange(paintWedgie);
  if (W.armed()) W.start();
  if (localStorage.getItem(WCP) && !localStorage.getItem(OFF))      // the wallet from last time, back on its own
    rainbow().then((r) => r.start(onWallet), () => {});
  else (window.requestIdleCallback ?? setTimeout)(() => rainbow().catch(() => {}));
  loadLast();
  show();
}
