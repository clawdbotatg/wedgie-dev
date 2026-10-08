// Addresses the way Scaffold-ETH shows them (ui.scaffoldeth.io: Address, AddressInput): a blockie (blo, the
// same one) or the ENS avatar, the ENS name over the short address, a copy button, a link to the explorer.
// Plain HTML strings plus one watcher (watch) that fills in ENS and wires inputs as they land, so a page can
// keep painting with innerHTML. ENS is read from Ethereum mainnet through the page's own eth_call.
//   address(a, opts)       an address, anywhere one is shown
//   addressInput(id, ph)   an input that takes 0x… or an ENS name; addressOf(input) = the address it means
import { blo } from "blo";
import * as E from "./eth";

let call: ((to: string, data: string) => Promise<string>) | null = null;
const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

function namehash(name: string) {
  let node: Uint8Array = new Uint8Array(32);
  for (const label of name.toLowerCase().split(".").reverse()) if (label) node = E.keccak256(E.cat(node, E.keccakText(label)));
  return E.hex(node);
}
const word = (r: string) => (r && r.length >= 66 ? r.slice(0, 66) : "0x" + "0".repeat(64));
const asAddr = (r: string) => { const a = "0x" + word(r).slice(26); return /^0x0{40}$/.test(a) ? null : E.checksum(a); };
function asString(r: string) {
  if (!r || r.length < 130) return "";
  const b = E.bytes(r), off = Number(BigInt(E.hex(b.slice(0, 32)))), n = Number(BigInt(E.hex(b.slice(off, off + 32))));
  return new TextDecoder().decode(b.slice(off + 32, off + 32 + n));
}
async function resolverOf(node: string) {
  return asAddr(await call!(REGISTRY, E.selector("resolver(bytes32)") + node.slice(2)));
}

const names = new Map<string, Promise<string | null>>();
const known = new Map<string, { name: string; avatar?: string }>();   // what's resolved: painted straight in
/** The address's primary ENS name, checked forward (the name must point back at it), or null. */
export function ensName(a: string): Promise<string | null> {
  const k = a.toLowerCase();
  if (!call) return Promise.resolve(null);
  if (!names.has(k)) names.set(k, (async () => {
    const node = namehash(k.slice(2) + ".addr.reverse");
    const r = await resolverOf(node);
    if (!r) return null;
    const name = asString(await call!(r, E.selector("name(bytes32)") + node.slice(2)));
    const back = name && (await ensAddress(name));
    if (!back || back.toLowerCase() !== k) return null;
    known.set(k, { name });
    ensAvatar(name).then((av) => { if (av) known.set(k, { name, avatar: av }); });
    return name;
  })().catch(() => null));
  return names.get(k)!;
}

const fwd = new Map<string, Promise<string | null>>();
/** An ENS name's address (on-chain resolvers), or null. */
export function ensAddress(name: string): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!call) return Promise.resolve(null);
  if (!fwd.has(n)) fwd.set(n, (async () => {
    const node = namehash(n);
    const r = await resolverOf(node);
    return r ? asAddr(await call!(r, E.selector("addr(bytes32)") + node.slice(2))) : null;
  })().catch(() => null));
  return fwd.get(n)!;
}

const avatars = new Map<string, Promise<string | null>>();
/** The name's avatar picture (ENS's metadata service) as a blob: URL, or null. Fetched, not an <img src>:
 *  this site is cross-origin isolated (COEP require-corp, for the emulator) and that blocks other sites' images. */
export function ensAvatar(name: string): Promise<string | null> {
  if (!avatars.has(name)) avatars.set(name, (async () => {
    const r = await fetch(`https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(name)}`);
    if (!r.ok || !(r.headers.get("content-type") || "").startsWith("image/")) return null;
    return URL.createObjectURL(await r.blob());
  })().catch(() => null));
  return avatars.get(name)!;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const shortA = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12.75 11.25 15 15 9.75"/><circle cx="12" cy="12" r="9"/></svg>`;

/** An address: avatar, ENS name (when it has one) over the short address, copy. link = the explorer's base. */
export function address(a: string, o: { link?: string; size?: "sm" | "lg"; long?: boolean } = {}) {
  if (!E.isAddress(a)) return `<span class="addr bad">${esc(a)}</span>`;
  const cs = E.checksum(a), k = known.get(cs.toLowerCase()), shown = o.long ? cs : shortA(cs);
  const txt = o.link ? `<a href="${esc(o.link)}/address/${cs}" target="_blank" rel="noopener">${shown}</a>` : shown;
  return `<span class="addr${o.size ? " addr-" + o.size : ""}" data-addr="${cs}"><img class="addr-av" src="${k?.avatar || blo(cs as `0x${string}`)}" alt="">`
    + `<span class="addr-txt"><b class="addr-ens"${k ? "" : " hidden"}>${esc(k?.name || "")}</b>`
    + `<span class="addr-row"><span class="addr-hex" title="${cs}">${txt}</span><button class="addr-copy" type="button" data-copy="${cs}" aria-label="Copy address">${COPY}</button></span></span></span>`;
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
    ensName(a).then(async (n) => {
      if (!n) return;
      const b = el.querySelector<HTMLElement>(".addr-ens")!;
      b.textContent = n; b.hidden = false;
      const av = await ensAvatar(n);
      if (av) el.querySelector<HTMLImageElement>(".addr-av")!.src = av;
    });
  });
  root.querySelectorAll<HTMLInputElement>(".addr-in input").forEach(wire);
}

/** Fill in ENS names and wire inputs under root as they're painted. mainnetCall: eth_call on Ethereum. */
export function watch(root: HTMLElement, mainnetCall: (to: string, data: string) => Promise<string>) {
  call = mainnetCall;
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
  }, () => {});
}, true);
