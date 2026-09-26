import "@fontsource-variable/nunito/wght.css";
import "@fontsource/dm-mono/500.css";
import "@fontsource/silkscreen/400.css";
import "./style.css";
import { watchCount } from "./serial/wedgies";
import { home } from "./pages/home";
import { connect } from "./pages/connect";

const onConnect = location.pathname.replace(/\/+$/, "") === "/connect";

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

// Grey "Connect" until a wedgie is plugged in; then green with how many. Live as you plug and unplug.
const btn = document.getElementById("connect-btn")!;
watchCount((n) => {
  btn.classList.toggle("on", n > 0);
  btn.querySelector(".n")!.textContent = n ? String(n) : "";
  btn.setAttribute("aria-label", n ? `${n} wedgie${n > 1 ? "s" : ""} connected` : "Connect a wedgie");
});

(onConnect ? connect : home)(document.getElementById("top")!);
(window as any).__wedgieReady?.();
