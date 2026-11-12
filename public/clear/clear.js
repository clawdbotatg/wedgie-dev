// wedgie.dev/clear: every dapp, most used first; /clear/?d=<dapp> (or an old /clear/<dapp>/) shows its transactions as a
// wedgie shows them, page by page; /clear/?show=<verdict> lists every transaction with that verdict.
// The data: screens/all.json (tools/clear_gallery.py: every test transaction in the public registry, on a virtual
// RP2040), and screens/index.json (tools/clear_page.py: sections added by hand, for what isn't in the registry yet).
// A hand section's dapp is its slug up to the first "-" (uniswap-v3 -> uniswap). A dapp's own text is in DAPPS.
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
// A note under a registry file's section.
const NOTES = {
  "registry/uniswap/calldata-UniswapV2Router02.json": "Tokens outside the Uniswap list and CoinGecko's top 1,000 show as unknown, in red.",
  "registry/1inch/calldata-AggregationRouterV3.json": "One test isn't read: its data is too big for one USB line to a wedgie (a wedgie limit to fix).",
};
// Old links to sections that were made by hand, now the registry's own.
const OLD = { "#uniswap-v2": "#UniswapV2Router02", "#uniswap-v3-pr3135": "#UniswapV3SwapRouter", "#1inch-v3": "#AggregationRouterV3",
  "#1inch-v4": "#AggregationRouterV4", "#1inch-v5": "#AggregationRouterV5", "#1inch-v6": "#AggregationRouterV6" };
// A registry file a hand section already shows (ours, with more transactions): its generated section is left out.
const HIDE = ["registry/uniswap/calldata-UniswapV3Router02.json"];
// What a wedgie did with a transaction: [the badge, its class, what it means]. "says" (tools/test_clear.py) compares
// the app's reader with what the registry's test expects; "chip" is the virtual wedgie's own answer.
const VERDICTS = {
  match: ["matches the registry", "good", "Shows exactly what the registry's test expects."],
  onpurpose: ["close match", "good", "Same as the registry's test, except where a wedgie shows less or more on purpose: an address for a name it can't check, a short amount, an unknown token in red."],
  ours: ["our descriptor", "good", "Read with our own descriptor (clawdbotatg/clear-descriptors), in our words."],
  differs: ["differs from the registry", "warn", "A wedgie shows something the registry's test doesn't expect."],
  refused: ["can't read", "bad", "A wedgie can't read this one: the big red page. A still signs."],
  broke: ["broke", "bad", "The app failed on this one. A bug to fix."],
  out: ["not on a wedgie", "off", "A chain Safe Signer doesn't do, or a descriptor the wire format can't carry."],
};
const CHAINS = { 1: ["Ethereum", "etherscan.io"], 56: ["BNB Chain", "bscscan.com"], 8453: ["Base", "basescan.org"], 10: ["Optimism", "optimistic.etherscan.io"], 42161: ["Arbitrum", "arbiscan.io"], 137: ["Polygon", "polygonscan.com"], 100: ["Gnosis", "gnosisscan.io"], 43114: ["Avalanche", "snowtrace.io"], 42220: ["Celo", "celoscan.io"] };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const q = new URLSearchParams(location.search);
const here = q.get("d") || location.pathname.replace(/\/+$/, "").split("/")[2] || "";
const show = q.get("show");
const num = (n) => n.toLocaleString("en-US");
const verdict = (c) => c.chip === "fail" ? "broke" : c.says || (c.chip === "none" || c.chip === "missing" ? "out" : "");
const pretty = (d) => (DAPPS[d] && DAPPS[d].name) || d.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase());

function card(c, where) {
  const box = el("div", "tx");
  const h = el("h3", null, c.name);
  const v = VERDICTS[verdict(c)];
  if (v) { const b = el("span", "badge " + v[1], v[0]); b.title = v[2]; h.append(" ", b); }
  box.append(h);
  const [chain, scan] = CHAINS[c.chainId] || ["chain " + c.chainId, null];
  const meta = el("div", "meta", (where ? where + " · " : "") + chain + " · ");
  if (scan) { const a = el("a", null, c.to); a.href = `https://${scan}/address/${c.to}`; meta.append(a); } else meta.append(c.to);
  if (c.use) meta.append(` · ${num(c.use)} mainnet txs last week`);
  box.append(meta);
  if (c.why) box.append(el("div", "why", c.why));
  if (c.pages.length) {
    const row = el("div", "pages");
    c.pages.forEach((p, i) => { const img = el("img"); img.src = "/clear/" + p; img.alt = `${c.name}, page ${i + 1} of ${c.pages.length}`; img.loading = "lazy"; img.width = img.height = 240; row.append(img); });
    box.append(row);
  }
  return box;
}

const get = (f) => fetch(f).then((r) => (r.ok ? r.json() : []), () => []);
Promise.all([get("/clear/screens/index.json"), get("/clear/screens/all.json"), get("/clear/screens/missing.json")]).then(([hand, all, miss]) => {
  const root = document.getElementById("sections");
  // one list of sections: by hand first, then the registry's
  const secs = [
    ...hand.map((s) => ({ ...s, dapp: s.slug.split("-")[0], use: 0 })),
    ...all.filter((s) => !HIDE.includes(s.file)).map((s) => ({ ...s, slug: s.file.replace(/^.*calldata-|\.json$/g, ""), note: NOTES[s.file] || "",
      cases: s.cases.map((c) => ({ ...c, pages: c.pages.map((p) => "screens/all/" + p) })) })),
  ];
  const by = {};
  for (const s of secs) (by[s.dapp] = by[s.dapp] || []).push(s);
  const title = (s) => document.querySelector("h1").textContent = document.title = s;
  const backLink = () => { const a = el("a", "back", "← every dapp"); a.href = "/clear/"; document.querySelector("h1").before(a);
    document.querySelectorAll(".lead").forEach((p, i) => { if (!i) p.remove(); }); };      // the long intro: the home page only

  if (show === "missing") {                          // busy mainnet calls with no descriptor: what to write next
    title("No descriptor yet"); backLink();
    root.append(el("p", "note", `The busiest calls on Ethereum last week that a wedgie has no descriptor for (bots left out). A wedgie shows these as the big red "can't read" page. Use from erc7730.sourcify.dev.`));
    for (const c of miss.calls || []) {
      const box = el("div", "tx");
      box.append(el("h3", null, `${c.contract || "?"}: ${(c.sig || c.sel).replace(/\(.*/, "")}`));
      const meta = el("div", "meta"); const a = el("a", null, c.to); a.href = `https://etherscan.io/address/${c.to}`;
      meta.append(a, ` · ${c.sig || c.sel} · ${num(c.use)} mainnet txs last week`);
      box.append(meta); root.append(box);
    }
    return;
  }
  if (show && VERDICTS[show]) {                      // every transaction with one verdict
    title(`Clear signing on a wedgie: ${VERDICTS[show][0]}`); backLink();
    root.append(el("p", "note", VERDICTS[show][2]));
    let n = 0;
    for (const s of secs) for (const c of s.cases) if (verdict(c) === show) { root.append(card(c, `${pretty(s.dapp)} ${s.title}`)); n++; }
    if (!n) root.append(el("p", null, "None."));
    return;
  }
  if (!here) {
    const old = secs.find((s) => "#" + s.slug === (OLD[location.hash] || location.hash));    // an old /clear#uniswap-v2 link
    if (old) { location.replace(`/clear/?d=${old.dapp}#${old.slug}`); return; }
    const count = {};
    let total = 0, screens = 0;
    for (const s of secs) for (const c of s.cases) { const v = verdict(c); count[v] = (count[v] || 0) + 1; if (c.pages.length) { total++; screens += c.pages.length; } }
    root.append(el("p", "sum", `${num(total)} transactions, ${num(screens)} screens, ${Object.keys(by).length} dapps.`));
    const tabs = el("div", "tabs");
    for (const k of Object.keys(VERDICTS)) if (count[k]) { const a = el("a", "badge " + VERDICTS[k][1], `${num(count[k])} ${VERDICTS[k][0]}`); a.href = `/clear/?show=${k}`; a.title = VERDICTS[k][2]; tabs.append(a); }
    if (miss.calls && miss.calls.length) { const a = el("a", "badge bad", `${miss.calls.length} busy calls with no descriptor`); a.href = "/clear/?show=missing"; tabs.append(a); }
    root.append(tabs);
    const find = el("input", "find"); find.type = "search"; find.placeholder = "Find a dapp or contract"; root.append(find);
    const grid = el("div", "dapps");
    const use = (ss) => ss.reduce((k, s) => k + s.use, 0);
    const cards = Object.entries(by).sort((a, b) => use(b[1]) - use(a[1]) || a[0].localeCompare(b[0])).map(([d, ss]) => {
      const a = el("a", "dapp"); a.href = `/clear/?d=${d}`;
      a.append(el("h2", null, pretty(d)));
      const n = ss.reduce((k, s) => k + s.cases.length, 0);
      a.append(el("p", null, `${num(n)} transaction${n === 1 ? "" : "s"}${use(ss) ? ` · ${num(use(ss))} mainnet txs last week` : ""}`));
      a.append(el("p", "files", ss.map((s) => s.title).join(", ")));
      a.dataset.text = (d + " " + ss.map((s) => s.title).join(" ")).toLowerCase();
      grid.append(a);
      return a;
    });
    find.oninput = () => { const t = find.value.trim().toLowerCase(); for (const a of cards) a.hidden = !!t && !a.dataset.text.includes(t); };
    root.append(grid);
    return;
  }
  const mine = by[here];
  if (!mine) { root.textContent = "No screens for this one yet."; return; }
  title(`${pretty(here)} on a wedgie`); backLink();
  if (DAPPS[here] && DAPPS[here].finding) { const f = el("div", "finding"); f.innerHTML = DAPPS[here].finding; root.append(f); }
  for (const s of mine) {
    const h = el("h2", null, s.title); h.id = s.slug; root.append(h);
    if (s.note) root.append(el("p", "note", s.note));
    if (s.file) { const p = el("p", "note"); const a = el("a", null, s.file); a.href = `https://github.com/ethereum/clear-signing-erc7730-registry/blob/master/${s.file}`; p.append("The registry's ", a, " and its test transactions."); root.append(p); }
    for (const c of s.cases) root.append(card(c));
  }
  if (location.hash) { const t = document.getElementById((OLD[location.hash] || location.hash).slice(1)); if (t) t.scrollIntoView(); }
}).catch(() => { document.getElementById("sections").textContent = "Couldn't load the screens."; });
