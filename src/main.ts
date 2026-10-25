import * as Drive from "./serial/drive";
import "@fontsource-variable/nunito/wght.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/silkscreen/400.css";
import "./style.css";
import { watchCount, supported, allow, connectNew } from "./serial/wedgies";
import { home } from "./pages/home";
import { connect } from "./pages/connect";
import { assemble } from "./pages/assemble";
import { assemble3d } from "./pages/assemble3d";
import { format } from "./pages/format";
import { update } from "./pages/update";
import { prepare } from "./pages/prepare";
import { reset } from "./pages/reset";
import { build } from "./pages/build";
import { code } from "./pages/code";
import { debug } from "./pages/debug";
import { safe, savedSafes } from "./pages/safe";
import { usd } from "./safe/assets";
import { blo } from "blo";
import { secret } from "./pages/secret";
import { order, session } from "./pages/order";
import "./ui/report";             // from the start: it keeps the page's errors for a bug report
import { legal } from "./pages/legal";
import { emu } from "./pages/emu";
import { telegram } from "./pages/telegram";

// safe.wedgie.eth (the IPFS copy): its front page is /safe
if (location.hostname.startsWith("safe.") && location.pathname === "/") history.replaceState(null, "", "/safe" + location.hash);
const path = location.pathname.replace(/\/+$/, "");
const onConnect = path === "/connect" || path.startsWith("/connect/");   // the list, or one wedgie (/connect/<ID>)
const onAssemble = path === "/assemble";
const onAssemble3d = path === "/assemble/3d";
const onFormat = path === "/test" || path === "/format";   // /format: its old name
if (path === "/format") history.replaceState(null, "", "/test");
const onUpdate = path === "/update";
const onPrepare = path === "/prepare";
const onReset = path === "/reset";
const onBuild = path === "/build";
const onCode = path === "/code";
const onDebug = path === "/debug";
const onSafe = path === "/safe" || path.startsWith("/safe/");   // the list, or one Safe (/safe/<chain>:<address>)
const onSecret = path === "/secret";
const onOrder = path === "/order" || path.startsWith("/order/") || path === "/orders" || path === "/signin";   // buy, one order (/order/<id>), yours, sign in
const onLegal = path === "/terms" || path === "/privacy";
const onTelegram = path === "/telegram";
const onEmu = path === "/virtual" || path === "/emu";   // /emu: its old name
if (path === "/emu") history.replaceState(null, "", "/virtual" + location.search);
// Each page its own tab title (the first path part; /order/<id> is an order, /safe/<x> a Safe).
const TITLES: Record<string, string> = { connect: "Connect", assemble: "Assemble", test: "Test", update: "Update", prepare: "Prepare", reset: "Reset", build: "Build",
  code: "Code", debug: "Debug", safe: "Safe", secret: "Secret chat", order: "Order", orders: "Your orders", signin: "Sign in",
  terms: "Terms", privacy: "Privacy", virtual: "Virtual wedgie", emu: "Virtual wedgie", telegram: "Telegram" };
const title = TITLES[path.split("/")[1] || ""];
if (title) document.title = `${title} · wedgie.dev`;
const signedIn = !!session();

const app = document.getElementById("app")!;
app.innerHTML = `
<header class="top">
  <a class="brand" href="/"><img src="/img/sticker.webp" alt="" width="46" height="35"><span class="tag">wedgie.dev</span></a>
  <a class="skill-link" href="/skill.md" target="_blank">skill.md</a>
  ${signedIn ? `<a class="orders-btn${path === "/orders" ? " here" : ""}" href="/orders" aria-label="Your orders"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z M3 7.5 12 12l9-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="lbl">Orders</span></a>`
    : `<a class="orders-btn signin-btn" href="/signin">Sign in</a>`}
  <span class="top-safes" id="top-safes" hidden></span>
  <a class="connect-btn${onConnect ? " here" : ""}" id="connect-btn" href="/connect"><span class="led"></span><span class="lbl">Connect</span><b class="n"></b></a>
</header>
<main id="top"></main>
<footer class="foot">
  <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
  <p>Hardware, case, firmware, and this site are MIT licensed. Build it, fork it, sell it.</p>
  <p><a class="btn btn-sm" href="https://github.com/clawdbotatg/wedgie-dev" target="_blank" rel="noopener">Code on GitHub →</a></p>
  <p class="fine">Sold by BuidlGuidl DAO LLC · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="mailto:wedgie@buidlguidl.com">wedgie@buidlguidl.com</a></p>
  <p class="fine"><a href="https://github.com/clawdbotatg/wedgie-dev" target="_blank" rel="noopener">site + firmware</a> ·
  <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">case</a> ·
  <a href="https://github.com/austintgriffith/picowallet" target="_blank" rel="noopener">picowallet</a></p>
</footer>
`;

// Dark grey "Allow wedgie connection" (LED off) until this site can see a plugged-in wedgie: a tap opens the browser's
// device picker right here; pick one and you land on /connect. Then green with how many, linking there. Grey "Connect" where the
// browser has no Web Serial (/connect explains). Live as you plug and unplug. A browser that never
// tapped it here keeps asking without looking at a single port (wedgies.ts: armed).
const btn = document.getElementById("connect-btn")!;
const lbl = btn.querySelector(".lbl")!;
let seen = 0;
btn.addEventListener("click", (e) => {
  if (seen || !supported()) return;
  e.preventDefault();
  // Picked one? Take them to /connect, where they'll use it. Cancelled the picker: stay put.
  if (onConnect) connectNew().catch(() => {});
  else allow().then(() => { location.href = "/connect"; }, () => {});
});
// The wedgie's Safes, beside Connected: one tap to a Safe. Only while a wedgie is plugged in, only what /safe
// saved in this browser (savedSafes: no chain or API reads here). The last wedgie /safe read, not checked against this one.
let plugged = false;
const safesEl = document.getElementById("top-safes")!;
const paintSafes = () => {
  const all = plugged ? savedSafes() : [], shown = all.slice(0, 3);
  safesEl.hidden = !shown.length;
  safesEl.innerHTML = shown.map((s) => `<a class="top-safe" href="${s.href}" title="${s.addr}"><img src="${blo(s.addr as `0x${string}`)}" alt="">`
    + `${s.usd !== null ? `<span class="lbl">${usd(s.usd)}</span>` : ""}</a>`).join("")
    + (all.length > shown.length ? `<a class="top-safe more" href="/safe">+${all.length - shown.length}</a>` : "");
};
addEventListener("wedgie-safes", paintSafes);
addEventListener("storage", (e) => { if (e.key?.startsWith("wedgie.safe.")) paintSafes(); });
// Out of room up top: down to pictures (.tight), before anything overlaps. Measured, not a screen width: how much
// fits depends on what's there (Safes, Orders, the wedgie's address on /safe).
const bar = document.querySelector<HTMLElement>("header.top")!;
const fit = () => {
  const over = () => bar.scrollWidth > bar.clientWidth || [...bar.children].some((c) => c.scrollWidth > c.clientWidth + 1);
  bar.classList.remove("tight", "tighter");
  if (over()) bar.classList.add("tight");
  if (over()) bar.classList.add("tighter");     // still too wide: the brand's name and "Connected" go too
};
new ResizeObserver(fit).observe(bar);
new MutationObserver(fit).observe(bar, { childList: true, subtree: true, characterData: true });
const setPlugged = (on: boolean) => { if (on !== plugged) { plugged = on; paintSafes(); } };

// In the iPhone app there's no serial port: the button follows the WEDGIE drive instead (serial/drive.ts), and a
// tap opens the app's drive panel (pick the drive, see it).
if (Drive.inApp()) {
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); Drive.panel(); }, true);
  const look = async () => {
    const s = await Drive.status().catch(() => "away");
    btn.classList.toggle("on", s === "here");
    btn.classList.toggle("ask", s === "unpicked");
    setPlugged(s === "here");
    lbl.innerHTML = s === "here" ? "Connected" : s === "unpicked" ? "Find wedgie" : "Connect";
    btn.setAttribute("aria-label", s === "here" ? "wedgie connected" : "Connect a wedgie");
  };
  look(); setInterval(look, 1500);
} else watchCount((n) => {
  seen = n;
  setPlugged(n > 0);
  const ask = !n && supported();
  btn.classList.toggle("on", n > 0);
  btn.classList.toggle("ask", ask);
  lbl.innerHTML = ask ? `Allow <span class="long">wedgie </span>connection` : n ? "Connected" : "Connect";
  btn.querySelector(".n")!.textContent = n ? String(n) : "";
  btn.setAttribute("aria-label", n ? `${n} wedgie${n > 1 ? "s" : ""} connected` : ask ? "Allow wedgie connection" : "Connect a wedgie");
});

const top = document.getElementById("top")!;
// Ready when the page's first screen is really there: on the home page that includes the hero wedgie
// (its files are in the loader's byte count, and it has drawn a frame). Other 3D waits for the page.
if (onFormat || onUpdate || onPrepare || onReset || onTelegram) document.body.classList.add("test-mode");
const up = onFormat ? (format(top), Promise.resolve()) : onUpdate ? (update(top), Promise.resolve()) : onPrepare ? (prepare(top), Promise.resolve()) : onReset ? (reset(top), Promise.resolve()) : onConnect ? (connect(top), Promise.resolve()) : onAssemble3d ? (assemble3d(top), Promise.resolve()) : onAssemble ? (assemble(top), Promise.resolve()) : onBuild ? (build(top), Promise.resolve()) : onCode ? (code(top), Promise.resolve()) : onDebug ? (debug(top), Promise.resolve()) : onSafe ? (safe(top), Promise.resolve()) : onSecret ? (secret(top), Promise.resolve()) : onOrder ? (order(top), Promise.resolve()) : onLegal ? (legal(top, path.slice(1) as "terms" | "privacy"), Promise.resolve()) : onEmu ? (emu(top), Promise.resolve()) : onTelegram ? (telegram(top), Promise.resolve()) : home(top);
up.then(() => (window as any).__wedgieReady?.(), () => (window as any).__wedgieReady?.());
