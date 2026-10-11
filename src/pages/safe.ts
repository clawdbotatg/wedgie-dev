// wedgie.dev/safe: a wedgie as a signer on a Safe. The wedgie runs the Safe Signer app
// (clawdbotatg/wedgie-safe): its key lives in the secure chip (ATECC608 or Trust M), it shows each transaction and signs on A.
// Its key is a Safe owner through Safe's passkey signer contract (eth.ts signerAddress, no RPC).
// Two views, one page (history.pushState between them, so the wedgie's key is read once):
//   /safe                    the wedgie, a browser wallet (optional: pays gas, can sign as an owner), every
//                            Safe the wedgie owns on every chain (Safe's API, plus the ones made or opened in
//                            this browser), the wallet's Safes it could join, and Make a new Safe
//   /safe/<chain>:<address>  one Safe: owners, threshold, balance read from the chain (a public RPC); add the
//                            wedgie as an owner from a wallet that is one, remove an owner, change the threshold
//   - the queue (Safe's Transaction Service, api.safe.global: no key, CORS open): sign on the wedgie or the
//     wallet, execute once enough have signed (a wallet sends it, packSignatures puts them together)
//   - a new transaction (ETH, USDC or raw data), signed by the wedgie or the wallet, into the queue
// Every transaction goes through propose(): one signature, into Safe's queue, where Safe{Wallet} sees it too.
// tools/safefork.mjs + safeprobe.mjs (a Base fork) and safelive.mjs (Base Sepolia, the real API) test it.
// Nothing here remembers "the" Safe: a wedgie has many. The list comes from Safe's API (every chain), the
// wedgie itself (safe_list: the Safes it signed for or was told about, wedgie-safe safe-4+; the page tells it
// with safe_note), and this browser's own memory (per wedgie). Each is checked on chain before it's shown.
import * as W from "../serial/wedgies";
import * as Drive from "../serial/drive";
import * as E from "../safe/eth";
import { address, addressInput, addressOf, watch } from "../safe/address";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const Z = "0x" + "0".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: any) => e?.message || String(e);

// Every one has the P-256 precompile the wedgie's signer contract uses. key = Safe's short name (its API, app.safe.global).
type Chain = { name: string; key: string; rpc: string; scan: string; usdc?: string; test?: boolean };
const CHAINS: Record<number, Chain> = {
  8453: { name: "Base", key: "base", rpc: "https://mainnet.base.org", scan: "https://basescan.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  1: { name: "Ethereum", key: "eth", rpc: "https://ethereum-rpc.publicnode.com", scan: "https://etherscan.io", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  10: { name: "Optimism", key: "oeth", rpc: "https://mainnet.optimism.io", scan: "https://optimistic.etherscan.io", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  42161: { name: "Arbitrum", key: "arb1", rpc: "https://arb1.arbitrum.io/rpc", scan: "https://arbiscan.io", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  84532: { name: "Base Sepolia", key: "basesep", rpc: "https://sepolia.base.org", scan: "https://sepolia.basescan.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", test: true },
  11155111: { name: "Sepolia", key: "sep", rpc: "https://ethereum-sepolia-rpc.publicnode.com", scan: "https://sepolia.etherscan.io", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", test: true },
};
const api = (chain: number) => `https://api.safe.global/tx-service/${CHAINS[chain].key}/api/v1`;
const appLink = (chain: number, safe: string, path = "home") => `https://app.safe.global/${path}?safe=${CHAINS[chain].key}:${safe}`;
const LINE_MAX = 6000;      // the wedgie drops a USB line over 6 KB
const DATA_MAX = 8000;      // wedgie-safe safe_data pieces: up to this many bytes (what an RP2040 heap joins safely)

async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`Safe's API: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.json();
}
async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Safe's API said no: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ---- the chain, read through a public RPC (no wallet needed) ----
let rpcId = 0;
/** Public RPCs rate-limit a burst (a list of Safes reads several at once): wait and try again. */
async function rpc(chain: number, method: string, params: unknown[]) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(CHAINS[chain].rpc, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`${CHAINS[chain].name}: busy (${res.status})`), { again: true });
      const r = await res.json();
      if (r.error) throw new Error(`${CHAINS[chain].name}: ${r.error.message}`);
      return r.result as string;
    } catch (e: any) {
      if (i >= 3 || !(e.again || e instanceof TypeError)) throw e;     // TypeError: the fetch itself failed
      await sleep(600 * 2 ** i);
    }
  }
}
const view = (chain: number, to: string, data: string) => rpc(chain, "eth_call", [{ to, data }, "latest"]);
const hasCode = async (chain: number, a: string) => (await rpc(chain, "eth_getCode", [a, "latest"])).length > 2;

// ---- a browser wallet (EIP-1193): pays the gas, and can sign as an owner ----
// No wallet in the browser (a phone, the iPhone app): RainbowKit (Rainbow, MetaMask, any WalletConnect wallet),
// loaded only then (safe/rainbow.ts). wcp is the connected wallet's provider.
let wcp: any = null;
const WCP = "wedgie.safe.wc";        // set once a wallet connected this way: its session is restored on the next visit
const eth = () => (window as any).ethereum || wcp;
const rainbow = () => import("../safe/rainbow");
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
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [c.scan] }] });
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
const KEYS = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [c.key, +id]));
const route = (chain: number, a: string) => `/safe/${CHAINS[chain].key}:${a}`;

/** Owners, threshold, nonce, balances: from the chain, not Safe's API (which can lag a block or more). */
async function readSafe(c: number, a: string): Promise<Info> {
  if (!(await hasCode(c, a))) throw Object.assign(new Error(`There's no Safe at ${short(a)} on ${CHAINS[c].name}.`), { gone: true });
  const [owners, th, n, bal, usdc] = await Promise.all([view(c, a, E.selector("getOwners()")), view(c, a, E.selector("getThreshold()")),
    view(c, a, E.selector("nonce()")), rpc(c, "eth_getBalance", [a, "latest"]),
    CHAINS[c].usdc ? view(c, CHAINS[c].usdc!, E.call("balanceOf(address)", [E.aword(a)])).catch(() => null) : Promise.resolve(null)]);
  return { owners: E.addrs(owners), threshold: Number(BigInt(th)), nonce: Number(BigInt(n)), balance: BigInt(bal), usdc: usdc ? BigInt(usdc) : null };
}

export function safe(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page safe-page">
    <div class="safe-ids" id="s-ids"><div class="safe-id" id="s-me" hidden></div><div class="safe-id safe-id-wallet" id="s-wallet" hidden></div></div>
    <div class="safe-box recess" id="s-wedgie" hidden></div>
    <div class="safe-box recess" id="s-list" hidden></div>
    <div class="safe-box recess" id="s-create" hidden></div>
    <div class="safe-box recess" id="s-safe" hidden></div>
    <div class="safe-box recess" id="s-add" hidden></div>
    <div class="safe-box recess" id="s-owner" hidden></div>
    <div class="safe-box recess" id="s-new" hidden></div>
    <div class="safe-box recess" id="s-wc" hidden></div>
    <div class="safe-box recess" id="s-queue" hidden></div>
    <p class="safe-msg" id="s-msg" hidden></p>
    <div class="safe-dock" id="s-dock" hidden><div class="safe-dock-row" id="s-dock-tx"></div><div id="s-dock-msg"></div></div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  document.getElementById("connect-btn")?.before($("s-me"));   // the wedgie's address sits beside its Connected button
  let key: { x: string; y: string } | null = null, signer = "", wedgie: W.Wedgie | null = null, asking = false, noKey = false;
  // In the iPhone app there's no serial port: the wedgie is reached through its WEDGIE drive (serial/drive.ts).
  const DRIVE = { key: -1, state: "ready", running: "safe", short: "", log: "" } as unknown as W.Wedgie;
  let driveState = "";
  const ask = <T,>(w: W.Wedgie, fn: (r: Drive.Asker) => Promise<T>): Promise<T> => w === DRIVE ? Drive.withDrive(fn) : W.withRepl(w, fn);
  const present = (w: W.Wedgie) => w === DRIVE ? driveState === "here" : W.wedgies().includes(w);
  if (Drive.inApp()) {
    const look = async () => { const s = await Drive.status().catch(() => "away"); if (s !== driveState) { driveState = s; if (s !== "here") { wedgie = null; key = null; signer = ""; } paintAll(); } };
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

  // the old page's "last Safe" (it opened that one every time): moved into the list once the wedgie is read
  let oldSaved = "";
  try { oldSaved = localStorage.getItem("wedgie.safe") || ""; } catch {}
  const old = new URLSearchParams(location.search).get("safe")?.match(/^(\w+):(0x[0-9a-fA-F]{40})$/);
  if (old && KEYS[old[1]]) history.replaceState(null, "", route(KEYS[old[1]], E.checksum(old[2])));

  /** The message box. A number instead of bad: a progress bar under it, that far along (0-100). */
  // While a bar is up it keeps creeping (1-2% every half second, slower near the end), so a wait never looks
  // stuck; each new step jumps it ahead if it's behind (Austin).
  let barAt = 0, creep = 0;
  const paintBar = () => document.querySelectorAll<HTMLElement>("#s-msg .meter-fill, #s-dock-msg .meter-fill").forEach((f) => f.style.width = `${barAt}%`);
  const say = (s: string, bad: boolean | number = false) => {
    const el = $("s-msg");
    el.hidden = !s;
    const bar = typeof bad === "number";
    if (bar) barAt = Math.max(barAt, Math.max(8, Math.min(100, bad)));
    $("s-dock-msg").innerHTML = el.innerHTML = bar
      ? `${esc(s)}<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${barAt}%"></div></div></div>`
      : bad ? `<b class="bad">${esc(s)}</b>` : esc(s);
    clearInterval(creep);
    if (bar) creep = window.setInterval(() => { barAt = Math.min(97, barAt + Math.max(0.3, Math.min(2, (97 - barAt) * 0.04))); paintBar(); }, 500);
    else barAt = 0;
  };
  const fail = (e: any) => { say(msgOf(e), true); };
  const eqA = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOwner = (a: string) => !!info && !!a && info.owners.some((o) => eqA(o, a));
  const nextNonce = () => Math.max(info!.nonce, ...queue.map((t) => +t.nonce + 1));
  const threshOpts = (n: number, at: number) => Array.from({ length: n }, (_, i) => `<option${i + 1 === at ? " selected" : ""}>${i + 1}</option>`).join("");
  const label = (a: string) => eqA(a, signer) ? " <b>this wedgie</b>" : eqA(a, account) ? " <b>your wallet</b>" : "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const chainOpts = (at: number) => Object.entries(CHAINS).map(([id, c]) => `<option value="${id}"${+id === at ? " selected" : ""}>${esc(c.name)}${c.test ? " (test)" : ""}</option>`).join("");
  /** Run one thing at a time; buttons say so while it runs. */
  async function job(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true; paintAll();
    try { await fn(); } catch (e) { fail(e); } finally { busy = false; paintAll(); }
  }
  const dis = (extra = false) => (busy || asking || extra ? " disabled" : "");

  // Safes made or opened in this browser, per wedgie: Safe's API lists a new one only seconds later
  const memKey = () => `wedgie.safes.${signer.toLowerCase()}`;
  const remembered = (): string[] => { try { return JSON.parse(localStorage.getItem(memKey()) || "[]"); } catch { return []; } };
  const remember = (c: number, a: string) => {
    const k = `${CHAINS[c].key}:${E.checksum(a)}`, m = remembered();
    if (signer && !m.includes(k)) localStorage.setItem(memKey(), JSON.stringify([k, ...m]));
  };
  const forget = (c: number, a: string) => localStorage.setItem(memKey(), JSON.stringify(remembered().filter((k) => k !== `${CHAINS[c].key}:${E.checksum(a)}`)));

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
    const m = location.pathname.match(/^\/safe\/(\w+):(0x[0-9a-fA-F]{40})\/?$/);
    say("");
    if (m && KEYS[m[1]]) {
      chain = KEYS[m[1]]; safeAddr = E.checksum(m[2]); info = null; queue = [];
      $("s-new").innerHTML = ""; $("s-owner").innerHTML = "";
      paintAll();
      checkDeployed();
      load();                 // not job(): a create that lands here is still a job
    } else {
      if (location.pathname !== "/safe") history.replaceState(null, "", "/safe");
      safeAddr = ""; info = null; queue = [];
      paintAll();
      if (signer && !listing) findSafes();
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener("popstate", show);
  watch(main, CHAINS[1].rpc);   // ENS names and avatars on every address, from Ethereum
  main.addEventListener("click", (e) => {        // in-page links: no reload, the wedgie stays read
    const a = (e.target as HTMLElement).closest?.("a[data-nav]") as HTMLAnchorElement | null;
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); go(a.getAttribute("href")!);
  });

  // ---- the wedgie ----
  function paintWedgie() {
    const ws = Drive.inApp() ? (driveState === "here" ? [DRIVE] : []) : W.wedgies().filter((w) => w.state === "ready");
    const app = ws.filter((w) => w.running === "safe");
    let h = "";
    if (Drive.inApp() && !ws.length) h += driveState === "unpicked"
      ? `<p>Plug in your wedgie, then <button class="btn btn-sm btn-green" id="s-drive">Find it</button></p>`
      : driveState === "readonly" ? `<p><b>Hold the two grey buttons on your wedgie for 5 seconds.</b> A phone shows in its corner.</p>`
      : `<p class="fine">Plug in your wedgie. <button class="btn btn-sm" id="s-drive">Help</button></p>`;
    else if (!Drive.inApp() && !W.supported()) h += `<p class="fine">This browser can't talk to a wedgie over USB. Use Chrome, Edge or Brave on a computer.</p>`;
    else if (!Drive.inApp() && !W.armed()) h += `<p><a class="btn btn-green" href="/connect">Connect a wedgie</a></p>`;
    else if (!ws.length) h += `<p class="fine">Plug it in. Not showing? <a href="/connect">Connect</a> it first.</p>`;
    else if (!app.length) h += `<p class="fine">It isn't running the Safe Signer yet. <a class="btn btn-sm btn-green" href="/connect/${esc(ws[0].short)}">Install Safe Signer</a> (on its page, Software).</p>`;
    else if (!key) h += noKey ? `<p><b>Press the green button on the wedgie to make its key.</b> The chip makes it and never lets it out.</p>` : `<p class="fine">Reading its key.</p>`;
    else {
      if (safeAddr) {
        const d = deployed[chain];
        h += `<p class="fine">${d === undefined ? `Checking ${esc(CHAINS[chain].name)}.` : d ? `<span class="good">Set up on ${esc(CHAINS[chain].name)}.</span>`
          : `Not set up on ${esc(CHAINS[chain].name)} yet: it has to be before its first signature. <button class="btn btn-sm" id="s-deploy"${dis()}>Set it up</button> (a wallet pays a little gas)`}</p>`;
      }
    }
    $("s-wedgie").innerHTML = h;
    $("s-wedgie").hidden = !h;
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
        noKey = true; paintWedgie();
        await sleep(3000);
        if (present(w)) { wedgie = null; paintWedgie(); }
        return;
      }
      noKey = false;
      key = h.safe; signer = E.signerAddress(key!.x, key!.y); chunk = +h.safe_chunk || 0;
      // newer apps work out the address themselves and show it: the two must agree
      if (h.signer && !eqA(h.signer, signer)) { key = null; signer = ""; throw new Error(`The wedgie says its address is ${h.signer}, this page works out ${E.signerAddress(h.safe.x, h.safe.y)}. Not using it: tell us.`); }
      const om = oldSaved.match(/^(\w+):(0x[0-9a-fA-F]{40})$/);
      if (om && KEYS[om[1]]) remember(KEYS[om[1]], om[2]);     // checked on chain like every other before it's listed
      try { localStorage.removeItem("wedgie.safe"); } catch {}
      try {
        const l = await ask(w, (r) => r.request({ type: "safe_list" }, 5000));
        onWedgie = l.type === "safe_list" && Array.isArray(l.safes) ? l.safes : null;
      } catch { onWedgie = null; }
      paintAll();
      if (safeAddr) { checkDeployed(); if (info && isOwner(signer)) remember(chain, safeAddr); } else findSafes();
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
    try { deployed[c] = await hasCode(c, signer); } catch { deployed[c] = undefined; }
    paintWedgie();
  }

  async function deploy() {
    if (await hasCode(chain, signer)) { deployed[chain] = true; return; }
    await send(chain, E.FACTORY, E.createSignerData(key!.x, key!.y), say);
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
      <button class="btn btn-sm" id="w-off"${dis()}>Disconnect</button>`;
    $("w-go")?.addEventListener("click", () => job(async () => {
      account = await wallet(safeAddr ? chain : newChain);
      try { localStorage.removeItem(OFF); } catch {}
      if (!safeAddr) findSafes();
    }));
    $("w-off")?.addEventListener("click", async () => {
      account = ""; showWallet = false;
      try { localStorage.setItem(OFF, "1"); } catch {}
      // MetaMask and most others forget this site's permission; a wallet that can't, the page still stops using
      try { await eth().request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
      if (wcp && !(window as any).ethereum) { try { localStorage.removeItem(WCP); } catch {} wcp = null; (await rainbow()).disconnect(); }
      rows = rows.filter((r) => r.wedgie).map((r) => ({ ...r, wallet: false }));
      paintAll();
    });
  }
  const onAccounts = (a: string[]) => {
    if (localStorage.getItem(OFF)) return;
    account = a[0] ? E.checksum(a[0]) : ""; paintAll(); if (!safeAddr) findSafes();
  };
  eth()?.on?.("accountsChanged", onAccounts);

  // ---- /safe: every Safe the wedgie (and the wallet) owns, on every chain ----
  async function findSafes() {
    if (!signer && !account) return;
    listing = true; listPct = 8; paintList();
    // the bar: asking Safe's API on every chain is the first 70%, reading each Safe from its chain the rest
    let asked = 0, read = 0, nAsk = Object.keys(CHAINS).length * ((signer ? 1 : 0) + (account ? 1 : 0)), nRead = 0;
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
      for (let i = 0; ; i++) {
        try { return (await get(`${api(c)}/owners/${E.checksum(a)}/safes/`)).safes as string[]; } catch (e: any) {
          if (e.status === 404 || e.status === 400 || i >= 3) return [];
          await sleep(700 * 2 ** i);
        }
      }
    };
    await Promise.all(Object.keys(CHAINS).map(Number).map(async (c) => {
      if (signer) { for (const s of await of(c, signer)) add(c, s, "wedgie"); asked++; tick(); }
      if (account) { for (const s of await of(c, account)) add(c, s, "wallet"); asked++; tick(); }
    }));
    for (const k of signer ? remembered() : []) { const [ck, a] = k.split(":"); if (KEYS[ck]) add(KEYS[ck], a, "wedgie"); }
    for (const k of onWedgie || []) { const [c, a] = k.split(":"); if (CHAINS[+c] && E.isAddress(a)) add(+c, a, "wedgie"); }
    const list = [...found.values()];
    nRead = list.length;
    for (let i = 0; i < list.length; i += 4)      // a few at a time: public RPCs rate-limit a burst
      await Promise.all(list.slice(i, i + 4).map(async (r) => { try { r.info = await readSafe(r.chain, r.addr); } catch (e: any) { r.info = null; r.err = msgOf(e); r.gone = !!e?.gone; } read++; tick(); }));
    for (const r of list) {          // the chain is the truth: who really is an owner now
      if (!r.info) continue;
      r.wedgie = !!signer && r.info.owners.some((o) => eqA(o, signer));
      if (r.wedgie) remember(r.chain, r.addr);   // seen once, listed in this browser even when Safe's API isn't answering
      r.wallet = !!account && r.info.owners.some((o) => eqA(o, account));
    }
    // a Safe the chain couldn't be read for stays listed (as its sources said): never hidden by a busy RPC
    rows = list.filter((r) => (!r.info && !r.gone) || r.wedgie || r.wallet)
      .sort((a, b) => +b.wedgie - +a.wedgie || +!!CHAINS[a.chain].test - +!!CHAINS[b.chain].test || a.chain - b.chain);
    listing = false;
    paintList();
  }

  function paintList() {
    const box = $("s-list");
    box.hidden = !!safeAddr || !key;
    if (box.hidden) return;
    const row = (r: Row) => {
      const i = r.info;
      return `<li><a class="safe-row${r.wedgie ? " btn btn-green" : ""}" data-nav href="${route(r.chain, r.addr)}">${address(r.addr, { chain: r.chain })}
        <span>${esc(CHAINS[r.chain].name)}</span><span class="fine">${i ? `${i.threshold} of ${plural(i.owners.length, "owner")} · ${esc(E.fmt(i.balance, 18, 4))} ETH${i.usdc ? ` · ${esc(E.fmt(i.usdc, 6, 2))} USDC` : ""}` : `couldn't read it just now (${esc(r.err || "")}): open it, or Refresh`}</span>
        ${r.wedgie ? `<span class="safe-open">Open →</span>` : `<span class="fine">your wallet's: add your wedgie</span>`}</a></li>`;
    };
    const mine = rows.filter((r) => r.wedgie), theirs = rows.filter((r) => !r.wedgie);
    let h = `<h2>Your wedgie's Safes</h2>`;
    h += mine.length ? `<ul class="safe-list safe-rows">${mine.map(row).join("")}</ul>`
      : listing ? `<div class="meter"><div class="meter-track"><div class="meter-fill" id="l-fill" style="width:${listPct}%"></div></div><p class="fine">Looking on every chain.</p></div>` : `<p class="fine">${key ? "None yet. Make one below, or add your wedgie to a Safe you already have." : "Plug in your wedgie to see its Safes."}</p>`;
    if (theirs.length) h += showWallet
      ? `<p class="fine"><button class="btn btn-sm" id="l-wallet">Hide your wallet's Safes</button> Open one to add your wedgie as an owner.</p><ul class="safe-list safe-rows">${theirs.map(row).join("")}</ul>`
      : `<p class="fine"><button class="btn btn-sm" id="l-wallet">Your wallet's Safes (${theirs.length})</button> to add your wedgie to one</p>`;
    h += `<p class="fine"><button class="btn btn-sm" id="l-refresh"${dis(listing)}>Refresh</button>
      · Open another: ${addressInput("l-addr", "0x… or ENS name of a Safe")} <select id="l-chain">${chainOpts(newChain)}</select> <button class="btn btn-sm" id="l-open">Open</button></p>`;
    box.innerHTML = h;
    $("l-refresh").onclick = () => findSafes();
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
    box.hidden = !!safeAddr || !key;
    if (box.hidden) return;
    if (document.getElementById("c-go")) { ($("c-go") as HTMLButtonElement).disabled = busy; return; }   // keep what's typed
    box.innerHTML = `<h2>Make a new Safe</h2>
      <p class="fine">Owners: your wedgie, and any wallet or other wedgie you add.</p>
      <div class="safe-owners" id="c-owners"><div class="safe-owner">${address(signer)} <span class="fine">this wedgie</span></div></div>
      <p><button class="btn btn-sm" id="c-add" aria-label="Add an owner">＋ Owner</button> <button class="btn btn-sm" id="c-me">Add my wallet</button></p>
      <p><select id="c-th"></select> <span id="c-of"></span> must sign, on <select id="c-chain">${chainOpts(newChain)}</select></p>
      <p><button class="btn btn-green" id="c-go">Make it</button></p>
      <p class="fine">Your browser wallet sends one transaction: it sets up your wedgie on that chain and makes the Safe (Safe 1.4.1).</p>`;
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
      $("c-of").textContent = `of ${plural(n, "owner")}`;
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
    const r = await send(c, E.MULTICALL3, E.newSafeData(key!.x, key!.y, owners, th, BigInt(Date.now())), say);
    const log = (r.logs || []).find((l: any) => eqA(l.address, E.SAFE_FACTORY) && l.topics[0] === E.PROXY_CREATION);
    if (!log) throw new Error("It ran, but no new Safe showed up in it: " + r.transactionHash);
    deployed[c] = true;
    const a = E.checksum("0x" + log.topics[1].slice(26));
    remember(c, a);
    await tellWedgie(c, a);
    $("s-create").innerHTML = "";
    rows = [];
    go(route(c, a));
    say(`Made your Safe on ${CHAINS[c].name}. Send it some ETH or tokens, then use New transaction below.`);
  }

  // ---- /safe/<chain>:<address>: one Safe ----
  function paintSafe() {
    const box = $("s-safe");
    box.hidden = !safeAddr;
    if (box.hidden) return;
    const c = CHAINS[chain];
    let h = `<p class="fine"><a data-nav href="/safe">← All your Safes</a></p>
      <h2>Safe on ${esc(c.name)}</h2>
      <p>${address(safeAddr, { link: c.scan, size: "lg", long: true, chain })}</p>`;
    if (info) {
      const i = info, canChange = isOwner(signer) || isOwner(account);
      h += `<p>${esc(E.fmt(i.balance, 18))} ETH${i.usdc !== null ? ` · ${esc(E.fmt(i.usdc, 6, 2))} USDC` : ""} ·
          <a href="${appLink(chain, safeAddr)}" target="_blank" rel="noopener">Safe{Wallet}</a> · <a href="${c.scan}/address/${safeAddr}" target="_blank" rel="noopener">explorer</a></p>
        <p>${i.threshold} of ${plural(i.owners.length, "owner")} must sign${canChange && i.owners.length > 1
          ? ` · <select id="o-th"${dis()}>${threshOpts(i.owners.length, i.threshold)}</select> <button class="btn btn-sm" id="o-th-go"${dis()}>Change</button>` : ""}</p>
        <ul class="safe-list">${i.owners.map((o) => `<li>${address(o, { link: c.scan, chain })}${label(o)}${canChange && i.owners.length > 1 ? ` <button class="btn btn-sm" data-rm="${esc(o)}"${dis()}>Remove</button>` : ""}</li>`).join("")}</ul>
        ${signer ? isOwner(signer) ? `<p class="good">Your wedgie is an owner.</p>` : `<p class="bad">Your wedgie isn't an owner of this Safe.</p>` : ""}`;
    }
    box.innerHTML = h;
    box.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) => b.onclick = () => removeOwner(b.dataset.rm!));
    $("o-th-go")?.addEventListener("click", () => changeThreshold(+($("o-th") as HTMLSelectElement).value));
  }

  /** The Safe from the chain (the truth), its queue from Safe's API. */
  async function load(quiet = false) {
    if (!quiet) say("Opening the Safe.");
    const c = chain, a = safeAddr;
    try {
      const i = await readSafe(c, a);
      let qq: any[] = [];
      try {
        qq = (await get(`${api(c)}/safes/${a}/multisig-transactions/?executed=false&nonce__gte=${i.nonce}&ordering=nonce&limit=20`)).results || [];
      } catch (e: any) { if (e.status !== 404) throw e; }     // a Safe made seconds ago: Safe's API hasn't seen it yet
      if (c !== chain || a !== safeAddr) return;
      info = i; queue = qq;
      if (signer) { if (isOwner(signer)) { remember(c, a); tellWedgie(c, a); } else forget(c, a); }
      if (!quiet) say("");
    } catch (e) { if (c === chain && a === safeAddr) { info = null; queue = []; if (!quiet) fail(e); } }
    paintAll();
  }

  // ---- add the wedgie as an owner, from a browser wallet that already is one ----
  function paintAdd() {
    const box = $("s-add");
    box.hidden = !(safeAddr && info && signer && !isOwner(signer));
    if (box.hidden) return;
    const i = info!, n = i.owners.length;
    box.innerHTML = `<h2>Add your wedgie as an owner</h2>
      <p class="fine">An owner of this Safe does it from their browser wallet. ${i.threshold > 1
        ? `This Safe needs ${i.threshold} signatures, so it goes to the queue below for the other owners to sign (here or in <a href="${appLink(chain, safeAddr, "transactions/queue")}" target="_blank" rel="noopener">Safe{Wallet}</a>), then anyone executes it.`
        : "One signature is enough here, so it runs right away."}</p>
      <p>Then <select id="a-th"${dis()}>${threshOpts(n + 1, i.threshold)}</select> of ${n + 1} owners must sign. <button class="btn btn-green" id="a-go"${dis()}>Add it with my wallet</button></p>`;
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
  const by = (): "wedgie" | "wallet" => (isOwner(signer) ? "wedgie" : "wallet");
  function removeOwner(o: string) {
    const i = info!, at = i.owners.findIndex((x) => eqA(x, o));
    const th = Math.min(i.threshold, i.owners.length - 1);
    if (eqA(o, signer) && !confirm("Remove this wedgie as an owner? It won't be able to sign for this Safe.")) return;
    job(() => propose(safeTx(safeAddr, "0", E.removeOwnerData(at ? i.owners[at - 1] : E.SENTINEL, o, th)), by(), `remove owner ${short(o)}, then ${th} must sign`));
  }
  // ---- add any owner (a wallet, another wedgie): its own box, built once per Safe so typing survives repaints ----
  function paintOwner() {
    const box = $("s-owner");
    box.hidden = !(safeAddr && info && (isOwner(signer) || isOwner(account)));
    if (box.hidden) return;
    const i = info!;
    if (!document.getElementById("ow-addr")) {
      box.innerHTML = `<h2>Add an owner</h2>
        <p class="fine">Any wallet, or another wedgie's Safe owner address (its screen shows it).</p>
        <p>${addressInput("ow-addr", "0x… or ENS name of the new owner")}</p>
        <p>Then <select id="ow-th"></select> <span id="ow-of"></span> must sign.</p>
        <p id="ow-btns"></p>`;
    }
    const th = $("ow-th") as HTMLSelectElement, keep = +th.value || i.threshold;
    th.innerHTML = threshOpts(i.owners.length + 1, Math.min(keep, i.owners.length + 1));
    $("ow-of").textContent = `of ${i.owners.length + 1} owners`;
    $("ow-btns").innerHTML = `${isOwner(signer) ? `<button class="btn btn-green" id="ow-wedgie"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" id="ow-wallet"${dis()}>Sign with wallet</button>` : ""}`;
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

  // ---- the queue ----
  function paintQueue() {
    const box = $("s-queue");
    box.hidden = !(safeAddr && info);
    if (box.hidden) return;
    const i = info!;
    const signed = (t: any, a: string) => !!a && (t.confirmations || []).some((c: any) => eqA(c.owner, a));
    const items = queue.map((t, k) => {
      const n = (t.confirmations || []).length, need = t.confirmationsRequired ?? i.threshold, first = +t.nonce === i.nonce;
      const what = t.dataDecoded?.method || (t.data && t.data !== "0x" ? "contract call" : `send ${E.fmt(BigInt(t.value), 18)} ETH`);
      const btns: string[] = [];
      if (isOwner(signer)) btns.push(signed(t, signer) ? `<span class="good">wedgie signed</span>` : `<button class="btn btn-sm btn-green" data-sign="${k}"${dis(!key)}>Sign with wedgie</button>`);
      if (account && isOwner(account)) btns.push(signed(t, account) ? `<span class="good">wallet signed</span>` : n < need ? `<button class="btn btn-sm" data-wsign="${k}"${dis()}>Sign with wallet</button>` : "");
      if (n >= need) btns.push(first ? `<button class="btn btn-sm btn-green" data-exec="${k}"${dis()}>Execute</button>` : `<span class="fine">runs after #${i.nonce}</span>`);
      return `<li><b>#${esc(t.nonce)}</b> ${esc(what)} → ${eqA(t.to, safeAddr) ? "this Safe" : address(t.to, { link: CHAINS[chain].scan, size: "sm", chain })} <span class="fine">${n}/${need} signed</span> ${btns.join(" ")}</li>`;
    }).join("");
    const ready = /data-exec/.test(items);
    box.innerHTML = `<h2>${ready ? "Ready: press Execute" : "Waiting to sign"}</h2>${items ? `<ul class="safe-list">${items}</ul>` : `<p class="fine">Nothing waiting.</p>`}
      <p><button class="btn btn-sm" id="s-refresh"${dis()}>Refresh</button></p>`;
    $("s-refresh").onclick = () => job(() => load());
    box.querySelectorAll<HTMLButtonElement>("[data-sign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.sign!], "wedgie")));
    box.querySelectorAll<HTMLButtonElement>("[data-wsign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.wsign!], "wallet")));
    box.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach((b) => b.onclick = () => job(async () => { running = queue[+b.dataset.exec!]; paintDock(); try { await execute(running); } finally { running = null; } }));
    paintDock();
  }
  /** Stuck to the bottom of the screen while a transaction is ready to run (Austin): its Execute, then its progress. */
  let running: any = null;
  function paintDock() {
    const i = info, k = i ? queue.findIndex((t) => +t.nonce === i.nonce && (t.confirmations || []).length >= (t.confirmationsRequired ?? i.threshold)) : -1;
    const t = running || (k >= 0 ? queue[k] : null);
    const dock = $("s-dock");
    dock.hidden = !(safeAddr && t);
    document.body.classList.toggle("has-dock", !dock.hidden);
    document.body.classList.toggle("dock-running", !dock.hidden && !!running);   // the dock shows the progress: no second bar
    document.body.classList.toggle("in-app", Drive.inApp());
    if (dock.hidden) return;
    const what = t.dataDecoded?.method || (t.data && t.data !== "0x" ? "contract call" : `send ${E.fmt(BigInt(t.value), 18)} ETH`);
    $("s-dock-tx").innerHTML = `<span class="safe-dock-what"><b>#${esc(t.nonce)}</b> ${esc(what)} → ${eqA(t.to, safeAddr) ? "this Safe" : address(t.to, { size: "sm", chain })}</span>
      ${running ? "" : `<button class="btn btn-green" id="s-dock-go"${dis()}>Execute</button>`}`;
    $("s-dock-msg").hidden = !running;
    $("s-dock-go")?.addEventListener("click", () => job(async () => { running = t; paintDock(); try { await execute(t); } finally { running = null; } }));
  }
  /** After a sign: the queue is at the bottom, so take the page there (once it's repainted). */
  const toQueue = () => requestAnimationFrame(() => $("s-queue").scrollIntoView({ behavior: "smooth", block: "center" }));
  const safeTx = (to: string, value: string, data: string, nonce = nextNonce()): E.SafeTx =>
    ({ to: E.checksum(to), value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce });

  /** The wedgie signs t; the page checks it signed the same hash, and that its signer contract can be checked on chain. */
  async function wedgieSig(t: E.SafeTx) {
    if (!wedgie || !key) throw new Error("No wedgie running the Safe Signer.");
    if (!(await hasCode(chain, signer))) { deployed[chain] = false; throw new Error(`The wedgie's signer contract isn't on ${CHAINS[chain].name} yet: Deploy it (above) first. Safe checks its signatures through it.`); }
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
      return { owner: signer, signature: E.safeSignature(signer, g as E.WedgieSig) };
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
    const sig = who === "wedgie" ? await wedgieSig(t) : await walletSig(t);
    if (run && info!.threshold === 1 && +t.nonce === info!.nonce && account) {
      const rc = await send(chain, safeAddr, E.execData(t, E.packSignatures([sig])), say);
      await settle(+t.nonce);
      say(`Done: ${what}.`);
      return rc.transactionHash as string;
    }
    say("Putting it in the Safe's queue.");
    await post(`${api(chain)}/safes/${safeAddr}/multisig-transactions/`, { ...t, contractTransactionHash: E.safeTxHash(chain, safeAddr, t),
      sender: sig.owner, signature: sig.signature, origin: "wedgie.dev/safe" });
    await load(true);
    toQueue();
    const left = info!.threshold - 1;
    say(left ? `In the queue with ${who === "wedgie" ? "the wedgie's" : "your"} signature: ${what}. ${plural(left, "more owner")} to sign, then Execute.`
      : `Signed: ${what}. Press Execute (a browser wallet pays the gas).`);
    return null;
  }

  async function signQueued(t: any, who: "wedgie" | "wallet") {
    const sig = who === "wedgie" ? await wedgieSig(t) : await walletSig(t);
    if (E.safeTxHash(chain, safeAddr, t) !== t.safeTxHash) throw new Error("Safe's API has a different hash for this one: not sent.");
    say("Sending the signature to Safe.");
    await post(`${api(chain)}/multisig-transactions/${t.safeTxHash}/confirmations/`, { signature: sig.signature });
    await load(true);
    toQueue();
    const u = queue.find((x) => x.safeTxHash === t.safeTxHash);
    say(u && (u.confirmations || []).length >= (u.confirmationsRequired ?? info!.threshold) ? "Signed. That's enough: press Execute." : "Signed. It shows in Safe{Wallet} too.");
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

  // ---- a new transaction ----
  function paintNew() {
    const box = $("s-new");
    const me = isOwner(signer) || isOwner(account);
    box.hidden = !(safeAddr && info && me);
    if (box.hidden) return;
    const c = CHAINS[chain];
    if (!document.getElementById("n-to")) {      // built once per Safe: keep what's typed across repaints
      box.innerHTML = `<h2>New transaction</h2>
        <p>${addressInput("n-to", "to: 0x… or ENS name")}</p>
        <p><input id="n-amt" placeholder="amount" size="12" inputmode="decimal"> <select id="n-tok"><option value="eth">ETH</option>${c.usdc ? `<option value="usdc">USDC</option>` : ""}</select> <button class="btn btn-sm" id="n-max" type="button">Max</button></p>
        <details class="fine"><summary>Contract call data (optional)</summary><p><input id="n-data" placeholder="data 0x…" size="44" spellcheck="false"></p></details>
        <p id="n-btns"></p>`;
      // all of it: the Safe pays no gas itself (the wallet that executes does), so the whole balance can go
      $("n-max").onclick = () => {
        const i = info!, usdc = ($("n-tok") as HTMLSelectElement).value === "usdc";
        ($("n-amt") as HTMLInputElement).value = usdc ? E.fmt(i.usdc ?? 0n, 6, 6) : E.fmt(i.balance, 18, 18);
      };
    }
    $("n-btns").innerHTML = `${isOwner(signer) ? `<button class="btn btn-green" id="n-wedgie"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" id="n-wallet"${dis()}>Sign with wallet</button>` : ""}`;
    $("n-wedgie")?.addEventListener("click", () => job(() => newTx("wedgie")));
    $("n-wallet")?.addEventListener("click", () => job(() => newTx("wallet")));
  }

  async function newTx(who: "wedgie" | "wallet") {
    const to = addressOf($("n-to") as HTMLInputElement) || ($("n-to") as HTMLInputElement).value.trim(), amt = ($("n-amt") as HTMLInputElement).value.trim() || "0";
    const tok = ($("n-tok") as HTMLSelectElement).value, data = ($("n-data") as HTMLInputElement).value.trim() || "0x";
    if (!E.isAddress(to)) throw new Error("The to address isn't an address.");
    E.bytes(data);
    let t: E.SafeTx, what: string;
    if (tok === "usdc") {
      if (data !== "0x") throw new Error("Data goes with ETH, not USDC.");
      const n = E.units(amt, 6);
      if (info!.usdc !== null && n > info!.usdc) throw new Error(`The Safe has ${E.fmt(info!.usdc, 6, 2)} USDC.`);
      t = safeTx(CHAINS[chain].usdc!, "0", E.transferData(E.checksum(to), n)); what = `send ${amt} USDC to ${short(to)}`;
    } else {
      const v = E.units(amt, 18);
      if (v > info!.balance) throw new Error(`The Safe has ${E.fmt(info!.balance, 18)} ETH.`);
      t = safeTx(to, v.toString(), data); what = data === "0x" ? `send ${amt} ETH to ${short(to)}` : `call ${short(to)}`;
    }
    await propose(t, who, what);
    ($("n-to") as HTMLInputElement).value = ""; $("n-to").dispatchEvent(new Event("input")); ($("n-amt") as HTMLInputElement).value = ""; ($("n-data") as HTMLInputElement).value = "";
  }

  // ---- WalletConnect: this Safe in an app (Uniswap, …); its batches signed on the wedgie (src/safe/walletconnect.ts) ----
  let wcm: typeof import("../safe/walletconnect") | null = null, wcSessions: import("../safe/walletconnect").Session[] = [];
  let asks: import("../safe/walletconnect").Ask[] = [];
  const WC_ON = "wedgie.wc";       // set once an app was connected here: WalletKit starts with the page from then on
  async function wcStart() {
    if (wcm) return wcm;
    const m = await import("../safe/walletconnect");
    await m.start({
      onAsk: (a) => { asks.push(a); paintAll(); if (!eqA(a.safe, safeAddr)) say(`${a.dapp.name} is waiting for Safe ${short(a.safe)}: open it to sign.`); },
      onChange: () => { m.sessions().then((l) => { wcSessions = l; paintWc(); }); },
      onError: (msg) => say(msg, true),
      receipt: (c, h) => rpc(c, "eth_getTransactionReceipt", [h]).then((x: any) => x),
    });
    wcm = m;
    return m;
  }
  try { if (localStorage.getItem(WC_ON)) wcStart().catch(() => {}); } catch {}

  // an app's logo, fetched as a blob: the site's COEP (require-corp) blocks other sites' <img src>
  const icons = new Map<string, string | null>();
  const icon = (u?: string) => {
    if (!u) return "";
    if (!icons.has(u)) {
      icons.set(u, null);
      fetch(u).then((r) => (r.ok && (r.headers.get("content-type") || "").startsWith("image/") ? r.blob() : null))
        .then((b) => { if (b) { icons.set(u, URL.createObjectURL(b)); paintWc(); } }, () => {});
    }
    const b = icons.get(u);
    return b ? `<img class="wc-icon" src="${b}" alt="">` : "";
  };
  function paintWc() {
    const box = $("s-wc");
    box.hidden = !(safeAddr && info && (isOwner(signer) || isOwner(account)));
    if (box.hidden) return;
    if (!document.getElementById("wc-uri")) {     // built once per Safe: keep a pasted link across repaints
      box.innerHTML = `<h2>Use this Safe in an app</h2>
        <p class="fine">In the app (Uniswap, Aave, …) pick WalletConnect, copy its link, and paste it here. The app's
        transactions come here; the wedgie signs them, approve + swap as one.</p>
        <p class="wc-pair"><input id="wc-uri" placeholder="wc:…" spellcheck="false" autocomplete="off"> <button class="btn btn-sm" id="wc-go">Connect</button></p>
        <div id="wc-list"></div><div id="wc-asks"></div>`;
      $("wc-go").onclick = () => job(async () => {
        const el = $("wc-uri") as HTMLInputElement, m = await wcStart();
        say("Connecting to the app.");
        await m.pair(el.value, safeAddr, chain);
        el.value = "";
        try { localStorage.setItem(WC_ON, "1"); } catch {}
        say("Connected. Use the app: what it asks for shows up here.");
      });
    }
    const mine = wcSessions.filter((x) => eqA(x.safe, safeAddr) && x.chainId === chain);
    $("wc-list").innerHTML = mine.length ? `<ul class="safe-list">${mine.map((x) => `<li>${icon(x.dapp.icon)}<b>${esc(x.dapp.name)}</b> <span class="fine">${esc(x.dapp.url.replace(/^https?:\/\//, ""))}</span> <button class="btn btn-sm" data-wcoff="${esc(x.topic)}"${dis()}>Disconnect</button></li>`).join("")}</ul>` : "";
    $("wc-list").querySelectorAll<HTMLButtonElement>("[data-wcoff]").forEach((b) => b.onclick = () => job(() => wcm!.disconnect(b.dataset.wcoff!)));
    const here = asks.filter((a) => eqA(a.safe, safeAddr) && a.chainId === chain);
    $("wc-asks").innerHTML = here.map((a, k) => `<div class="wc-ask"><p><b>${esc(a.dapp.name)}</b> asks for ${plural(a.calls.length, "call")}${a.calls.length > 1 ? ", run as one" : ""}:</p>
      <ol>${a.calls.map((c) => `<li>${address(c.to, { link: CHAINS[chain].scan, size: "sm", chain })}${c.value ? ` + ${esc(E.fmt(c.value, 18))} ETH` : ""} <span class="fine">${(c.data.length - 2) / 2} bytes of data</span></li>`).join("")}</ol>
      <p>${isOwner(signer) ? `<button class="btn btn-green" data-wcsign="${k}"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" data-wcwallet="${k}"${dis()}>Sign with wallet</button> ` : ""}<button class="btn btn-sm" data-wcno="${k}"${dis()}>Reject</button></p></div>`).join("");
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

  function paintAll() { paintWedgie(); paintWallet(); paintList(); paintCreate(); paintSafe(); paintAdd(); paintQueue(); paintOwner(); paintNew(); paintWc(); }

  W.onChange(paintWedgie);
  if (W.armed()) W.start();
  if (!(window as any).ethereum && localStorage.getItem(WCP) && !localStorage.getItem(OFF))
    rainbow().then((r) => r.start(async (p) => {
      wcp = p;
      if (!p) return onAccounts([]);
      p.on?.("accountsChanged", onAccounts);
      onAccounts(await p.request({ method: "eth_accounts" }));
    }), () => {});
  else if (!localStorage.getItem(OFF))
    eth()?.request({ method: "eth_accounts" }).then((a: string[]) => { if (a?.[0]) { account = E.checksum(a[0]); paintAll(); if (!safeAddr) findSafes(); } }, () => {});
  show();
}
