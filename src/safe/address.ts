// Addresses the way Scaffold-ETH shows them (ui.scaffoldeth.io: Address, AddressInput): a blockie (blo, the
// same one) or the ENS avatar, the ENS name over the short address, a copy button, a link to the explorer.
// Plain HTML strings plus one watcher (watch) that fills in ENS and wires inputs as they land, so a page can
// keep painting with innerHTML. ENS is read with viem through ENS's Universal Resolver on Ethereum, so names
// served by a gateway (CCIP-read: *.base.eth, *.wedgie.eth on Base) and a chain's own primary names work.
//   address(a, opts)       an address, anywhere one is shown (opts.chain: look up its name for that chain first)
//   face(a, chain)         just its picture
//   addressInput(id, ph)   an input that takes 0x… or an ENS name; addressOf(input) = the address it means
import { blo } from "blo";
import type { PublicClient } from "viem";
import * as E from "./eth";

// viem loads only on pages that show addresses (it's big): watch() starts it
type V = typeof import("viem") & { normalize: (typeof import("viem/ens"))["normalize"] };
let client: PublicClient | null = null, v: V | null = null;
let ready: Promise<void> | null = null;
const up = async () => { if (ready) await ready; return !!client; };

// Names and avatars outlive the page (localStorage): a reload paints them at once, checked again after a day.
// A read that fails (the RPC busy, the per-IP limit) never counts as "no name": the last known one stays.
const STORE = "wedgie.ens", DAY = 86_400_000, PIC_MAX = 48_000;
let seen: { n: Record<string, { name: string | null; at: number }>; p: Record<string, { src: string; at: number }> } = { n: {}, p: {} };
try { const s = JSON.parse(localStorage.getItem(STORE) || "{}"); seen = { n: s.n || {}, p: s.p || {} }; } catch {}
const save = () => {
  const trim = (o: Record<string, { at: number }>, max: number) => Object.keys(o).sort((a, b) => o[b].at - o[a].at).slice(max).forEach((k) => delete o[k]);
  trim(seen.n, 500); trim(seen.p, 40);
  try { localStorage.setItem(STORE, JSON.stringify(seen)); } catch {}
};
const fresh = (x?: { at: number }) => !!x && Date.now() - x.at < DAY;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** f() until it answers: a busy RPC gets a few more tries (the per-IP limit lifts within a minute). */
async function tries<T>(f: () => Promise<T>): Promise<T> {
  for (const ms of [3000, 15_000, 45_000]) { try { return await f(); } catch {} await wait(ms); }
  return f();
}

const names = new Map<string, Promise<string | null>>();
const known = new Map<string, { name: string; avatar?: string }>();   // what's resolved: painted straight in
const key = (a: string, chain?: number) => `${chain || 1}:${a.toLowerCase()}`;
for (const [k, x] of Object.entries(seen.n)) if (x.name) known.set(k, { name: x.name, avatar: seen.p[x.name]?.src });
/** The address's primary ENS name (on `chain` first, then Ethereum's), checked forward by the resolver, or null. */
export function ensName(a: string, chain?: number): Promise<string | null> {
  const k = key(a, chain), last = seen.n[k];
  if (!names.has(k)) names.set(k, (async () => {
    if (fresh(last)) return last.name;
    if (!(await up())) return last?.name ?? null;
    const address = E.checksum(a) as `0x${string}`;
    // viem answers null for "no name" and throws when the read failed
    // Both at once: a chain's name goes through ENS's gateway for that chain, which can hang (Optimism's took 23 s,
    // 2026-10-21). It gets 3 s; past that (or failing) Ethereum's name shows.
    const name = await tries(async () => {
      const main = client!.getEnsName({ address });
      if (chain && chain !== 1) {
        const n = await Promise.race([client!.getEnsName({ address, coinType: v!.toCoinType(chain) }).catch(() => null),
          wait(3000).then(() => null)]);
        if (n) { main.catch(() => {}); return n; }
      }
      return main;
    }).catch(() => undefined);
    if (name === undefined) { names.delete(k); return last?.name ?? null; }
    seen.n[k] = { name, at: Date.now() }; save();
    if (!name) { known.delete(k); return null; }
    known.set(k, { name, avatar: seen.p[name]?.src });
    ensAvatar(name).then((av) => { if (av) known.set(k, { name, avatar: av }); });
    return name;
  })().catch(() => last?.name ?? null));
  return names.get(k)!;
}

const fwd = new Map<string, Promise<string | null>>();
/** An ENS name's address (any resolver, gateways included), or null. */
export function ensAddress(name: string): Promise<string | null> {
  const raw = name.trim().toLowerCase();
  if (!fwd.has(raw)) fwd.set(raw, (async () => {
    if (!(await up())) return null;
    const a = await client!.getEnsAddress({ name: v!.normalize(raw) });
    return a ? E.checksum(a) : null;
  })().catch(() => null));
  return fwd.get(raw)!;
}

const avatars = new Map<string, Promise<string | null>>();
/** The name's avatar picture (a data: URL when small enough to keep, else a blob: URL), or null. Fetched, not an
 *  <img src>: this site is cross-origin isolated (COEP require-corp, for the emulator) and that blocks other sites'
 *  images. viem reads the avatar record (https, ipfs, NFTs); ENS's metadata service is the fallback. */
export function ensAvatar(name: string): Promise<string | null> {
  const last = seen.p[name];
  if (!avatars.has(name)) avatars.set(name, (async () => {
    if (fresh(last)) return last.src;
    await up();
    const urls = [await client?.getEnsAvatar({ name: v!.normalize(name) }).catch(() => null),
      `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(name)}`];
    for (const u of urls) {
      if (!u) continue;
      try {
        const r = await fetch(u);
        if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) continue;
        const blob = await r.blob();
        if (blob.size > PIC_MAX) return URL.createObjectURL(blob);
        const src = await new Promise<string>((ok, no) => { const f = new FileReader(); f.onload = () => ok(f.result as string); f.onerror = no; f.readAsDataURL(blob); });
        seen.p[name] = { src, at: Date.now() }; save();
        return src;
      } catch {}
    }
    avatars.delete(name);   // nothing came back: ask again next time, keep the last one meanwhile
    return last?.src ?? null;
  })().catch(() => last?.src ?? null));
  return avatars.get(name)!;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortA = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12.75 11.25 15 15 9.75"/><circle cx="12" cy="12" r="9"/></svg>`;

/** An address: avatar, ENS name (when it has one) over the short address, copy. link = the explorer's base.
 *  long = the whole address, its first 6 and last 4 in bold (the part people check). */
export function address(a: string, o: { link?: string; size?: "sm" | "lg"; long?: boolean; chain?: number } = {}) {
  if (!E.isAddress(a)) return `<span class="addr bad">${esc(a)}</span>`;
  const cs = E.checksum(a), k = known.get(key(cs, o.chain)), shown = o.long ? `<b>${cs.slice(0, 6)}</b>${cs.slice(6, -4)}<b>${cs.slice(-4)}</b>` : shortA(cs);
  const txt = o.link ? `<a href="${esc(o.link)}/address/${cs}" target="_blank" rel="noopener">${shown}</a>` : shown;
  return `<span class="addr${o.size ? " addr-" + o.size : ""}" data-addr="${cs}"${o.chain ? ` data-chain="${o.chain}"` : ""}><img class="addr-av" src="${k?.avatar || blo(cs as `0x${string}`)}" alt="">`
    + `<span class="addr-txt"><b class="addr-ens"${k ? "" : " hidden"}>${esc(k?.name || "")}</b>`
    + `<span class="addr-row"><span class="addr-hex" title="${cs}">${txt}</span><button class="addr-copy" type="button" data-copy="${cs}" aria-label="Copy address">${COPY}</button></span></span></span>`;
}

/** Just the round picture (the ENS avatar, else the blockie): owners stacked on a button. */
export function face(a: string, chain?: number) {
  const cs = E.checksum(a), k = known.get(key(cs, chain));
  return `<img class="addr-av" data-face="${cs}"${chain ? ` data-chain="${chain}"` : ""} src="${k?.avatar || blo(cs as `0x${string}`)}" alt="">`;
}

/** An address input: 0x… or an ENS name. Its avatar on the right, the ENS name (or the address a name means) on the left. */
export function addressInput(id: string, placeholder = "0x… or ENS name") {
  return `<span class="addr-in"><span class="addr-pre" hidden></span><input id="${esc(id)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" autocapitalize="off"><img class="addr-in-av" alt="" hidden></span>`;
}

/** The address an input means: a typed 0x… at once, an ENS name once it resolved. "" otherwise. */
export function addressOf(input: HTMLInputElement) {
  const v = input.value.trim();
  if (E.isAddress(v)) return E.checksum(v);
  return input.dataset.for === v ? input.dataset.address || "" : "";
}

function wire(input: HTMLInputElement) {
  if (input.dataset.wired) return;
  input.dataset.wired = "1";
  const box = input.parentElement!, pre = box.querySelector<HTMLElement>(".addr-pre")!, av = box.querySelector<HTMLImageElement>(".addr-in-av")!;
  let timer = 0, seq = 0;
  const show = (a: string | null, label = "", avatar = "") => {
    av.hidden = !a; if (a) av.src = blo(a as `0x${string}`);
    pre.hidden = !label;
    pre.innerHTML = label ? `${avatar ? `<img src="${esc(avatar)}" alt="">` : ""}<span>${esc(label)}</span>` : "";
  };
  const changed = () => input.dispatchEvent(new CustomEvent("address", { bubbles: true }));
  const look = async () => {
    const v = input.value.trim(), my = ++seq;
    box.classList.remove("bad");
    delete input.dataset.address; delete input.dataset.for;
    if (E.isAddress(v)) {
      show(v);
      const n = await ensName(v);
      if (my === seq && n) show(v, n, (await ensAvatar(n)) || "");
    } else if (/\.[a-z]{2,}$/i.test(v)) {
      show(null, "…");
      const a = await ensAddress(v);
      if (my !== seq) return;
      if (!a) { show(null); box.classList.add("bad"); return; }
      input.dataset.address = a; input.dataset.for = v;
      show(a, shortA(a), (await ensAvatar(v.toLowerCase())) || "");
    } else { show(null); if (v) box.classList.add("bad"); }
    if (my === seq) changed();
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (E.isAddress(v) || !v) look();           // an address needs no wait (like Scaffold's debounce)
    else { delete input.dataset.address; changed(); timer = window.setTimeout(look, 500); }
  });
  if (input.value) look();
}

function fill(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".addr[data-addr]:not([data-looked])").forEach((el) => {
    el.dataset.looked = "1";
    const a = el.dataset.addr!;
    ensName(a, +(el.dataset.chain || 0) || undefined).then(async (n) => {
      if (!n) return;
      const b = el.querySelector<HTMLElement>(".addr-ens")!;
      b.textContent = n; b.hidden = false;
      const av = await ensAvatar(n);
      if (av) el.querySelector<HTMLImageElement>(".addr-av")!.src = av;
    });
  });
  root.querySelectorAll<HTMLImageElement>("img[data-face]:not([data-looked])").forEach((img) => {
    img.dataset.looked = "1";
    ensName(img.dataset.face!, +(img.dataset.chain || 0) || undefined).then(async (n) => {
      const av = n && await ensAvatar(n);
      if (av) img.src = av;
    });
  });
  root.querySelectorAll<HTMLInputElement>(".addr-in input").forEach(wire);
}

/** Fill in ENS names and wire inputs under root as they're painted. rpc: an Ethereum mainnet RPC URL. */
export function watch(root: HTMLElement, rpc: string) {
  ready ??= Promise.all([import("viem"), import("viem/ens")]).then(([viem, ens]) => {
    v = { ...viem, normalize: ens.normalize };
    // viem's mainnet, the ENS parts only (importing viem/chains pulls in every chain, 500 KB)
    const chain = viem.defineChain({ id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
      contracts: { ensUniversalResolver: { address: "0xeeeeeeee14d718c2b47d9923deab1335e144eeee", blockCreated: 23_085_558 },
        multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 14_353_601 } } });
    client = viem.createPublicClient({ chain, transport: viem.http(rpc, { retryCount: 3 }) }) as PublicClient;
  }, () => {});
  fill(root);
  new MutationObserver(() => fill(root)).observe(root, { childList: true, subtree: true });
}

// one copy handler for every address: inside a link (a Safe's row) it copies and doesn't follow it
document.addEventListener("click", (e) => {
  const b = (e.target as Element).closest?.<HTMLButtonElement>(".addr-copy");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  navigator.clipboard.writeText(b.dataset.copy!).then(() => {
    b.innerHTML = CHECK;
    setTimeout(() => { b.innerHTML = COPY; }, 800);
    // data-copy-warn on a holder: a yellow note under it after the copy (the wedgie's own address: no funds)
    const h = b.closest<HTMLElement>("[data-copy-warn]");
    if (!h || h.querySelector(".copy-warn")) return;
    const n = document.createElement("div");
    n.className = "copy-warn"; n.textContent = h.dataset.copyWarn!;
    h.append(n);
    setTimeout(() => n.remove(), 5000);
  }, () => {});
}, true);
