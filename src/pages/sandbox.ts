// /sandbox: paste a transaction (or a transaction hash), see how a wedgie shows it. A wedgie runs in this tab
// (chip/sandbox.ts: the real firmware and Safe Signer on a virtual RP2040) and gets the transaction the way /safe
// sends one: with the clear-signing bundle for it (safe/clear.ts, from public/clear/<tag>). Every page it shows
// lands here, the exact pixels. Its stand-in chip can't sign. The same pages for every registry test: /clear.
import "./sandbox.css";
import * as Clear from "../safe/clear";

const CHAINS: [number, string][] = [[1, "Ethereum"], [8453, "Base"], [10, "Optimism"], [42161, "Arbitrum"], [137, "Polygon"],
  [56, "BNB Chain"], [100, "Gnosis"], [43114, "Avalanche"], [42220, "Celo"]];
const Z = "0x" + "0".repeat(40), SAFE = "0x" + "5a".repeat(20);

export function sandbox(main: HTMLElement) {
  main.innerHTML = `
  <section class="sandbox">
    <h1>Clear signing sandbox</h1>
    <p>Paste a transaction. A wedgie running in this tab shows it, page by page: the real firmware and Safe Signer, the exact pixels. It can't sign.</p>
    <p class="fine">Every test transaction in the public registry, already run: <a href="/clear/">wedgie.dev/clear</a>.</p>
    <div class="sb-form">
      <div class="sb-row">
        <label>Chain<select id="sb-chain">${CHAINS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("")}</select></label>
        <label>Transaction hash (optional)<input id="sb-hash" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
        <button class="btn btn-sm" id="sb-load">Load it</button>
      </div>
      <div class="sb-two">
        <label>To<input id="sb-to" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
        <label>Value (wei)<input id="sb-value" value="0" spellcheck="false" autocomplete="off"></label>
      </div>
      <label>Data<textarea id="sb-data" placeholder="0x…" spellcheck="false"></textarea></label>
      <div class="sb-ex" id="sb-ex"><b>Try one:</b></div>
      <div class="sb-go">
        <button class="btn btn-green" id="sb-run" disabled>Show it on a wedgie</button>
        <div class="sb-bar" id="sb-bar"><div id="sb-fill"></div></div>
        <span class="sb-say" id="sb-say">Starting a wedgie</span>
      </div>
    </div>
    <div class="sb-pages" id="sb-pages"></div>
  </section>`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const chain = $<HTMLSelectElement>("sb-chain"), hash = $<HTMLInputElement>("sb-hash"), to = $<HTMLInputElement>("sb-to"),
    value = $<HTMLInputElement>("sb-value"), data = $<HTMLTextAreaElement>("sb-data"), runBtn = $<HTMLButtonElement>("sb-run");
  const say = (text: string, bad = false) => { $("sb-say").textContent = text; $("sb-say").classList.toggle("bad", bad); };
  let hello: any = null, none = false, n = 0, pages = 0, running = false, live: HTMLCanvasElement | null = null, operation = 0;

  const draw = (c: HTMLCanvasElement, buf: ArrayBuffer) => {       // 240x240 RGB565, big-endian
    const f = new Uint8Array(buf), ctx = c.getContext("2d")!, img = ctx.createImageData(240, 240);
    for (let i = 0; i < 57600; i++) {
      const v = (f[2 * i] << 8) | f[2 * i + 1];
      img.data[4 * i] = (v >> 11) << 3; img.data[4 * i + 1] = ((v >> 5) & 63) << 2; img.data[4 * i + 2] = (v & 31) << 3; img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
  const canvas = (cls = "") => { const c = document.createElement("canvas"); c.width = c.height = 240; c.className = cls; return c; };

  const worker = new Worker(new URL("../chip/sandbox.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.t === "boot") $("sb-fill").style.width = m.pct + "%";
    else if (m.t === "ready") { hello = m.hello; $("sb-bar").hidden = true; say("Ready"); runBtn.disabled = false; (window as any).sandbox.ready = true; }
    else if (m.t === "frame" && live) draw(live, m.buf);
    else if (m.t === "page" && m.n === n) {
      const c = canvas(); draw(c, m.buf); c.title = `Page ${++pages}`;
      $("sb-pages").insertBefore(c, live);
    } else if (m.t === "done" && m.n === n) {
      live?.remove(); live = null; running = false; runBtn.disabled = false;
      if (pages) say(`${none ? "No descriptor for this call. " : ""}${pages} page${pages === 1 ? "" : "s"}, ${m.secs} s on the wedgie`, none);
      else say(m.answer?.error ? `The wedgie said: ${m.answer.error}` : "The wedgie showed nothing", true);
      (window as any).sandbox.done = n;
    } else if (m.t === "error") { live?.remove(); live = null; running = false; runBtn.disabled = !hello; say(m.error, true); }
  };
  worker.onerror = () => say("The wedgie couldn't start in this browser", true);
  worker.postMessage({ t: "boot" });
  (window as any).sandbox = { ready: false, done: 0 };       // for tools/loadprobe.mjs and agents

  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(`/api/rpc?chain=${chain.value}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()).result;
  };
  $("sb-load").onclick = async () => {
    const h = hash.value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) { say("That isn't a transaction hash", true); return; }
    say("Looking it up");
    const t = await rpc("eth_getTransactionByHash", [h]).catch(() => null);
    if (!t) { say("No such transaction on that chain", true); return; }
    if (!t.to) { say("That one creates a contract: nothing to read", true); return; }
    to.value = t.to; value.value = BigInt(t.value).toString(); data.value = t.input; operation = 0;
    say(hello ? "Ready" : "Starting a wedgie");
  };

  runBtn.onclick = async () => {
    if (running || !hello) return;
    const t = to.value.trim(), d = data.value.replace(/\s+/g, "") || "0x", v = value.value.trim() || "0";
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) { say("To: an address, 0x and 40 hex digits", true); return; }
    if (!/^0x([0-9a-fA-F]{2})*$/.test(d)) { say("Data: hex, starting 0x", true); return; }
    if (!/^\d+$/.test(v)) { say("Value: a whole number of wei", true); return; }
    running = true; runBtn.disabled = true; pages = 0; n++;
    $("sb-pages").innerHTML = "";
    live = canvas("live"); live.title = "The wedgie's screen now"; $("sb-pages").append(live);
    const tx = { chainId: Number(chain.value), safe: SAFE, to: t, value: v, data: d, operation, safeTxGas: "0", baseGas: "0", gasPrice: "0",
      gasToken: Z, refundReceiver: Z, nonce: 3 };
    say("Finding its descriptor");
    const clear = hello.safe_clear ? await Clear.bundle(hello.safe_clear, tx.chainId, tx).catch(() => null) : null;
    none = !clear && d.length > 2;
    say("The wedgie is reading it");
    worker.postMessage({ t: "run", n, tx, clear });
  };

  fetch("/sandbox/examples.json").then((r) => r.json()).then((list: any[]) => {
    for (const c of list) {
      const b = document.createElement("button"); b.className = "btn btn-sm"; b.textContent = c.name.replace(/, a MultiSend.*$/, "");
      b.onclick = () => { chain.value = String(c.chainId); to.value = c.to; value.value = String(c.value || "0"); data.value = c.data; operation = c.operation || 0; hash.value = ""; };
      $("sb-ex").append(b);
    }
  }).catch(() => {});
  for (const el of [to, data]) el.addEventListener("input", () => { operation = 0; });
}
