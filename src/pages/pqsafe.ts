// /pqsafe: a Safe whose only owner is an SLH-DSA key made on a wedgie (the plan: /pq). Make the key, make
// the Safe, put ETH in, send it. A test: the contracts (clawdbotatg/wedgie-pq, contracts/) are not audited.
// The key: 48 bytes the secure chip derives from a seed in its data slot 9 (the seed never leaves the chip;
// the derived key is in the wedgie's memory while it signs). Signing takes the wedgie over (full control)
// each time; the signer (/device/pq_slh.mpy) is copied on and removed after. A browser wallet pays the gas.
import * as W from "../serial/wedgies";
import * as E from "../safe/eth";
import { takeOver } from "../serial/install";
import { busy, writeFile } from "../serial/files";
import type { Repl } from "../serial/repl";

/** SlhSafeFactory (wedgie-pq contracts/src), the same address on both chains. */
const FACTORY = "0xc7bdA0EF354ff3F547c0DFa15Cd56cfdD6746f62";
const CHAINS: Record<number, { name: string; scan: string }> = {
  1: { name: "Ethereum", scan: "https://etherscan.io" },
  8453: { name: "Base", scan: "https://basescan.org" },
};
const SIG = 17088;          // SLH-DSA-SHA2-128f
const FILE = "/pq_slh.mpy";
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
  <li>The key's seed is in the secure chip but not locked. If something rewrites that slot, the key is gone and so is the Safe's money.</li>
  <li>Each step on the wedgie takes it over: hold green for 3 seconds. An app you install comes next.</li>
  <li>The wedgie's question is black, not white: that is PQ Safe Signer, not the usual Safe Signer.</li>
  <li>The wedgie shows what this page tells it. It does not check the transaction itself yet.</li>
  <li>Your browser wallet pays the gas. It can't move the Safe's money.</li>
  <li>A send is about 2.75M gas: the signature is 17 KB.</li>
</ul>`;

// On the wedgie. Two 32-byte derives (a size every Trust M does); the first 48 bytes are SK.seed, SK.prf, PK.seed.
const PY = String.raw`
import gc, binascii, optiga
import pq_slh as _S
_D = optiga.DATA[9]
def _ready():
    m = optiga.Chip().metadata(_D)
    print('@ready %d' % (1 if m.get(0xE8) == b"\x21" and m.get(0xD1) == b"\xff" else 0))
def _setup():
    c = optiga.Chip()
    c.write(_D, c.random(64), erase=True)
    c.set_metadata(_D, {0xE8: b"\x21", 0xD1: b"\xff", 0xD3: b"\x00"})
def _parts():
    c = optiga.Chip()
    return c.derive(_D, 32, b"slh-dsa safe owner 0 a", method="prf256") + c.derive(_D, 32, b"slh-dsa safe owner 0 b", method="prf256")
def _pub():
    k = _parts(); st = bytearray(_S.size()); root = bytearray(16)
    _S.root(st, 1, k[:16], k[32:48], root)
    print('@key "%s"' % binascii.hexlify(k[32:48] + root).decode())
def _ask(q, lines, yes):
    # PQ Safe Signer's own look: a black screen, so it can't be taken for the usual Safe Signer's white one
    import time, lcd, ui
    d = lcd.LCD(); k = lcd.Keys(physical=True); k.pressed()
    d.fill(ui.INK)
    ui.band(d)
    d.center_text("PQ SAFE SIGNER", 46, ui.GREEN)
    y = ui.title(d, q, 68, 2, ui.WHITE) + 12
    for s in lines:
        d.center_text(s[:28], y, ui.GREY)
        y += 14
    ui.buttons(d, yes, "no")
    d.show()
    ui.drawn = time.ticks_ms()
    print('@yes %d' % (1 if ui.wait(k, 120000) else 0))
def _sign(msg, title):
    gc.collect()
    p = _parts(); st = bytearray(_S.size()); root = bytearray(16); r = bytearray(16)
    part = bytearray(608)
    def out(b):
        for i in range(0, len(b), 512):
            print('@sig "%s"' % binascii.hexlify(b[i:i + 512]).decode())
    _S.root(st, 1, p[:16], p[32:48], root)
    _S.begin(st, 1, p[:16], p[16:32], p[32:48], root, msg, r)
    out(r)
    for i in range(33):
        out(memoryview(part)[:_S.fors(st, i, part)])
    for i in range(22):
        _ins(title, "part %d of 23" % (i + 2), (i + 1) / 23)
        _S.layer(st, part)
        out(memoryview(part)[:608])
`;

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

  function paint() {
    $("ps-text").innerHTML = note;
    const ws = W.wedgies(), off = working ? " disabled" : "";
    const wedgieBtns = (label: string, act: string, green = true) => ws.length ? ws.map((w) =>
      `<button class="btn${green ? " btn-green" : " btn-sm"}" data-act="${act}" data-k="${w.key}"${working || w.state !== "ready" ? " disabled" : ""}>${label} ${esc(w.short || "…")}</button>`).join(" ")
      : `<span class="fine">No wedgie yet. <a href="/connect">Connect</a> one first if this browser hasn't.</span>`;
    let h = "";
    if (!saved) {
      h = `<p><b>1. The key.</b> Your wedgie makes it. The first time it writes a new secret into its secure chip.</p><p>${wedgieBtns("Make the key on", "key")}</p>`;
    } else {
      const c = CHAINS[saved.chain];
      h = `<p class="fine pq-hex">Key from wedgie ${esc(saved.wedgie)}: ${esc(saved.pk)} · <a href="#" data-act="forget">forget it</a></p>
        <p>${Object.entries(CHAINS).map(([id, x]) => `<button class="btn btn-sm${+id === saved!.chain ? " btn-green" : ""}" data-act="chain" data-chain="${id}"${off}>${x.name}</button>`).join(" ")}</p>`;
      if (!safe || safe.chain !== saved.chain) h += `<p class="fine">Looking on ${c.name}…</p>`;
      else {
        const link = `<a class="pq-hex" href="${c.scan}/address/${safe.addr}" target="_blank" rel="noopener">${safe.addr}</a>`;
        if (!safe.made) h += `<p><b>2. The Safe.</b> It will be at ${link}. One transaction makes it and its owner contract.</p><p><button class="btn btn-green" data-act="make"${off}>Make the Safe on ${c.name}</button></p>`;
        else {
          h += `<p><b>Your Safe:</b> ${link}<br><b>${E.fmt(safe.balance, 18)} ETH</b> · owner contract <a class="pq-hex" href="${c.scan}/address/${safe.owner}" target="_blank" rel="noopener">${short(safe.owner)}</a> · <a href="#" data-act="look">refresh</a></p>
            <p><b>3. Put ETH in.</b> Send to the address above from anywhere, or: <button class="btn btn-sm" data-act="fund"${off}>Put 0.0005 ETH in</button></p>
            <p><b>4. Send.</b></p>
            <p><input id="ps-to" placeholder="to 0x…" size="44" value="${esc((document.getElementById("ps-to") as HTMLInputElement | null)?.value || "")}"> <input id="ps-amt" placeholder="ETH" size="10" value="${esc((document.getElementById("ps-amt") as HTMLInputElement | null)?.value || "")}"></p>
            <p>${wedgieBtns("Sign on", "send")}</p>`;
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
      else if (act === "key" && w) job(() => makeKey(w));
      else if (act === "make") job(make);
      else if (act === "fund") job(fund);
      else if (act === "send" && w) job(() => sendFrom(w));
    });
  }
  const refresh = () => look().then(paint, (e) => { say(`<b class="bad">Couldn't read the chain:</b> ${esc(e?.message || String(e))}`); });

  async function job(f: () => Promise<void>) {
    working = true; paint();
    try { await f(); } catch (e: any) { say(`<b class="bad">It didn't work:</b> ${esc(e?.message || String(e))}`); }
    working = false; paint();
    await refresh();
  }

  /** Take the wedgie over, copy the signer on, run f, remove the signer, let go. */
  async function onWedgie<T>(w: W.Wedgie, question: string, f: (r: Repl, got: Record<string, any>) => Promise<T>): Promise<T> {
    const got = await fetch("/device/pq_slh.mpy", { cache: "no-cache" });
    if (!got.ok) throw new Error("the signer didn't load");
    const mpy = new Uint8Array(await got.arrayBuffer());
    return W.withRepl(w, async (r) => {
      const seen: Record<string, any> = { sig: "" };
      r.onLine = (t, v) => {
        if (t === "sig") { seen.sig += v; say(`Signing: ${Math.round((seen.sig.length / 2 / SIG) * 100)}%. About 10 seconds.`); }
        else seen[t] = v;
      };
      await takeOver(r, (s) => { if (s) say(`<b>${esc(s)}.</b> It asks: ${esc(question)}?`); }, question, "PQ Safe Signer");
      try {
        say("Copying the signer to the wedgie.");
        await writeFile(r, FILE, mpy, { span: [0, 0.3] });
        await r.exec(PY, 10000);
        return await f(r, seen);
      } finally {
        await r.exec(`import os\ntry:\n    os.remove(${JSON.stringify(FILE)})\nexcept OSError:\n    pass`, 8000).catch(() => {});
        await r.leave({ reset: false });
      }
    });
  }
  const yes = async (r: Repl, seen: Record<string, any>, q: string, lines: string[], word: string) => {
    delete seen.yes;
    await r.exec(`_ask(${JSON.stringify(q)}, ${JSON.stringify(lines)}, ${JSON.stringify(word)})`, 130000);
    if (seen.yes !== 1) throw new Error("the wedgie said no");
  };

  async function makeKey(w: W.Wedgie) {
    const pk = await onWedgie(w, "Make a post-quantum key", async (r, seen) => {
      await r.exec("_ready()", 15000);
      if (seen.ready !== 1) {
        say("<b>Look at the wedgie.</b> It asks before it writes the new secret.");
        await yes(r, seen, "Make a new key?", ["It writes a new secret", "into the secure chip."], "make it");
        await busy(r, "Making the key", "writing the secret");
        await r.exec("_setup()", 30000);
      }
      say("Making the key.");
      await r.exec("_pub()", 60000);
      if (!/^[0-9a-f]{64}$/.test(seen.key || "")) throw new Error("the wedgie gave no key");
      return seen.key as string;
    });
    saved = { pk, wedgie: w.short || "", chain: saved?.chain || 1 };
    keep();
    say("<b>The key is made.</b> The wedgie is back on its app, locked.");
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
    const sigHex = await onWedgie(w, "Sign with a post-quantum key", async (r, seen) => {
      say("Checking it is the same key.");
      await r.exec("_pub()", 60000);
      if (seen.key !== s.pk) throw new Error("this wedgie has a different key");
      say(`<b>Look at the wedgie.</b> It asks: Send ${esc(amt)} ETH?`);
      await yes(r, seen, `Send ${amt} ETH?`, ["to " + short(E.checksum(to)), "on " + c.name, "from your post-quantum Safe"], "sign");
      await busy(r, "Signing", "starting");
      say("Signing. About 10 seconds.");
      await r.exec(`_sign(bytes.fromhex("${E.hex(msg).slice(2)}"), "Signing")`, 180000);
      return seen.sig as string;
    });
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
