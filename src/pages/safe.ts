// wedgie.dev/safe: a wedgie as a signer on a Safe. The wedgie runs the Safe signer app
// (clawdbotatg/wedgie-safe): its key lives in the Trust M chip, it shows each transaction and signs on A.
// This page: the wedgie's signer address (worked out here, no RPC), the Safe's queue from Safe's
// Transaction Service (api.safe.global, no key, CORS open), sign one on the wedgie and post the
// signature there, propose a new one, and deploy the signer contract / execute with a browser wallet.
// With a browser wallet that owns a Safe it also adds the wedgie as an owner (proposed to the other owners,
// or run at once when one signature is enough), and it makes a new Safe with the wedgie as an owner.
import * as W from "../serial/wedgies";
import * as E from "../safe/eth";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const Z = "0x" + "0".repeat(40);

// chain id -> Safe's short name (its API and app.safe.global use it). Every one has the P-256 precompile.
const CHAINS: Record<number, { name: string; key: string }> = {
  8453: { name: "Base", key: "base" }, 1: { name: "Ethereum", key: "eth" }, 10: { name: "Optimism", key: "oeth" },
  42161: { name: "Arbitrum", key: "arb1" }, 84532: { name: "Base Sepolia", key: "basesep" }, 11155111: { name: "Sepolia", key: "sep" },
};
const api = (chain: number) => `https://api.safe.global/tx-service/${CHAINS[chain].key}/api/v1`;
const appLink = (chain: number, safe: string, path = "home") => `https://app.safe.global/${path}?safe=${CHAINS[chain].key}:${safe}`;

async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Safe's API: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Safe's API said no: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ---- a browser wallet (EIP-1193), only to deploy the signer and execute: it pays the gas ----
const eth = () => (window as any).ethereum;
async function wallet(chain: number): Promise<string> {
  if (!eth()) throw new Error("No browser wallet here. Execute it in Safe{Wallet} instead.");
  const [from] = await eth().request({ method: "eth_requestAccounts" });
  const want = "0x" + chain.toString(16);
  if ((await eth().request({ method: "eth_chainId" })) !== want)
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  return from;
}
async function send(chain: number, to: string, data: string, say: (s: string) => void): Promise<any> {
  const from = await wallet(chain);
  say("Confirm it in your wallet.");
  const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
  say("Sent. Waiting for it to land in a block.");
  for (let i = 0; i < 120; i++) {
    const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) { if (r.status !== "0x1") throw new Error("It failed on chain: " + hash); return r; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("Still not in a block: " + hash);
}
/** The wallet signs t as an owner (EIP-712, what Safe{Wallet} asks for too). */
async function walletSig(chain: number, safe: string, t: E.SafeTx) {
  const from = await wallet(chain);
  const sig = await eth().request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(E.typedData(chain, safe, t))] });
  return { owner: E.checksum(from), signature: E.ecdsa(sig) };
}
const hasCode = async (a: string) => ((await eth()?.request({ method: "eth_getCode", params: [a, "latest"] })) || "0x").length > 2;

export function safe(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page safe-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Safe signer</h1>
    <p class="fine">Your wedgie signs for a <a href="https://app.safe.global" target="_blank" rel="noopener">Safe</a>. Its key never leaves its chip; it shows each transaction and signs only when you press A on it.</p>
    <div class="safe-box recess" id="s-wedgie"></div>
    <div class="safe-box recess" id="s-safe"></div>
    <div class="safe-box recess" id="s-add" hidden></div>
    <div class="safe-box recess" id="s-create" hidden></div>
    <div class="safe-box recess" id="s-queue" hidden></div>
    <div class="safe-box recess" id="s-new" hidden></div>
    <p class="fine" id="s-msg"></p>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const q = new URLSearchParams(location.search);
  let key: { x: string; y: string } | null = null, signer = "", wedgie: W.Wedgie | null = null, asking = false;
  let chain = 8453, safeAddr = "", info: any = null, queue: any[] = [], creating = false;
  const saved = q.get("safe") || localStorage.getItem("wedgie.safe") || "";
  const m = saved.match(/^(?:(\w+):)?(0x[0-9a-fA-F]{40})$/);
  if (m) { safeAddr = E.checksum(m[2]); chain = +(Object.entries(CHAINS).find(([, c]) => c.key === m[1])?.[0] || 8453); }
  const say = (s: string, bad = false) => { $("s-msg").innerHTML = bad ? `<b class="bad">${esc(s)}</b>` : esc(s); };

  // ---- the wedgie ----
  function paintWedgie() {
    const ws = W.wedgies().filter((w) => w.state === "ready");
    const app = ws.filter((w) => w.running === "safe");
    let h = `<h2>1. Your wedgie</h2>`;
    if (!W.armed()) h += `<p><a class="btn btn-green" href="/connect">Connect a wedgie</a></p>`;
    else if (!ws.length) h += `<p class="fine">Plug it in. Not showing? <a href="/connect">Connect</a> it first.</p>`;
    else if (!app.length) h += `<p class="fine">It isn't running the Safe signer. Install it from <a href="/connect/${esc(ws[0].short)}">its page</a> (Software, Safe signer).</p>`;
    else if (!key) h += `<p class="fine">Reading its key.</p>`;
    else h += `<p class="fine">Its key, on chain, is this signer contract. Add it as an owner of your Safe.</p>
      <p><code class="safe-addr">${esc(signer)}</code> <button class="btn" id="s-copy">Copy</button></p>
      <p class="fine" id="s-deploy-line"><button class="btn" id="s-deploy">Deploy it on ${esc(CHAINS[chain].name)}</button> once, before its first signature (any wallet can; it costs a little gas).</p>`;
    $("s-wedgie").innerHTML = h;
    $("s-copy")?.addEventListener("click", () => navigator.clipboard.writeText(signer));
    $("s-deploy")?.addEventListener("click", deploy);
    if (app.length && !key && wedgie !== app[0]) readKey(app[0]);
  }

  async function readKey(w: W.Wedgie) {
    wedgie = w;
    try {
      const h = await W.withRepl(w, (r) => r.request({ type: "hello" }, 5000));
      if (!h.safe) { say("Press A on the wedgie to make its key, then reload this page."); return; }
      key = h.safe; signer = E.signerAddress(key!.x, key!.y);
      paintAll();
    } catch (e: any) { say(e?.message || String(e), true); wedgie = null; }
  }

  async function deploy() {
    try {
      await wallet(chain);
      if (await hasCode(signer)) { $("s-deploy-line").innerHTML = `<span class="good">Deployed on ${esc(CHAINS[chain].name)}.</span>`; return; }
      const data = E.selector("createSigner(uint256,uint256,uint176)") + E.hex(E.cat(E.word(key!.x), E.word(key!.y), E.word(E.VERIFIERS))).slice(2);
      await send(chain, E.FACTORY, data, say);
      $("s-deploy-line").innerHTML = `<span class="good">Deployed on ${esc(CHAINS[chain].name)}.</span>`;
      say("");
    } catch (e: any) { say(e?.message || String(e), true); }
  }

  // ---- the Safe ----
  function paintSafe() {
    const opts = Object.entries(CHAINS).map(([id, c]) => `<option value="${id}"${+id === chain ? " selected" : ""}>${esc(c.name)}</option>`).join("");
    let h = `<h2>2. Your Safe</h2>
      <p><select id="s-chain">${opts}</select> <input id="s-addr" placeholder="0x… Safe address" value="${esc(safeAddr)}" spellcheck="false" size="44"> <button class="btn" id="s-load">Open</button></p>
      ${key ? `<p class="fine">No Safe yet? <button class="btn btn-sm" id="s-new-safe">Make a new Safe</button></p>` : ""}`;
    if (info) {
      const owner = signer && isOwner(signer);
      h += `<p class="fine">${info.owners.length} owners, ${info.threshold} needed to sign · nonce ${esc(info.nonce)} · <a href="${appLink(chain, safeAddr)}" target="_blank" rel="noopener">open in Safe{Wallet}</a></p>`;
      h += !signer ? "" : owner ? `<p class="good">Your wedgie is an owner.</p>`
        : `<p class="bad">Your wedgie isn't an owner yet.</p>`;
    }
    $("s-safe").innerHTML = h;
    $("s-new-safe")?.addEventListener("click", () => { creating = !creating; paintCreate(); });
    $("s-chain").onchange = () => { chain = +($("s-chain") as HTMLSelectElement).value; paintWedgie(); paintCreate(); };
    $("s-load").onclick = () => {
      const a = ($("s-addr") as HTMLInputElement).value.trim().replace(/^\w+:/, "");
      if (!E.isAddress(a)) { say("That isn't an address.", true); return; }
      chain = +($("s-chain") as HTMLSelectElement).value; safeAddr = E.checksum(a);
      localStorage.setItem("wedgie.safe", `${CHAINS[chain].key}:${safeAddr}`);
      history.replaceState(null, "", `/safe?safe=${CHAINS[chain].key}:${safeAddr}`);
      load();
    };
  }

  async function load(quiet = false) {
    if (!quiet) say("Opening the Safe.");
    try {
      info = await get(`${api(chain)}/safes/${safeAddr}/`);
      const r = await get(`${api(chain)}/safes/${safeAddr}/multisig-transactions/?executed=false&nonce__gte=${info.nonce}&ordering=nonce&limit=20`);
      queue = r.results || [];
      say("");
    } catch (e: any) { info = null; queue = []; if (!quiet) say(e?.message || String(e), true); }
    paintAll();
  }
  const paintAll = () => { paintWedgie(); paintSafe(); paintAdd(); paintCreate(); paintQueue(); paintNew(); };
  const isOwner = (a: string) => !!info && info.owners.some((o: string) => o.toLowerCase() === a.toLowerCase());
  const nextNonce = () => Math.max(+info.nonce, ...queue.map((t) => +t.nonce + 1));
  const threshOpts = (n: number, at: number) => Array.from({ length: n }, (_, i) => `<option${i + 1 === at ? " selected" : ""}>${i + 1}</option>`).join("");

  // ---- add the wedgie as an owner, from a browser wallet that already is one ----
  function paintAdd() {
    const box = $("s-add");
    box.hidden = !(info && signer && !isOwner(signer));
    if (box.hidden) return;
    const n = info.owners.length;
    box.innerHTML = `<h2>Add your wedgie as a signer</h2>
      <p class="fine">An owner of this Safe does it from their browser wallet. ${info.threshold > 1
        ? `This Safe needs ${info.threshold} signatures, so it goes to the queue below for the other owners to sign (here or in <a href="${appLink(chain, safeAddr, "transactions/queue")}" target="_blank" rel="noopener">Safe{Wallet}</a>), then anyone executes it.`
        : "One signature is enough here, so it runs right away."}</p>
      <p>Then <select id="a-th">${threshOpts(n + 1, info.threshold)}</select> of ${n + 1} owners must sign. <button class="btn btn-green" id="a-go">Add it with my wallet</button></p>`;
    $("a-go").onclick = addSigner;
  }

  async function addSigner() {
    try {
      const from = await wallet(chain);
      if (!isOwner(from)) throw new Error(`This wallet (${short(from)}) isn't an owner of this Safe. Switch to one that is.`);
      if (!(await hasCode(signer))) {
        say("First your wallet puts the wedgie's signer contract on chain (once per chain).");
        await send(chain, E.FACTORY, E.createSignerData(key!.x, key!.y), say);
      }
      const th = +($("a-th") as HTMLSelectElement).value;
      const t: E.SafeTx = { to: safeAddr, value: "0", data: E.addOwnerData(signer, th), operation: 0, safeTxGas: "0", baseGas: "0",
        gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce: nextNonce() };
      say("Sign it in your wallet: add owner " + short(signer) + ".");
      const sig = await walletSig(chain, safeAddr, t);
      if (info.threshold === 1 && +t.nonce === +info.nonce) {
        await send(chain, safeAddr, E.execData(t, E.packSignatures([sig])), say);
        await load();
        say("Done: your wedgie is an owner.");
        return;
      }
      await post(`${api(chain)}/safes/${safeAddr}/multisig-transactions/`, { ...t, contractTransactionHash: E.safeTxHash(chain, safeAddr, t),
        sender: sig.owner, signature: sig.signature, origin: "wedgie.dev/safe" });
      await load();
      say(`In the queue with your signature. ${info.threshold - 1} more owner${info.threshold > 2 ? "s" : ""} to sign, then Execute.`);
    } catch (e: any) { say(e?.message || String(e), true); }
  }

  // ---- a new Safe with the wedgie as an owner; a browser wallet pays the gas ----
  function paintCreate() {
    const box = $("s-create");
    box.hidden = !(creating && key);
    if (box.hidden) return;
    if (document.getElementById("c-go")) { $("c-go").textContent = `Make it on ${CHAINS[chain].name}`; return; }   // keep what's typed
    box.innerHTML = `<h2>Make a new Safe</h2>
      <p class="fine">Your wedgie is an owner. Add more owners (any wallet, one address a line), or leave it the only one.</p>
      <p><textarea id="c-owners" rows="3" cols="44" placeholder="0x… other owners" spellcheck="false"></textarea></p>
      <p><button class="btn btn-sm" id="c-me">Add my wallet</button></p>
      <p><select id="c-th"></select> <span id="c-of"></span> must sign.
        <button class="btn btn-green" id="c-go">Make it on ${esc(CHAINS[chain].name)}</button></p>
      <p class="fine">Your browser wallet sends one transaction: the wedgie's signer contract, then the Safe (Safe 1.4.1).</p>`;
    const ta = $("c-owners") as HTMLTextAreaElement, th = $("c-th") as HTMLSelectElement;
    const count = () => {                         // only the count: never rebuild the box under someone typing
      const n = 1 + new Set(ta.value.split(/\s+/).filter(E.isAddress).map((a) => a.toLowerCase())).size;
      th.innerHTML = threshOpts(n, Math.min(n, Math.max(+th.value || 2, 1)));
      $("c-of").textContent = `of ${n} owner${n > 1 ? "s" : ""}`;
    };
    ta.oninput = count;
    count();
    $("c-me").onclick = async () => {
      try {
        const me = E.checksum(await wallet(chain));
        if (!ta.value.toLowerCase().includes(me.toLowerCase())) ta.value = (ta.value.trim() + "\n" + me).trim();
        count();
      } catch (e: any) { say(e?.message || String(e), true); }
    };
    $("c-go").onclick = createSafe;
  }

  async function createSafe() {
    try {
      const words = ($("c-owners") as HTMLTextAreaElement).value.split(/\s+/).filter(Boolean);
      const bad = words.find((a) => !E.isAddress(a));
      if (bad) throw new Error(`${bad} isn't an address.`);
      const owners = [signer];
      for (const a of words.map(E.checksum)) if (!owners.some((o) => o.toLowerCase() === a.toLowerCase())) owners.push(a);
      const th = +($("c-th") as HTMLSelectElement).value;
      const r = await send(chain, E.MULTICALL3, E.newSafeData(key!.x, key!.y, owners, th, BigInt(Date.now())), say);
      const log = (r.logs || []).find((l: any) => l.address.toLowerCase() === E.SAFE_FACTORY.toLowerCase() && l.topics[0] === E.PROXY_CREATION);
      if (!log) throw new Error("It ran, but no new Safe showed up in it: " + r.transactionHash);
      safeAddr = E.checksum("0x" + log.topics[1].slice(26));
      creating = false;
      localStorage.setItem("wedgie.safe", `${CHAINS[chain].key}:${safeAddr}`);
      history.replaceState(null, "", `/safe?safe=${CHAINS[chain].key}:${safeAddr}`);
      ($("s-addr") as HTMLInputElement | null)?.setAttribute("value", safeAddr);
      for (let i = 0; i < 20; i++) {             // Safe's API finds a new Safe a few seconds after its block
        await load(true);
        if (info) break;
        say(`Made ${short(safeAddr)}. Waiting for Safe's API to see it.`);
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (info) say(`Made your Safe: ${safeAddr}.`);
    } catch (e: any) { say(e?.message || String(e), true); }
  }

  // ---- what's waiting ----
  function paintQueue() {
    const box = $("s-queue");
    box.hidden = !info;
    if (!info) return;
    const mine = (t: any) => signer && (t.confirmations || []).some((c: any) => c.owner.toLowerCase() === signer.toLowerCase());
    const rows = queue.map((t, i) => {
      const n = (t.confirmations || []).length, need = t.confirmationsRequired ?? info.threshold;
      const what = t.dataDecoded?.method || (t.data && t.data !== "0x" ? "contract call" : `send ${Number(BigInt(t.value)) / 1e18} ETH`);
      return `<li><b>#${esc(t.nonce)}</b> ${esc(what)} → ${esc(short(t.to))} <span class="fine">${n}/${need} signed</span>
        ${!isOwner(signer) ? "" : mine(t) ? `<span class="good">wedgie signed</span>` : `<button class="btn btn-green" data-sign="${i}"${!key || asking ? " disabled" : ""}>Sign with wedgie</button>`}
        ${n < need ? `<button class="btn btn-sm" data-wsign="${i}">Sign with wallet</button>` : `<button class="btn" data-exec="${i}">Execute</button>`}</li>`;
    }).join("");
    box.innerHTML = `<h2>3. Waiting to sign</h2>${rows ? `<ul class="safe-list">${rows}</ul>` : `<p class="fine">Nothing waiting.</p>`}<p><button class="btn" id="s-refresh">Refresh</button></p>`;
    $("s-refresh").onclick = () => load();
    box.querySelectorAll<HTMLButtonElement>("[data-sign]").forEach((b) => b.onclick = () => signQueued(queue[+b.dataset.sign!]));
    box.querySelectorAll<HTMLButtonElement>("[data-wsign]").forEach((b) => b.onclick = () => signWallet(queue[+b.dataset.wsign!]));
    box.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach((b) => b.onclick = () => execute(queue[+b.dataset.exec!]));
  }

  /** The wedgie signs t (the Transaction Service's fields); the page checks it got the same hash. */
  async function wedgieSign(t: E.SafeTx) {
    if (!wedgie) throw new Error("No wedgie running the Safe signer.");
    asking = true; paintQueue();
    say("Look at the wedgie: check what it shows, then A to sign (Y says no).");
    try {
      const tx = { chainId: chain, safe: safeAddr, to: t.to, value: String(t.value), data: t.data || "0x", operation: t.operation,
        safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice), gasToken: t.gasToken || Z,
        refundReceiver: t.refundReceiver || Z, nonce: +t.nonce };      // only the fields: the wedgie reads one line of at most 6 KB
      const g = await W.withRepl(wedgie, (r) => r.request({ type: "safe_sign", tx }, 200000));
      if (g.type === "refused") throw new Error("The wedgie said no.");
      if (g.type !== "safe_sig") throw new Error(g.error || "The wedgie didn't sign.");
      if (g.safeTxHash !== E.safeTxHash(chain, safeAddr, t)) throw new Error("The wedgie signed a different hash: not sent.");
      return g as E.WedgieSig & { safeTxHash: string };
    } finally { asking = false; }
  }

  async function signQueued(t: any) {
    try {
      const g = await wedgieSign(t);
      if (g.safeTxHash !== t.safeTxHash) throw new Error("Safe's API has a different hash for this one: not sent.");
      say("Sending the signature to Safe.");
      await post(`${api(chain)}/multisig-transactions/${t.safeTxHash}/confirmations/`, { signature: E.safeSignature(signer, g) });
      await load();
      say("Signed. It shows in Safe{Wallet} too.");
    } catch (e: any) { say(e?.message || String(e), true); paintQueue(); }
  }

  async function signWallet(t: any) {
    try {
      const from = await wallet(chain);
      if (!isOwner(from)) throw new Error(`This wallet (${short(from)}) isn't an owner of this Safe.`);
      const sig = await walletSig(chain, safeAddr, t);
      await post(`${api(chain)}/multisig-transactions/${t.safeTxHash}/confirmations/`, { signature: sig.signature });
      await load();
      say("Signed with your wallet.");
    } catch (e: any) { say(e?.message || String(e), true); }
  }

  /** Every owner's signature from Safe's API, packed; a browser wallet sends it (and pays the gas). */
  async function execute(t: any) {
    try {
      if (+t.nonce !== +info.nonce) throw new Error(`#${info.nonce} runs first: a Safe runs its transactions in order.`);
      const sigs = (t.confirmations || []).map((c: any) => ({ owner: c.owner,
        signature: c.signature || E.hex(E.cat(E.aword(c.owner), E.word(0), new Uint8Array([1]))) }));   // an approveHash on chain
      await send(chain, safeAddr, E.execData(t, E.packSignatures(sigs)), say);
      await load();
      say("Done: it ran.");
    } catch (e: any) { say(e?.message || String(e), true); }
  }

  // ---- a new one, signed by the wedgie and put in the queue ----
  function paintNew() {
    const box = $("s-new");
    box.hidden = !(info && key);
    if (box.hidden) return;
    box.innerHTML = `<h2>4. New transaction</h2>
      <p><input id="n-to" placeholder="to 0x…" size="44" spellcheck="false"></p>
      <p><input id="n-eth" placeholder="ETH (0)" size="12"> <input id="n-data" placeholder="data 0x (optional)" size="28" spellcheck="false"></p>
      <p><button class="btn btn-green" id="n-go"${asking ? " disabled" : ""}>Sign with wedgie and queue it</button></p>`;
    $("n-go").onclick = propose;
  }

  async function propose() {
    const to = ($("n-to") as HTMLInputElement).value.trim(), amt = ($("n-eth") as HTMLInputElement).value.trim() || "0";
    const data = ($("n-data") as HTMLInputElement).value.trim() || "0x";
    if (!E.isAddress(to)) { say("The to address isn't an address.", true); return; }
    if (!/^\d*\.?\d*$/.test(amt)) { say("The ETH amount isn't a number.", true); return; }
    const [w, f = ""] = amt.split(".");
    const value = (BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18))).toString();
    const nonce = nextNonce();
    const t: E.SafeTx = { to: E.checksum(to), value, data, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: Z, refundReceiver: Z, nonce };
    try {
      E.bytes(data);
      const g = await wedgieSign(t);
      say("Putting it in the Safe's queue.");
      await post(`${api(chain)}/safes/${safeAddr}/multisig-transactions/`, { ...t, contractTransactionHash: g.safeTxHash,
        sender: signer, signature: E.safeSignature(signer, g), origin: "wedgie.dev/safe" });
      await load();
      say("Queued with the wedgie's signature.");
    } catch (e: any) { say(e?.message || String(e), true); paintNew(); }
  }

  W.onChange(paintWedgie);
  if (W.armed()) W.start();
  paintAll();
  if (safeAddr) load();
}
