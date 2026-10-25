// wedgie.dev/clear: /clear lists the dapps, /clear/<dapp>/ shows its transactions as a wedgie shows them, page by page.
// The data: screens/index.json (tools/clear_page.py), one section per descriptor; a section's dapp is its slug up to
// the first "-" (uniswap-v2 -> uniswap). A dapp page's own text (a finding) is in DAPPS below.
const DAPPS = {
  uniswap: { name: "Uniswap" },
  "1inch": {
    name: "1inch",
    finding: `<h2>The screen can show less ETH than the swap sends</h2>
      <p>1inch's swap descriptors show "Amount to Send" from the swap's own description (<code>desc.amount</code>), not
      the ETH the transaction carries (<code>@.value</code>). The router only forces the two to match when a flag is off:
      with <code>_REQUIRES_EXTRA_ETH</code> set it takes <em>any</em> amount above it, and passes all of it to
      <code>caller</code> / <code>executor</code>. Both the flag and that address are hidden by the descriptor.
      So a screen built from the descriptor alone can say 0.04 ETH while the transaction sends 10 ETH to an address you never see.
      Same in V3, V4, V5 and V6 (the code is in each router's verified source).</p>
      <p>A wedgie isn't fooled: Safe Signer always adds the ETH a transaction sends ("+ 0.0041 ETH" on the V6 swap's second page below),
      whatever the descriptor says. A wallet that shows only the descriptor's fields would miss it.</p>
      <p>The fix is one field per payable function: <code>{"path": "@.value", "label": "ETH sent", "format": "amount"}</code>.</p>`,
  },
};
const CHAINS = { 1: ["Ethereum", "etherscan.io"], 56: ["BNB Chain", "bscscan.com"], 8453: ["Base", "basescan.org"], 10: ["Optimism", "optimistic.etherscan.io"], 42161: ["Arbitrum", "arbiscan.io"] };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const dappOf = (s) => s.slug.split("-")[0];
const nameOf = (d, secs) => (DAPPS[d] && DAPPS[d].name) || secs[0].title.split(" ")[0];
const here = location.pathname.replace(/\/+$/, "").split("/")[2] || "";

fetch("/clear/screens/index.json").then((r) => r.json()).then((sections) => {
  const root = document.getElementById("sections");
  const by = {};
  for (const s of sections) (by[dappOf(s)] = by[dappOf(s)] || []).push(s);
  if (!here) {
    const old = sections.find((s) => "#" + s.slug === location.hash);    // an old /clear#uniswap-v2 link
    if (old) { location.replace(`/clear/${dappOf(old)}/${location.hash}`); return; }
    const grid = el("div", "dapps");
    for (const [d, secs] of Object.entries(by)) {
      const a = el("a", "dapp"); a.href = `/clear/${d}/`;
      a.append(el("h2", null, nameOf(d, secs)));
      const n = secs.reduce((k, s) => k + s.cases.length, 0);
      a.append(el("p", null, `${n} transactions · ${secs.map((s) => s.title).join(", ")}`));
      grid.append(a);
    }
    root.append(grid);
    return;
  }
  const secs = by[here];
  if (!secs) { root.textContent = "No screens for this one yet."; return; }
  document.title = `${nameOf(here, secs)}: clear signing on a wedgie`;
  document.querySelector("h1").textContent = `${nameOf(here, secs)} on a wedgie`;
  const back = el("a", "back", "← every dapp"); back.href = "/clear/"; document.querySelector("h1").before(back);
  if (DAPPS[here] && DAPPS[here].finding) { const f = el("div", "finding"); f.innerHTML = DAPPS[here].finding; root.append(f); }
  for (const s of secs) {
    const h = el("h2", null, s.title); h.id = s.slug; root.append(h);
    if (s.note) root.append(el("p", "note", s.note));
    for (const c of s.cases) {
      const card = el("div", "tx");
      card.append(el("h3", null, c.name));
      const [chain, scan] = CHAINS[c.chainId] || ["chain " + c.chainId, null];
      const meta = el("div", "meta", chain + " · ");
      if (scan) { const a = el("a", null, c.to); a.href = `https://${scan}/address/${c.to}`; meta.append(a); } else meta.append(c.to);
      card.append(meta);
      const row = el("div", "pages");
      c.pages.forEach((p, i) => { const img = el("img"); img.src = "/clear/" + p; img.alt = `${c.name}, page ${i + 1} of ${c.pages.length}`; img.loading = "lazy"; row.append(img); });
      card.append(row);
      root.append(card);
    }
  }
  if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
}).catch(() => { document.getElementById("sections").textContent = "Couldn't load the screens."; });
