// /pq: the post-quantum plan, short. What a quantum computer breaks on a wedgie, the fix (hash signatures),
// what already runs on a real wedgie and what's left. The long version: docs/RESEARCH-ROTATING-KEY.md and
// clawdbotatg/wedgie-pq (the numbers here are from its README). Research: nothing here is shipped.
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

<h2>What works</h2>
<p>Measured on a real wedgie in October 2026, with Poseidon2 hashes (the kind the proof under "What's left" needs). The signature matches the reference code.</p>
<table>
  <tr><td>Sign</td><td>0.55 s</td></tr>
  <tr><td>Check, on the wedgie</td><td>0.59 s</td></tr>
  <tr><td>Sign with the seed in the secure chip, next key included</td><td>6.4 s</td></tr>
  <tr><td>Signature size</td><td>2 KB</td></tr>
</table>
<p>The simple contract above would use SHA-256. That version is not built or timed yet.</p>
<p>The code: ${out(PQ, "clawdbotatg/wedgie-pq")}. A prototype, not audited. Don't put money on it.</p>

<h2>What's left</h2>
<ol>
  <li>The owner contract and its tests.</li>
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

export function pq(main: HTMLElement) {
  main.innerHTML = `<section class="test-page legal-page">${PAGE}</section>`;
}
