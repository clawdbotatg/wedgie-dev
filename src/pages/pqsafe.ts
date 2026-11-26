// /pqsafe: a Safe whose only owner is an SLH-DSA key made on a wedgie (the plan: /pq). Install PQ Safe Signer
// (clawdbotatg/wedgie-pqsafe, an app on the shelf), make the key, make the Safe, put ETH in, send it.
// A test: the contracts (clawdbotatg/wedgie-pq, contracts/) are not audited. The app works out the Safe
// transaction hash itself, shows what it signs, and signs on a green press. A browser wallet pays the gas.
import * as W from "../serial/wedgies";
import * as E from "../safe/eth";
import { firmwareManifest, takeOver, useApp } from "../serial/install";

/** SlhSafeFactory (wedgie-pq contracts/src), the same address on both chains. */
const FACTORY = "0xc7bdA0EF354ff3F547c0DFa15Cd56cfdD6746f62";
const CHAINS: Record<number, { name: string; scan: string }> = {
  1: { name: "Ethereum", scan: "https://etherscan.io" },
  8453: { name: "Base", scan: "https://basescan.org" },
};
const SIG = 17088;          // SLH-DSA-SHA2-128f
const APP = "pqsafe";
const KEY = "wedgie.pqsafe";

const PAGE = `
<h1>Post-quantum Safe</h1>
<p class="fine">A test · small money only · <a href="/pq">the plan</a></p>
<p>A Safe whose only owner is a hash-signature key (SLH-DSA) made on your wedgie. No elliptic-curve key can move its money.</p>
<div class="pq-try">
  <p id="ps-text"></p>
  <div id="ps-body"></div>
</div>
<h2>Know this first</h2>
<ul>
  <li>Not audited. Small money only.</li>
  <li>PQ Safe Signer replaces the app on your wedgie. Put Safe Signer back any time at <a href="/connect">/connect</a>. Its key stays in the chip.</li>
  <li>Its screens are black. Safe Signer's are white. So you can tell which one is asking.</li>
  <li>The key's seed is in the secure chip but not locked. If something rewrites that slot, the key is gone and so is the Safe's money.</li>
  <li>It reads plain ETH sends. That is all this page makes.</li>
  <li>Your browser wallet pays the gas. It can't move the Safe's money.</li>
  <li>A send is about 2.75M gas: the signature is 17 KB.</li>
</ul>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b16 = (h: string) => E.cat(E.bytes("0x" + h), new Uint8Array(16));
const short = (a: string) => a.slice(0, 8) + ".." + a.slice(-6);

// ---- the chain: reads through /api/rpc, sends through a browser wallet ----
// On localhost, ?fork=<port> uses a local fork (anvil) for both, and its first account pays: for testing.
const fork = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get("fork") : null;
let rpcId = 0;
async function rpc(chain: number, method: string, params: unknown[]): Promise<any> {
  for (let i = 0; ; i++) {
    const res = await fetch(fork ? `http://127.0.0.1:${+fork}` : `/api/rpc?chain=${chain}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    if ((res.status === 429 || res.status >= 500) && i < 5) { await sleep(800 * 2 ** i); continue; }
    const r = await res.json();
    if (r.error) throw new Error(`${CHAINS[chain].name}: ${r.error.message || r.error}`);
    return r.result;
  }
}
const view = (chain: number, to: string, data: string) => rpc(chain, "eth_call", [{ to, data }, "latest"]);
const addr = (ret: string) => E.checksum("0x" + ret.slice(-40));

let wallet: any = null;
async function send(chain: number, to: string, data: string, value: bigint, say: (s: string) => void) {
  let hash: string;
  if (fork) {
    const [from] = await rpc(chain, "eth_accounts", []);
    hash = await rpc(chain, "eth_sendTransaction", [{ from, to, data, value: "0x" + value.toString(16) }]);
  } else {
    if (!wallet) { say("Pick a wallet to pay the gas."); wallet = await (await import("../safe/rainbow")).connect(); }
    const [from] = await wallet.request({ method: "eth_requestAccounts" });
    const want = "0x" + chain.toString(16);
    if ((await wallet.request({ method: "eth_chainId" })) !== want) await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    say("Confirm it in your wallet.");
    hash = await wallet.request({ method: "eth_sendTransaction", params: [{ from, to, data, value: "0x" + value.toString(16) }] });
  }
  for (let i = 0; i < 200; i++) {
    say("Sent. Waiting for it to land in a block.");
    const r = await rpc(chain, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) { if (r.status !== "0x1") throw new Error(`it failed on chain: ${CHAINS[chain].scan}/tx/${hash}`); return hash; }
    await sleep(1500);
  }
  throw new Error("still not in a block: " + hash);
}

type Saved = { pk: string; wedgie: string; chain: number };

export function pqsafe(main: HTMLElement) {
  main.innerHTML = `<section class="test-page legal-page">${PAGE}</section>`;
  const $ = (id: string) => document.getElementById(id)!;
  let working = false, note = "", last = "";
  let saved: Saved | null = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  let safe: { chain: number; pk: string; owner: string; addr: string; made: boolean; balance: bigint; nonce: number } | null = null;
  const keep = () => { try { saved ? localStorage.setItem(KEY, JSON.stringify(saved)) : localStorage.removeItem(KEY); } catch {} };
  const say = (h: string) => { note = h; $("ps-text").innerHTML = h; };

  /** Where this key's Safe is on the chosen chain, and what's in it. */
  async function look() {
    if (!saved) { safe = null; return; }
    const { chain, pk } = saved, key = [b16(pk.slice(0, 32)), b16(pk.slice(32)), E.word(1)];
    const [o, s] = await Promise.all([view(chain, FACTORY, E.call("ownerOf(bytes16,bytes16,bool)", key)),
      view(chain, FACTORY, E.call("safeOf(bytes16,bytes16,bool,uint256)", [...key, E.word(0)]))]);
    const a = addr(s);
    const [code, bal] = await Promise.all([rpc(chain, "eth_getCode", [a, "latest"]), rpc(chain, "eth_getBalance", [a, "latest"])]);
    const made = code.length > 2;
    const nonce = made ? Number(BigInt(await view(chain, a, E.selector("nonce()")))) : 0;
    if (saved?.chain === chain && saved.pk === pk) safe = { chain, pk, owner: addr(o), addr: a, made, balance: BigInt(bal), nonce };
  }

  const asked = new Set<number>();
  /** A wedgie running the app: ask it for its key, once. */
  function readKeys() {
    for (const w of W.wedgies()) {
      if (w.state !== "ready" || w.running !== APP || asked.has(w.key) || working) continue;
      asked.add(w.key);
      W.withRepl(w, (r) => r.request({ type: "pq_key" }, 6000)).then((m) => {
        pks[w.key] = m?.pk || "";
        if (m?.pk && (!saved || saved.pk !== m.pk)) { saved = { pk: m.pk, wedgie: w.short || "", chain: saved?.chain || 1 }; safe = null; keep(); refresh(); }
        paint();
      }, () => { asked.delete(w.key); });
    }
  }
  const pks: Record<number, string> = {};

  function paint() {
    $("ps-text").innerHTML = note;
    const ws = W.wedgies(), off = working ? " disabled" : "";
    const btn = (w: W.Wedgie, label: string, act: string) =>
      `<button class="btn btn-green" data-act="${act}" data-k="${w.key}"${working || w.state !== "ready" ? " disabled" : ""}>${label} ${esc(w.short || "…")}</button>`;
    const has = ws.filter((w) => w.running === APP), signers = has.filter((w) => saved && pks[w.key] === saved.pk);
    let h = "";
    // 1. the app
    if (!ws.length) h += `<p><b>1. The app.</b> PQ Safe Signer goes on your wedgie.</p><p class="fine">No wedgie yet. <a href="/connect">Connect</a> one first if this browser hasn't.</p>`;
    else if (!has.length) h += `<p><b>1. The app.</b> PQ Safe Signer goes on your wedgie. It replaces the app that is on it.</p><p>${ws.map((w) => btn(w, "Install PQ Safe Signer on", "install")).join(" ")}</p>`;
    else h += `<p class="fine">PQ Safe Signer is on ${has.map((w) => esc(w.short || "…")).join(", ")}.${ws.length > has.length ? " " + ws.filter((w) => w.running !== APP).map((w) => `<a href="#" data-act="install" data-k="${w.key}">Install on ${esc(w.short || "…")}</a>`).join(" ") : ""}</p>`;
    // 2. the key
    const keyless = has.filter((w) => pks[w.key] === "");
    if (keyless.length) h += `<p><b>2. The key.</b> Your wedgie makes it and asks first.</p><p>${keyless.map((w) => btn(w, "Make the key on", "key")).join(" ")}</p>`;
    if (saved) {
      const c = CHAINS[saved.chain];
      h += `<p class="fine pq-hex">Key from wedgie ${esc(saved.wedgie)}: ${esc(saved.pk)} · <a href="#" data-act="forget">forget it</a></p>
        <p>${Object.entries(CHAINS).map(([id, x]) => `<button class="btn btn-sm${+id === saved!.chain ? " btn-green" : ""}" data-act="chain" data-chain="${id}"${off}>${x.name}</button>`).join(" ")}</p>`;
      if (!safe || safe.chain !== saved.chain) h += `<p class="fine">Looking on ${c.name}…</p>`;
      else {
        const link = `<a class="pq-hex" href="${c.scan}/address/${safe.addr}" target="_blank" rel="noopener">${safe.addr}</a>`;
        if (!safe.made) h += `<p><b>3. The Safe.</b> It will be at ${link}. One transaction makes it and its owner contract.</p><p><button class="btn btn-green" data-act="make"${off}>Make the Safe on ${c.name}</button></p>`;
        else {
          h += `<p><b>Your Safe:</b> ${link}<br><b>${E.fmt(safe.balance, 18)} ETH</b> · owner contract <a class="pq-hex" href="${c.scan}/address/${safe.owner}" target="_blank" rel="noopener">${short(safe.owner)}</a> · <a href="#" data-act="look">refresh</a></p>
            <p><b>4. Put ETH in.</b> Send to the address above from anywhere, or: <button class="btn btn-sm" data-act="fund"${off}>Put 0.0005 ETH in</button></p>
            <p><b>5. Send.</b></p>
            <p><input id="ps-to" placeholder="to 0x…" size="44" value="${esc((document.getElementById("ps-to") as HTMLInputElement | null)?.value || "")}"> <input id="ps-amt" placeholder="ETH" size="10" value="${esc((document.getElementById("ps-amt") as HTMLInputElement | null)?.value || "")}"></p>
            <p>${signers.length ? signers.map((w) => btn(w, "Sign on", "send")).join(" ") : `<span class="fine">Plug in the wedgie with this key, running PQ Safe Signer.</span>`}</p>`;
        }
      }
    }
    if (last) h += `<p>${last}</p>`;
    $("ps-body").innerHTML = h;
    $("ps-body").querySelectorAll<HTMLElement>("[data-act]").forEach((b) => b.onclick = (e) => {
      e.preventDefault();
      const act = b.dataset.act!, w = ws.find((x) => x.key === +(b.dataset.k || -1));
      if (act === "forget") { saved = null; safe = null; last = ""; keep(); say(""); paint(); }
      else if (act === "chain") { saved!.chain = +b.dataset.chain!; safe = null; keep(); paint(); refresh(); }
      else if (act === "look") refresh();
      else if (act === "install" && w) job(() => install(w));
      else if (act === "key" && w) job(() => makeKey(w));
      else if (act === "make") job(make);
      else if (act === "fund") job(fund);
      else if (act === "send" && w) job(() => sendFrom(w));
    });
    readKeys();
  }
  const refresh = () => look().then(paint, (e) => { say(`<b class="bad">Couldn't read the chain:</b> ${esc(e?.message || String(e))}`); });

  async function job(f: () => Promise<void>) {
    working = true; paint();
    try { await f(); } catch (e: any) { say(`<b class="bad">It didn't work:</b> ${esc(e?.message || String(e))}`); }
    working = false; paint();
    await refresh();
  }

  async function install(w: W.Wedgie) {
    say("Getting PQ Safe Signer.");
    const m = await firmwareManifest(), cart = m.carts.find((c) => c.mod === APP);
    if (!cart) throw new Error("PQ Safe Signer isn't on wedgie.dev's shelf yet");
    // the local test rig's shelf isn't signed: there, and only there, it goes on through full control
    if (fork) await W.withRepl(w, async (r) => { await takeOver(r, () => {}, "Install PQ Safe Signer"); try { await useApp(r, cart, () => {}, { launcher: false, manifest: m }); } finally { await r.leave({ reset: true }); } });
    else await W.withRepl(w, (r) => useApp(r, cart, (p, what) => say(`Installing PQ Safe Signer: ${Math.round(p * 100)}%${what ? " · " + esc(what) : ""}. <b>Press green on the wedgie if it asks.</b>`), { manifest: m }));
    say("Installed. The wedgie is starting it.");
    asked.delete(w.key);
    for (let i = 0; i < 90 && w.running !== APP; i++) { if (i % 10 === 5) W.reidentify(w); await sleep(1000); }
    say(w.running === APP ? "<b>PQ Safe Signer is on.</b>" : "Installed. Unplug the wedgie and plug it back in.");
  }

  async function makeKey(w: W.Wedgie) {
    say("<b>Look at the wedgie.</b> It asks: Make a new key?");
    const m = await W.withRepl(w, (r) => r.request({ type: "pq_make" }, 200000));
    if (m.type === "refused") throw new Error("the wedgie said no");
    if (m.type !== "pq_key" || !/^[0-9a-f]{64}$/.test(m.pk || "")) throw new Error(m.error || "the wedgie gave no key");
    pks[w.key] = m.pk;
    saved = { pk: m.pk, wedgie: w.short || "", chain: saved?.chain || 1 };
    keep();
    say("<b>The key is made.</b>");
  }

  async function make() {
    const s = saved!, key = [b16(s.pk.slice(0, 32)), b16(s.pk.slice(32)), E.word(1)];
    const hash = await send(s.chain, FACTORY, E.call("make(bytes16,bytes16,bool,uint256)", [...key, E.word(0)]), 0n, say);
    last = `Made: <a href="${CHAINS[s.chain].scan}/tx/${hash}" target="_blank" rel="noopener">the transaction</a>`;
    say("<b>The Safe is made.</b>");
  }

  async function fund() {
    const hash = await send(safe!.chain, safe!.addr, "0x", 500000000000000n, say);
    last = `Put in: <a href="${CHAINS[safe!.chain].scan}/tx/${hash}" target="_blank" rel="noopener">the transaction</a>`;
    say("<b>0.0005 ETH is in.</b>");
  }

  async function sendFrom(w: W.Wedgie) {
    await look();
    const s = safe!, c = CHAINS[s.chain];
    const to = (document.getElementById("ps-to") as HTMLInputElement).value.trim(), amt = (document.getElementById("ps-amt") as HTMLInputElement).value.trim();
    if (!E.isAddress(to)) throw new Error("that isn't an address");
    if (!/^\d*\.?\d+$/.test(amt)) throw new Error("how much ETH?");
    const value = E.units(amt, 18);
    if (value <= 0n || value > s.balance) throw new Error(`the Safe has ${E.fmt(s.balance, 18)} ETH`);
    const tx = E.strictTx({ to: E.checksum(to), value, data: "0x", operation: 0, nonce: s.nonce });
    const hash = E.safeTxHash(s.chain, s.addr, tx);
    const slh = await import("../pq/slh");
    const msg = slh.wrap(E.bytes(hash));
    say(`<b>Look at the wedgie.</b> It asks: Send ${esc(amt)} ETH? Green signs.`);
    let sigHex = "";
    const m = await W.withRepl(w, async (r) => {
      r.onLine = (t, v) => { if (t === "sig") { sigHex += v; say(`Signing: ${Math.round((sigHex.length / 2 / SIG) * 100)}%. About 10 seconds.`); } };
      try { return await r.request({ type: "pq_sign", tx: { chainId: s.chain, safe: s.addr, ...tx } }, 300000); } finally { r.onLine = null; }
    });
    if (m.type === "refused") throw new Error("the wedgie said no");
    if (m.type !== "pq_sig") throw new Error(m.error || "the wedgie didn't sign");
    if (String(m.safeTxHash).toLowerCase() !== hash.toLowerCase()) throw new Error("the wedgie worked out a different transaction hash");
    const sig = E.bytes("0x" + sigHex);
    if (sig.length !== SIG || !slh.verify("128f", E.bytes("0x" + s.pk), msg, sig)) throw new Error("the signature didn't check in this browser");
    say("Signed, and this browser checked it.");
    // a contract owner's signature: the owner, where its bytes start (65), type 0, then the bytes
    const sigs = E.hex(E.cat(E.aword(s.owner), E.word(65), new Uint8Array([0]), E.word(sig.length), sig));
    const sent = await send(s.chain, s.addr, E.execData(tx, sigs), 0n, say);
    last = `Sent ${esc(amt)} ETH to ${esc(short(E.checksum(to)))}: <a href="${c.scan}/tx/${sent}" target="_blank" rel="noopener">the transaction</a>`;
    say("<b>Sent, with a post-quantum signature.</b>");
  }

  W.onChange(paint);
  W.start();
  paint();
  refresh();
}
