// wedgie.dev/safe: a wedgie as a signer on a Safe. The wedgie runs the Safe signer app
// (clawdbotatg/wedgie-safe): its key lives in the Trust M chip, it shows each transaction and signs on A.
// Its key is a Safe owner through Safe's passkey signer contract (eth.ts signerAddress, no RPC).
// This page:
//   - the wedgie: its signer address, deployed or not on the chosen chain (deploy it with a wallet)
//   - a browser wallet (optional): pays gas; can sign as an owner too
//   - the Safe: the wedgie's own Safes and the wallet's (Safe's API), or any address; owners, threshold,
//     balance read from the chain (a public RPC). Add the wedgie as an owner from a wallet that is one,
//     make a new Safe with it, remove an owner, change the threshold.
//   - the queue (Safe's Transaction Service, api.safe.global: no key, CORS open): sign on the wedgie or the
//     wallet, execute once enough have signed (a wallet sends it, packSignatures puts them together)
//   - a new transaction (ETH, USDC or raw data), signed by the wedgie or the wallet, into the queue
// Every transaction goes through propose(): one signature, into Safe's queue, where Safe{Wallet} sees it too.
// tools/safefork.mjs + safeprobe.mjs (a Base fork) and safelive.mjs (Base Sepolia, the real API) test it.
import * as W from "../serial/wedgies";
import * as E from "../safe/eth";

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
async function rpc(chain: number, method: string, params: unknown[]) {
  const r = await (await fetch(CHAINS[chain].rpc, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) })).json();
  if (r.error) throw new Error(`${CHAINS[chain].name}: ${r.error.message}`);
  return r.result as string;
}
const view = (chain: number, to: string, data: string) => rpc(chain, "eth_call", [{ to, data }, "latest"]);
const hasCode = async (chain: number, a: string) => (await rpc(chain, "eth_getCode", [a, "latest"])).length > 2;

// ---- a browser wallet (EIP-1193): pays the gas, and can sign as an owner ----
const eth = () => (window as any).ethereum;
async function wallet(chain: number): Promise<string> {
  if (!eth()) throw new Error("No browser wallet in this browser (MetaMask, Rabby, Coinbase Wallet...).");
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
async function send(chain: number, to: string, data: string, say: (s: string) => void, value = "0x0"): Promise<any> {
  const from = await wallet(chain);
  say("Confirm it in your wallet.");
  const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from, to, data, value }] });
  say("Sent. Waiting for it to land in a block.");
  for (let i = 0; i < 160; i++) {
    const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) { if (r.status !== "0x1") throw new Error(`It failed on chain: ${CHAINS[chain].scan}/tx/${hash}`); return r; }
    await sleep(1500);
  }
  throw new Error("Still not in a block: " + hash);
}

type Info = { owners: string[]; threshold: number; nonce: number; balance: bigint; usdc: bigint | null };

export function safe(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page safe-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Safe signer</h1>
    <p class="fine">Your wedgie signs for a <a href="https://app.safe.global" target="_blank" rel="noopener">Safe</a> multisig. Its key never leaves its chip; it shows each transaction and signs only when you press A on it.</p>
    <div class="safe-box recess" id="s-wedgie"></div>
    <div class="safe-box recess" id="s-wallet"></div>
    <div class="safe-box recess" id="s-safe"></div>
    <div class="safe-box recess" id="s-add" hidden></div>
    <div class="safe-box recess" id="s-create" hidden></div>
    <div class="safe-box recess" id="s-queue" hidden></div>
    <div class="safe-box recess" id="s-new" hidden></div>
    <p class="safe-msg" id="s-msg" hidden></p>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const q = new URLSearchParams(location.search);
  let key: { x: string; y: string } | null = null, signer = "", wedgie: W.Wedgie | null = null, asking = false, noKey = false;
  let account = "", chain = 8453, safeAddr = "", info: Info | null = null, queue: any[] = [], creating = false, busy = false;
  const deployed: Record<number, boolean | undefined> = {};
  let mineSafes: { chain: number; wedgie: string[]; wallet: string[] } = { chain: 0, wedgie: [], wallet: [] };
  const saved = q.get("safe") || localStorage.getItem("wedgie.safe") || "";
  const m = saved.match(/^(?:(\w+):)?(0x[0-9a-fA-F]{40})$/);
  if (m) { safeAddr = E.checksum(m[2]); chain = +(Object.entries(CHAINS).find(([, c]) => c.key === m[1])?.[0] || 8453); }
  else if (q.get("chain") && CHAINS[+q.get("chain")!]) chain = +q.get("chain")!;
  const say = (s: string, bad = false) => {
    const el = $("s-msg");
    el.hidden = !s;
    el.innerHTML = bad ? `<b class="bad">${esc(s)}</b>` : esc(s);
  };
  const fail = (e: any) => { say(msgOf(e), true); };
  const eqA = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOwner = (a: string) => !!info && !!a && info.owners.some((o) => eqA(o, a));
  const nextNonce = () => Math.max(info!.nonce, ...queue.map((t) => +t.nonce + 1));
  const threshOpts = (n: number, at: number) => Array.from({ length: n }, (_, i) => `<option${i + 1 === at ? " selected" : ""}>${i + 1}</option>`).join("");
  const label = (a: string) => eqA(a, signer) ? " <b>this wedgie</b>" : eqA(a, account) ? " <b>your wallet</b>" : "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** Run one thing at a time; buttons say so while it runs. */
  async function job(fn: () => Promise<void>) {
    if (busy) return;
    busy = true; paintAll();
    try { await fn(); } catch (e) { fail(e); } finally { busy = false; paintAll(); }
  }
  const dis = (extra = false) => (busy || asking || extra ? " disabled" : "");

  // ---- 1. the wedgie ----
  function paintWedgie() {
    const ws = W.wedgies().filter((w) => w.state === "ready");
    const app = ws.filter((w) => w.running === "safe");
    let h = `<h2>1. Your wedgie</h2>`;
    if (!W.supported()) h += `<p class="fine">This browser can't talk to a wedgie over USB. Use Chrome, Edge or Brave on a computer.</p>`;
    else if (!W.armed()) h += `<p><a class="btn btn-green" href="/connect">Connect a wedgie</a></p>`;
    else if (!ws.length) h += `<p class="fine">Plug it in. Not showing? <a href="/connect">Connect</a> it first.</p>`;
    else if (!app.length) h += `<p class="fine">It isn't running the Safe signer yet. <a class="btn btn-sm btn-green" href="/connect/${esc(ws[0].short)}">Install Safe signer</a> (on its page, Software).</p>`;
    else if (!key) h += noKey ? `<p><b>Press A on the wedgie to make its key.</b> The chip makes it and never lets it out.</p>` : `<p class="fine">Reading its key.</p>`;
    else {
      const d = deployed[chain];
      h += `<p class="fine">On chain your wedgie is this signer contract, the same address on every chain. It's what you add as a Safe owner.</p>
      <p><code class="safe-addr">${esc(signer)}</code> <button class="btn btn-sm" id="s-copy">Copy</button></p>
      <p class="fine">${d === undefined ? `Checking ${esc(CHAINS[chain].name)}.` : d ? `<span class="good">Deployed on ${esc(CHAINS[chain].name)}.</span>`
        : `Not on ${esc(CHAINS[chain].name)} yet: it has to be, before its first signature. <button class="btn btn-sm" id="s-deploy"${dis()}>Deploy it</button> (any wallet, a little gas; making a Safe or adding it as an owner here does it for you)`}</p>`;
    }
    $("s-wedgie").innerHTML = h;
    $("s-copy")?.addEventListener("click", () => { navigator.clipboard.writeText(signer); say("Copied."); });
    $("s-deploy")?.addEventListener("click", () => job(deploy));
    if (app.length && !key && wedgie !== app[0]) readKey(app[0]);
  }

  async function readKey(w: W.Wedgie) {
    wedgie = w;
    try {
      const h = await W.withRepl(w, (r) => r.request({ type: "hello" }, 5000));
      if (!h.safe) {                  // no key yet: the wedgie's own A makes it; look again in a moment
        noKey = true; paintWedgie();
        await sleep(3000);
        if (W.wedgies().includes(w)) { wedgie = null; paintWedgie(); }
        return;
      }
      noKey = false;
      key = h.safe; signer = E.signerAddress(key!.x, key!.y);
      paintAll();
      checkDeployed();
      findSafes();
    } catch (e) { fail(e); wedgie = null; }
  }

  async function checkDeployed() {
    if (!signer) return;
    const c = chain;
    try { deployed[c] = await hasCode(c, signer); } catch { deployed[c] = undefined; }
    paintWedgie();
  }

  async function deploy() {
    if (await hasCode(chain, signer)) { deployed[chain] = true; return; }
    await send(chain, E.FACTORY, E.createSignerData(key!.x, key!.y), say);
    deployed[chain] = true;
    say(`The wedgie's signer is on ${CHAINS[chain].name}.`);
  }

  // ---- 2. the wallet ----
  function paintWallet() {
    let h = `<h2>2. Your browser wallet <span class="fine">(optional)</span></h2>`;
    if (!eth()) h += `<p class="fine">None in this browser. You need one to pay gas: to make a Safe, add your wedgie to one, or execute. Signing with the wedgie alone needs none.</p>`;
    else if (!account) h += `<p class="fine">It pays the gas (make a Safe, add your wedgie, execute) and can sign as an owner too.</p><p><button class="btn" id="w-go"${dis()}>Connect wallet</button></p>`;
    else h += `<p><code class="safe-addr">${esc(account)}</code>${isOwner(account) ? ` <span class="good">an owner of this Safe</span>` : ""}</p>`;
    $("s-wallet").innerHTML = h;
    $("w-go")?.addEventListener("click", () => job(async () => { account = await wallet(chain); findSafes(); }));
  }
  eth()?.on?.("accountsChanged", (a: string[]) => { account = a[0] ? E.checksum(a[0]) : ""; paintAll(); findSafes(); });

  // ---- 3. the Safe ----
  async function findSafes() {
    const c = chain, got = { chain: c, wedgie: [] as string[], wallet: [] as string[] };
    const of = async (a: string) => { try { return (await get(`${api(c)}/owners/${E.checksum(a)}/safes/`)).safes as string[]; } catch { return []; } };
    if (signer) got.wedgie = await of(signer);
    if (account) got.wallet = (await of(account)).filter((s) => !got.wedgie.some((x) => eqA(x, s)));
    if (c === chain) { mineSafes = got; paintSafe(); }
  }

  function paintSafe() {
    const opts = Object.entries(CHAINS).map(([id, c]) => `<option value="${id}"${+id === chain ? " selected" : ""}>${esc(c.name)}${c.test ? " (test)" : ""}</option>`).join("");
    const pick = (list: string[], who: string) => list.length ? `<p class="fine">${who}: ${list.map((s) => `<button class="btn btn-sm" data-open="${esc(s)}"${dis()}>${esc(short(s))}</button>`).join(" ")}</p>` : "";
    let h = `<h2>3. Your Safe</h2>
      <p><select id="s-chain"${dis()}>${opts}</select> <input id="s-addr" placeholder="0x… Safe address" value="${esc(safeAddr)}" spellcheck="false" size="44"> <button class="btn" id="s-load"${dis()}>Open</button></p>`;
    if (mineSafes.chain === chain) h += pick(mineSafes.wedgie, "Your wedgie's Safes") + pick(mineSafes.wallet, "Your wallet's Safes");
    if (key) h += `<p class="fine">No Safe yet? <button class="btn btn-sm" id="s-new-safe"${dis()}>Make a new Safe</button></p>`;
    if (info) {
      const i = info, c = CHAINS[chain];
      const canChange = isOwner(signer) || isOwner(account);
      h += `<div class="safe-info">
        <p><b>${esc(short(safeAddr))}</b> on ${esc(c.name)} · ${esc(E.fmt(i.balance, 18))} ETH${i.usdc !== null ? ` · ${esc(E.fmt(i.usdc, 6, 2))} USDC` : ""} ·
          <a href="${appLink(chain, safeAddr)}" target="_blank" rel="noopener">Safe{Wallet}</a> · <a href="${c.scan}/address/${safeAddr}" target="_blank" rel="noopener">explorer</a></p>
        <p>${i.threshold} of ${plural(i.owners.length, "owner")} must sign${canChange && i.owners.length > 1
          ? ` · <select id="o-th"${dis()}>${threshOpts(i.owners.length, i.threshold)}</select> <button class="btn btn-sm" id="o-th-go"${dis()}>Change</button>` : ""}</p>
        <ul class="safe-list">${i.owners.map((o) => `<li><code>${esc(o)}</code>${label(o)}${canChange && i.owners.length > 1 ? ` <button class="btn btn-sm" data-rm="${esc(o)}"${dis()}>Remove</button>` : ""}</li>`).join("")}</ul>
        ${signer ? isOwner(signer) ? `<p class="good">Your wedgie is an owner.</p>` : `<p class="bad">Your wedgie isn't an owner of this Safe yet.</p>` : ""}
      </div>`;
    }
    $("s-safe").innerHTML = h;
    $("s-new-safe")?.addEventListener("click", () => { creating = !creating; paintCreate(); if (creating) $("s-create").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
    $("s-chain").onchange = () => {
      chain = +($("s-chain") as HTMLSelectElement).value;
      info = null; queue = []; safeAddr = ""; $("s-new").innerHTML = "";
      history.replaceState(null, "", `/safe?chain=${chain}`);
      paintAll(); checkDeployed(); findSafes();
    };
    $("s-load").onclick = () => {
      const a = ($("s-addr") as HTMLInputElement).value.trim().replace(/^\w+:/, "");
      if (!E.isAddress(a)) { say("That isn't an address.", true); return; }
      open(a);
    };
    $("s-safe").querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => b.onclick = () => open(b.dataset.open!));
    $("s-safe").querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) => b.onclick = () => removeOwner(b.dataset.rm!));
    $("o-th-go")?.addEventListener("click", () => changeThreshold(+($("o-th") as HTMLSelectElement).value));
  }

  function open(a: string) {
    safeAddr = E.checksum(a); creating = false; $("s-new").innerHTML = "";
    localStorage.setItem("wedgie.safe", `${CHAINS[chain].key}:${safeAddr}`);
    history.replaceState(null, "", `/safe?safe=${CHAINS[chain].key}:${safeAddr}`);
    job(() => load());
  }

  /** The Safe from the chain (owners, threshold, nonce: the truth), its queue from Safe's API. */
  async function load(quiet = false) {
    if (!quiet) say("Opening the Safe.");
    const c = chain, a = safeAddr;
    try {
      if (!(await hasCode(c, a))) throw new Error(`There's no Safe at ${short(a)} on ${CHAINS[c].name}. Another chain?`);
      const [owners, th, n, bal, usdc] = await Promise.all([view(c, a, E.selector("getOwners()")), view(c, a, E.selector("getThreshold()")),
        view(c, a, E.selector("nonce()")), rpc(c, "eth_getBalance", [a, "latest"]),
        CHAINS[c].usdc ? view(c, CHAINS[c].usdc!, E.call("balanceOf(address)", [E.aword(a)])) : Promise.resolve(null)]);
      const i: Info = { owners: E.addrs(owners), threshold: Number(BigInt(th)), nonce: Number(BigInt(n)), balance: BigInt(bal), usdc: usdc ? BigInt(usdc) : null };
      let qq: any[] = [];
      try {
        qq = (await get(`${api(c)}/safes/${a}/multisig-transactions/?executed=false&nonce__gte=${i.nonce}&ordering=nonce&limit=20`)).results || [];
      } catch (e: any) { if (e.status !== 404) throw e; }     // a Safe made seconds ago: Safe's API hasn't seen it yet
      if (c !== chain || a !== safeAddr) return;
      info = i; queue = qq;
      if (!quiet) say("");
    } catch (e) { info = null; queue = []; if (!quiet) fail(e); }
    paintAll();
  }

  // ---- add the wedgie as an owner, from a browser wallet that already is one ----
  function paintAdd() {
    const box = $("s-add");
    box.hidden = !(info && signer && !isOwner(signer));
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
      say("First your wallet puts the wedgie's signer contract on chain (once per chain).");
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
  function changeThreshold(th: number) {
    if (th === info!.threshold) { say(`It's already ${th}.`); return; }
    job(() => propose(safeTx(safeAddr, "0", E.changeThresholdData(th)), by(), `${th} of ${info!.owners.length} must sign`));
  }

  // ---- a new Safe with the wedgie as an owner; a browser wallet pays the gas ----
  function paintCreate() {
    const box = $("s-create");
    box.hidden = !(creating && key);
    if (box.hidden) return;
    if (document.getElementById("c-go")) {       // keep what's typed
      $("c-go").textContent = `Make it on ${CHAINS[chain].name}`;
      ($("c-go") as HTMLButtonElement).disabled = busy;
      return;
    }
    box.innerHTML = `<h2>Make a new Safe</h2>
      <p class="fine">Your wedgie is an owner. Add more owners (any wallet or wedgie signer address, one a line), or leave it the only one.</p>
      <p><textarea id="c-owners" rows="3" cols="44" placeholder="0x… other owners" spellcheck="false"></textarea></p>
      <p><button class="btn btn-sm" id="c-me">Add my wallet</button></p>
      <p><select id="c-th"></select> <span id="c-of"></span> must sign.
        <button class="btn btn-green" id="c-go">Make it on ${esc(CHAINS[chain].name)}</button></p>
      <p class="fine">Your browser wallet sends one transaction, which puts the wedgie's signer contract and the Safe (Safe 1.4.1) on chain.</p>`;
    const ta = $("c-owners") as HTMLTextAreaElement, th = $("c-th") as HTMLSelectElement;
    const count = () => {                         // only the count: never rebuild the box under someone typing
      const n = 1 + new Set(ta.value.split(/\s+/).filter(E.isAddress).map((a) => a.toLowerCase()).filter((a) => a !== signer.toLowerCase())).size;
      th.innerHTML = threshOpts(n, Math.min(n, Math.max(+th.value || 2, 1)));
      $("c-of").textContent = `of ${plural(n, "owner")}`;
    };
    ta.oninput = count;
    count();
    $("c-me").onclick = () => job(async () => {
      const me = account = await wallet(chain);
      if (!ta.value.toLowerCase().includes(me.toLowerCase())) ta.value = (ta.value.trim() + "\n" + me).trim();
      count();
    });
    $("c-go").onclick = () => job(createSafe);
  }

  async function createSafe() {
    const words = ($("c-owners") as HTMLTextAreaElement).value.split(/\s+/).filter(Boolean);
    const bad = words.find((a) => !E.isAddress(a));
    if (bad) throw new Error(`${bad} isn't an address.`);
    const owners = [signer];
    for (const a of words.map(E.checksum)) if (!owners.some((o) => eqA(o, a))) owners.push(a);
    const th = +($("c-th") as HTMLSelectElement).value;
    account = await wallet(chain);
    const r = await send(chain, E.MULTICALL3, E.newSafeData(key!.x, key!.y, owners, th, BigInt(Date.now())), say);
    const log = (r.logs || []).find((l: any) => eqA(l.address, E.SAFE_FACTORY) && l.topics[0] === E.PROXY_CREATION);
    if (!log) throw new Error("It ran, but no new Safe showed up in it: " + r.transactionHash);
    deployed[chain] = true;
    creating = false;
    $("s-create").innerHTML = "";
    safeAddr = E.checksum("0x" + log.topics[1].slice(26));
    localStorage.setItem("wedgie.safe", `${CHAINS[chain].key}:${safeAddr}`);
    history.replaceState(null, "", `/safe?safe=${CHAINS[chain].key}:${safeAddr}`);
    await load(true);
    say(`Made your Safe: ${safeAddr}. Send it some ETH or tokens, then use New transaction below.`);
    setTimeout(findSafes, 8000);                // Safe's API lists it a few seconds after its block
  }

  // ---- the queue ----
  function paintQueue() {
    const box = $("s-queue");
    box.hidden = !info;
    if (!info) return;
    const i = info;
    const signed = (t: any, a: string) => !!a && (t.confirmations || []).some((c: any) => eqA(c.owner, a));
    const rows = queue.map((t, k) => {
      const n = (t.confirmations || []).length, need = t.confirmationsRequired ?? i.threshold, first = +t.nonce === i.nonce;
      const what = t.dataDecoded?.method ? t.dataDecoded.method
        : t.data && t.data !== "0x" ? "contract call" : `send ${E.fmt(BigInt(t.value), 18)} ETH`;
      const btns: string[] = [];
      if (isOwner(signer)) btns.push(signed(t, signer) ? `<span class="good">wedgie signed</span>` : `<button class="btn btn-sm btn-green" data-sign="${k}"${dis(!key)}>Sign with wedgie</button>`);
      if (account && isOwner(account)) btns.push(signed(t, account) ? `<span class="good">wallet signed</span>` : n < need ? `<button class="btn btn-sm" data-wsign="${k}"${dis()}>Sign with wallet</button>` : "");
      if (n >= need) btns.push(first ? `<button class="btn btn-sm btn-green" data-exec="${k}"${dis()}>Execute</button>` : `<span class="fine">runs after #${i.nonce}</span>`);
      return `<li><b>#${esc(t.nonce)}</b> ${esc(what)} → ${esc(eqA(t.to, safeAddr) ? "this Safe" : short(t.to))} <span class="fine">${n}/${need} signed</span> ${btns.join(" ")}</li>`;
    }).join("");
    box.innerHTML = `<h2>4. Waiting to sign</h2>${rows ? `<ul class="safe-list">${rows}</ul>` : `<p class="fine">Nothing waiting.</p>`}
      <p><button class="btn btn-sm" id="s-refresh"${dis()}>Refresh</button></p>`;
    $("s-refresh").onclick = () => job(() => load());
    box.querySelectorAll<HTMLButtonElement>("[data-sign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.sign!], "wedgie")));
    box.querySelectorAll<HTMLButtonElement>("[data-wsign]").forEach((b) => b.onclick = () => job(() => signQueued(queue[+b.dataset.wsign!], "wallet")));
    box.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach((b) => b.onclick = () => job(() => execute(queue[+b.dataset.exec!])));
  }

  const safeTx = (to: string, value: string, data: string, nonce = nextNonce()): E.SafeTx =>
    ({ to: E.checksum(to), value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce });

  /** The wedgie signs t; the page checks it signed the same hash, and that its signer contract can be checked on chain. */
  async function wedgieSig(t: E.SafeTx) {
    if (!wedgie || !key) throw new Error("No wedgie running the Safe signer.");
    if (!(await hasCode(chain, signer))) { deployed[chain] = false; throw new Error(`The wedgie's signer contract isn't on ${CHAINS[chain].name} yet: Deploy it (above) first. Safe checks its signatures through it.`); }
    const tx = { chainId: chain, safe: safeAddr, to: t.to, value: String(t.value), data: t.data || "0x", operation: +t.operation,
      safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice), gasToken: t.gasToken || Z,
      refundReceiver: t.refundReceiver || Z, nonce: +t.nonce };      // only the fields: the wedgie reads one line of at most 6 KB
    if (JSON.stringify({ id: 1000, type: "safe_sign", tx }).length > LINE_MAX) throw new Error("This transaction is too big for the wedgie to read (over 6 KB). Sign it another way.");
    asking = true; paintAll();
    say("Look at the wedgie: check what it shows, then press A to sign (Y says no).");
    try {
      const g = await W.withRepl(wedgie, (r) => r.request({ type: "safe_sign", tx }, 200000));
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
   * One signature on a new Safe transaction. Enough on its own (1 of N, next in line) and signed by the
   * wallet: it runs right away. Otherwise into Safe's queue, where every owner sees it.
   */
  async function propose(t: E.SafeTx, who: "wedgie" | "wallet", what: string) {
    if (who === "wallet") say(`Sign it in your wallet: ${what}.`);
    const sig = who === "wedgie" ? await wedgieSig(t) : await walletSig(t);
    if (info!.threshold === 1 && +t.nonce === info!.nonce && account) {
      await send(chain, safeAddr, E.execData(t, E.packSignatures([sig])), say);
      await load(true);
      say(`Done: ${what}.`);
      return;
    }
    say("Putting it in the Safe's queue.");
    await post(`${api(chain)}/safes/${safeAddr}/multisig-transactions/`, { ...t, contractTransactionHash: E.safeTxHash(chain, safeAddr, t),
      sender: sig.owner, signature: sig.signature, origin: "wedgie.dev/safe" });
    await load(true);
    const left = info!.threshold - 1;
    say(left ? `In the queue with ${who === "wedgie" ? "the wedgie's" : "your"} signature: ${what}. ${plural(left, "more owner")} to sign, then Execute.`
      : `Signed: ${what}. Press Execute (a browser wallet pays the gas).`);
  }

  async function signQueued(t: any, who: "wedgie" | "wallet") {
    const sig = who === "wedgie" ? await wedgieSig(t) : await walletSig(t);
    if (E.safeTxHash(chain, safeAddr, t) !== t.safeTxHash) throw new Error("Safe's API has a different hash for this one: not sent.");
    say("Sending the signature to Safe.");
    await post(`${api(chain)}/multisig-transactions/${t.safeTxHash}/confirmations/`, { signature: sig.signature });
    await load(true);
    const u = queue.find((x) => x.safeTxHash === t.safeTxHash);
    say(u && (u.confirmations || []).length >= (u.confirmationsRequired ?? info!.threshold) ? "Signed. That's enough: press Execute." : "Signed. It shows in Safe{Wallet} too.");
  }

  /** Every owner's signature from Safe's API, packed; a browser wallet sends it (and pays the gas). */
  async function execute(t: any) {
    if (+t.nonce !== info!.nonce) throw new Error(`#${info!.nonce} runs first: a Safe runs its transactions in order.`);
    const sigs = (t.confirmations || []).map((c: any) => ({ owner: c.owner,
      signature: c.signature || E.hex(E.cat(E.aword(c.owner), E.word(0), new Uint8Array([1]))) }));   // an approveHash on chain
    await send(chain, safeAddr, E.execData(t, E.packSignatures(sigs)), say);
    await load(true);
    say("Done: it ran.");
  }

  // ---- a new transaction ----
  function paintNew() {
    const box = $("s-new");
    const me = isOwner(signer) || isOwner(account);
    box.hidden = !(info && me);
    if (box.hidden) return;
    const c = CHAINS[chain];
    if (!document.getElementById("n-to")) {      // built once per Safe: keep what's typed across repaints
      box.innerHTML = `<h2>5. New transaction</h2>
        <p><input id="n-to" placeholder="to 0x…" size="44" spellcheck="false"></p>
        <p><input id="n-amt" placeholder="amount" size="12" inputmode="decimal"> <select id="n-tok"><option value="eth">ETH</option>${c.usdc ? `<option value="usdc">USDC</option>` : ""}</select></p>
        <details class="fine"><summary>Contract call data (optional)</summary><p><input id="n-data" placeholder="data 0x…" size="44" spellcheck="false"></p></details>
        <p id="n-btns"></p>`;
    }
    $("n-btns").innerHTML = `${isOwner(signer) ? `<button class="btn btn-green" id="n-wedgie"${dis(!key)}>Sign with wedgie</button> ` : ""}${isOwner(account) ? `<button class="btn" id="n-wallet"${dis()}>Sign with wallet</button>` : ""}`;
    $("n-wedgie")?.addEventListener("click", () => job(() => newTx("wedgie")));
    $("n-wallet")?.addEventListener("click", () => job(() => newTx("wallet")));
  }

  async function newTx(who: "wedgie" | "wallet") {
    const to = ($("n-to") as HTMLInputElement).value.trim(), amt = ($("n-amt") as HTMLInputElement).value.trim() || "0";
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
    ($("n-to") as HTMLInputElement).value = ""; ($("n-amt") as HTMLInputElement).value = ""; ($("n-data") as HTMLInputElement).value = "";
  }

  function paintAll() { paintWedgie(); paintWallet(); paintSafe(); paintAdd(); paintCreate(); paintQueue(); paintNew(); }

  W.onChange(paintWedgie);
  if (W.armed()) W.start();
  eth()?.request({ method: "eth_accounts" }).then((a: string[]) => { if (a?.[0]) { account = E.checksum(a[0]); paintAll(); findSafes(); } }, () => {});
  paintAll();
  if (safeAddr) job(() => load());
}
