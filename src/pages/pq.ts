// /pq: the post-quantum plan, short. What a quantum computer breaks on a wedgie, the fix (hash signatures),
// what already runs on a real wedgie and what's left. The long version: docs/RESEARCH-ROTATING-KEY.md and
// clawdbotatg/wedgie-pq (the numbers here are from its README). Research: nothing here is shipped.
// "Try it": a plugged-in wedgie makes an SLH-DSA signature with a throwaway key and this page checks it
// (src/pq/slh.ts). The signer is /device/pq_slh.mpy, built from wedgie-pq mp/slh/slh.c; it is copied to
// the wedgie for the test and removed after. Nothing is kept on the wedgie, and no key of its own is used.
import * as W from "../serial/wedgies";
import { takeOver } from "../serial/install";
import { busy, writeFile } from "../serial/files";
import type { SlhSet } from "../pq/slh";
const UPDATED = "November 25, 2026";
const PQ = "https://github.com/clawdbotatg/wedgie-pq";
const DOC = "https://github.com/clawdbotatg/wedgie-dev/blob/main/docs/RESEARCH-ROTATING-KEY.md";
const out = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

const PAGE = `
<h1>Post-quantum plan</h1>
<p class="fine">Updated ${UPDATED} · research, not shipped</p>
<p>A big enough quantum computer could work out a wedgie's key from any signature it has made. None can today. A Safe should outlast the day one can. This is how we plan to get there.</p>

<h2>Today</h2>
<ul>
  <li>A wedgie owns a Safe with a P-256 key in its secure chip.</li>
  <li>A quantum computer breaks P-256, the same way it breaks Ethereum's own keys.</li>
  <li>The secure chip has no post-quantum signature and will never get one.</li>
</ul>

<h2>The fix: hash signatures</h2>
<p>A quantum computer can't undo a hash. So the wedgie signs with hashes alone (WOTS one-time signatures), the same family Ethereum's researchers picked for validators.</p>
<ul>
  <li><b>One key per signature.</b> Each signature also names the next key, so the key changes with every transaction.</li>
  <li><b>The seed sits in the secure chip.</b> Every key is made from it. A lock stops anything reading it. That lock is not set yet.</li>
  <li><b>No key signs twice.</b> Key numbers come from a counter in the chip that only goes up. The firmware has to follow it: the chip makes any key the firmware asks for.</li>
  <li><b>The main chip does the hashing.</b> The secure chip can't do it. One key sits in memory for a moment. Once its transaction lands, the contract takes only the next key. A wedgie has no Wi-Fi or Bluetooth.</li>
  <li><b>On chain,</b> the Safe's owner is a small contract that holds the hash of the next key and checks each signature.</li>
</ul>

<h2>One-time keys: what works</h2>
<p>Measured on a real wedgie in October 2026, with Poseidon2 hashes (the kind the proof under "What's left" needs). The signature matches the reference code.</p>
<table>
  <tr><td>Sign</td><td>0.55 s</td></tr>
  <tr><td>Check, on the wedgie</td><td>0.59 s</td></tr>
  <tr><td>Sign with the seed in the secure chip, next key included</td><td>6.4 s</td></tr>
  <tr><td>Signature size</td><td>2 KB</td></tr>
</table>
<p>The simple contract above would use SHA-256. That version is not built or timed yet.</p>
<p>The code: ${out(PQ, "clawdbotatg/wedgie-pq")}. A prototype, not audited. Don't put money on it.</p>

<h2>The other way: SLH-DSA</h2>
<p>SLH-DSA is the standard hash signature (NIST FIPS 205). It is the same chains, stacked into a big tree.</p>
<ul>
  <li><b>One key, for good.</b> It signs as often as you like. No counter, no next key, nothing for the firmware to get wrong.</li>
  <li><b>The contract only checks.</b> It holds one key and the address never changes.</li>
  <li><b>The cost:</b> bigger signatures and slower signing.</li>
</ul>
<p>Measured on a real wedgie in November 2026. OpenSSL accepts the signatures.</p>
<table>
  <tr><td></td><td>Fast set</td><td>Small set</td></tr>
  <tr><td>Signature</td><td>17 KB</td><td>7.9 KB</td></tr>
  <tr><td>Make the key, once</td><td>0.35 s</td><td>22 s</td></tr>
  <tr><td>Sign</td><td>8.2 s</td><td>170 s</td></tr>
  <tr><td>Gas for a Safe to send</td><td>2.75M</td><td>1.1M</td></tr>
</table>
<p>The hashing is plain C, not tuned yet.</p>
<p>The <a href="https://github.com/clawdbotatg/wedgie-pq/blob/master/contracts/src/SlhSigner.sol" target="_blank" rel="noopener">owner contract</a> is written: a Safe owner that is an SLH-DSA key. A Safe with it as its only owner sent ETH on a copy of Base. Not audited. No wedgie has sent real money with it yet.</p>

<h2>Try it</h2>
<div class="pq-try">
  <p id="pq-text">Plug in a wedgie and it signs with SLH-DSA right here. It uses a throwaway key made in this browser, not the wedgie's own. No wedgie? <a href="/virtual" target="_blank">The virtual one</a> works too.</p>
  <div id="pq-list"></div>
  <div id="pq-out"></div>
</div>

<h2>What's left</h2>
<ol>
  <li>Pick one: one-time keys or SLH-DSA.</li>
  <li>The owner contract and its tests. SLH-DSA's is written.</li>
  <li>Lock the seed in the secure chip. That write is permanent.</li>
  <li>An address that stays the same when the key changes.</li>
  <li>Safe Signer and <a href="/safe">/safe</a>.</li>
  <li>An audit.</li>
</ol>
<p>Later: one proof for all of a Safe's owners (a STARK over their hash signatures), so who signed stays private.</p>

<h2>Still not quantum-safe after that</h2>
<ul>
  <li>The Safe's other owners. Every owner needs this.</li>
  <li>The account that pays gas. It holds only gas money.</li>
  <li>Bad firmware. It could ask the chip for every future key. Our firmware and app updates are signed with P-256, so a post-quantum wedgie needs hash-signed updates, or no updates at all.</li>
</ul>

<h2>More</h2>
<p>${out(DOC, "The research notes")}. Ideas from ${out("https://x.com/iamnickdodson/status/2107988457297514883", "Nick Dodson")} (a new key every transaction) and ${out("https://x.com/rstormsf/status/2108218447998124488", "Roman Storm")} (hash signatures inside a hash-based proof).</p>
<p>Questions: <a href="mailto:wedgie@buidlguidl.com">wedgie@buidlguidl.com</a></p>`;

// What the wedgie runs. It prints the key's root, then the signature in pieces (@sig), then the times.
// Only the calls into the signer are timed, not the printing or the screen.
const SIGN_PY = `
import time, binascii, gc
import pq_slh as _S
def _pq(set_, sk_seed, sk_prf, pk_seed, msg, title):
    hp, d, a, k = ((9, 7, 12, 14), (3, 22, 6, 33))[set_]
    gc.collect()
    st = bytearray(_S.size()); root = bytearray(16); r = bytearray(16)
    part = bytearray(max(a + 1, 35 + hp) * 16)      # the biggest piece: 704 bytes. RAM is tight
    td = time.ticks_diff; now = time.ticks_ms
    def out(b):
        for i in range(0, len(b), 512):
            print('@sig "%s"' % binascii.hexlify(b[i:i + 512]).decode())
    t = now(); _S.root(st, set_, sk_seed, pk_seed, root); key_ms = td(now(), t)
    print('@key {"root": "%s", "ms": %d}' % (binascii.hexlify(root).decode(), key_ms))
    t = now(); _S.begin(st, set_, sk_seed, sk_prf, pk_seed, root, msg, r); ms = td(now(), t)
    out(r)
    for i in range(k):
        t = now(); n = _S.fors(st, i, part); ms += td(now(), t)
        out(memoryview(part)[:n])
    n = (35 + hp) * 16
    for i in range(d):
        _ins(title, "part %d of %d" % (i + 2, d + 1), 0.05 + 0.95 * (i + 1) / (d + 1))
        t = now(); _S.layer(st, part); ms += td(now(), t)
        out(memoryview(part)[:n])
        print('@part %d' % (i + 2))
    print('@done {"ms": %d}' % ms)
`;
const FILE = "/pq_slh.mpy";
const SETS: Record<SlhSet, { n: number; name: string; takes: string; ms: number }> = {
  "128f": { n: 1, name: "Sign", takes: "about 10 seconds", ms: 120000 },
  "128s": { n: 0, name: "Small signature", takes: "about 3 minutes", ms: 900000 },
};
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const py = (b: Uint8Array) => `bytes.fromhex("${hex(b)}")`;
const secs = (ms: number) => (ms / 1000).toFixed(ms < 10000 ? 2 : 0) + " s";

export function pq(main: HTMLElement) {
  main.innerHTML = `<section class="test-page legal-page">${PAGE}</section>`;
  const $ = (id: string) => document.getElementById(id)!;
  let working = false;

  function paint() {
    const ws = W.wedgies();
    $("pq-list").innerHTML = ws.length ? ws.map((w) => `<p>${(Object.keys(SETS) as SlhSet[]).map((s) =>
      `<button class="btn${s === "128f" ? " btn-green" : " btn-sm"}" data-k="${w.key}" data-set="${s}"${working || w.state !== "ready" ? " disabled" : ""}>${SETS[s].name} on ${esc(w.short || "…")}</button>`).join(" ")}
      <span class="fine">${esc(w.state === "ready" ? `${w.board || ""} · ${w.firmware || ""}` : w.state === "error" ? w.error || "error" : w.state)}</span></p>`).join("")
      : `<p class="fine">No wedgie yet. <a href="/connect">Connect</a> one first if this browser hasn't.</p>`;
    $("pq-list").querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.onclick = () => run(ws.find((w) => w.key === +b.dataset.k!)!, b.dataset.set as SlhSet));
  }

  async function run(w: W.Wedgie, set: SlhSet) {
    working = true; paint();
    const S = SETS[set], title = "Signing";
    const say = (h: string) => { $("pq-text").innerHTML = h; };
    $("pq-out").innerHTML = "";
    let sig = "", key: { root: string; ms: number } | null = null, done: { ms: number } | null = null, err = "";
    try {
      const slh = await import("../pq/slh");
      const got = await fetch("/device/pq_slh.mpy", { cache: "no-cache" });
      if (!got.ok) throw new Error("the signer didn't load");
      const mpy = new Uint8Array(await got.arrayBuffer());
      const k = slh.testKey(), msg = crypto.getRandomValues(new Uint8Array(32)), m = slh.wrap(msg);
      const parts = slh.sigSize(set);
      await W.withRepl(w, async (r) => {
        r.onLine = (t, v) => {
          if (t === "sig") { sig += v; say(`Signing: ${Math.round((sig.length / 2 / parts) * 100)}%. It takes ${S.takes}.`); }
          else if (t === "key") key = v;
          else if (t === "done") done = v;
        };
        await takeOver(r, (s) => { if (s) say(`<b>${esc(s)}.</b> It asks: Run a signature test?`); }, "Run a signature test", title);
        try {
          say("Copying the signer to the wedgie.");
          await writeFile(r, FILE, mpy, { span: [0, 0.05] });     // one screen, one bar: a second screen ran an RP2040 out of memory
          await busy(r, title, "making the key");
          say(`Signing. It takes ${S.takes}.`);
          await r.exec(SIGN_PY, 10000);
          await r.exec(`_pq(${S.n}, ${py(k.skSeed)}, ${py(k.skPrf)}, ${py(k.pkSeed)}, ${py(m)}, ${JSON.stringify(title)})`, S.ms);
        } finally {
          await r.exec(`import os\ntry:\n    os.remove(${JSON.stringify(FILE)})\nexcept OSError:\n    pass`, 8000).catch(() => {});
          await r.leave({ reset: false });       // its app again, locked
        }
      });
      if (!key || !done) throw new Error("the wedgie didn't finish");
      const { root, ms: keyMs } = key as { root: string; ms: number }, signMs = (done as { ms: number }).ms;
      const pk = new Uint8Array([...k.pkSeed, ...unhex(root)]), bytes = unhex(sig);
      const t0 = performance.now(), ok = slh.verify(set, pk, m, bytes), checkMs = performance.now() - t0;
      say(ok ? "<b>Signed, and this browser checked it.</b> The wedgie is back on its app, locked." : `<b class="bad">The signature didn't check.</b> Please tell us: wedgie@buidlguidl.com`);
      $("pq-out").innerHTML = `<table>
        <tr><td>Sign</td><td>${secs(signMs)}</td></tr>
        <tr><td>Make the key</td><td>${secs(keyMs)}</td></tr>
        <tr><td>Signature</td><td>${bytes.length.toLocaleString("en-US")} bytes</td></tr>
        <tr><td>Check, in this browser</td><td>${ok ? "good" : "bad"} · ${secs(checkMs)}</td></tr>
      </table>
      <p class="fine pq-hex">Public key ${hex(pk)}<br>Message ${hex(msg)}<br>Signature ${sig.slice(0, 64)}…</p>
      <p><button class="btn btn-sm" id="pq-dl">Download the signature</button></p>`;
      $("pq-dl").onclick = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ scheme: "SLH-DSA-SHA2-" + set, public_key: hex(pk), message: hex(msg), signature: sig, sign_ms: signMs, key_ms: keyMs, wedgie: w.short }, null, 1)], { type: "application/json" }));
        a.download = `wedgie-slh-dsa-${set}.json`; a.click();
      };
    } catch (e: any) { err = e?.message || String(e); }
    if (err) say(`<b class="bad">It didn't sign:</b> ${esc(err)}.`);
    working = false; paint();
  }

  W.onChange(paint);
  W.start();
  paint();
}
