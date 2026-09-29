import "@fontsource-variable/nunito/wght.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/silkscreen/400.css";
import "./style.css";
import { watchCount, supported, allow, connectNew } from "./serial/wedgies";
import { home } from "./pages/home";
import { connect } from "./pages/connect";
import { assemble } from "./pages/assemble";
import { format } from "./pages/format";
import { update } from "./pages/update";
import { build } from "./pages/build";
import { code } from "./pages/code";

const path = location.pathname.replace(/\/+$/, "");
const onConnect = path === "/connect" || path.startsWith("/connect/");   // the list, or one wedgie (/connect/<ID>)
const onAssemble = path === "/assemble";
const onFormat = path === "/format" || path === "/test";   // /test: its old name
if (path === "/test") history.replaceState(null, "", "/format");
const onUpdate = path === "/update";
const onBuild = path === "/build";
const onCode = path === "/code";

const app = document.getElementById("app")!;
app.innerHTML = `
<header class="top">
  <a class="brand" href="/"><img src="/img/sticker.webp" alt="" width="46" height="35"><span class="tag">wedgie.dev</span></a>
  <a class="connect-btn${onConnect ? " here" : ""}" id="connect-btn" href="/connect"><span class="led"></span><span class="lbl">Connect</span><b class="n"></b></a>
</header>
<main id="top"></main>
<footer class="foot">
  <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
  <p>Hardware, case, firmware, and this site are MIT licensed. Build it, fork it, sell it.</p>
  <p class="fine"><a href="https://github.com/clawdbotatg/wedgie-dev" target="_blank" rel="noopener">wedgie-dev</a> ·
  <a href="https://github.com/clawdbotatg/clawd-pico-case" target="_blank" rel="noopener">case</a> ·
  <a href="https://github.com/austintgriffith/picowallet" target="_blank" rel="noopener">picowallet</a></p>
</footer>
`;

// Red "Allow wedgie connection" until this site can see a plugged-in wedgie: a tap opens the browser's
// device picker right here; pick one and you land on /connect. Then green with how many, linking there. Grey "Connect" where the
// browser has no Web Serial (/connect explains). Live as you plug and unplug. A browser that never
// tapped it here stays red without looking at a single port (wedgies.ts: armed).
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
watchCount((n) => {
  seen = n;
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
if (onFormat || onUpdate) document.body.classList.add("test-mode");
const up = onFormat ? (format(top), Promise.resolve()) : onUpdate ? (update(top), Promise.resolve()) : onConnect ? (connect(top), Promise.resolve()) : onAssemble ? (assemble(top), Promise.resolve()) : onBuild ? (build(top), Promise.resolve()) : onCode ? (code(top), Promise.resolve()) : home(top);
up.then(() => (window as any).__wedgieReady?.(), () => (window as any).__wedgieReady?.());
