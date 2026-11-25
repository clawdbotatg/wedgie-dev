import { defineConfig, loadEnv, type Plugin, type Connect } from "vite";
import { readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
// @ts-ignore plain JS build helper
import { buildFirmware } from "./tools/fw.mjs";
import { ITEMS } from "./src/shop/catalog";
import { TITLES } from "./src/pages/titles";
import { ATOMIC_ON } from "./src/shop/catalog";

// The page paints the underwear and the loading bar from the first byte of HTML (index.html inlines
// both). Everything else is fetched by the inline loader with byte-level progress, like the
// device's loader.py fills its bar by each file's share of the total size. So at build time we
// take Vite's own <script>/<link> tags out of the HTML and hand the loader a manifest instead:
// every file the site needs up front, with its size.
// What the first screen needs besides the entry JS/CSS/fonts: the header logo, and the hero wedgie
// (its geometry, its boot logo, its demo's screens). Fetched by the loader so the bar is the truth.
const PRELOAD_FILES = ["/img/sticker.webp", "/img/loader-logo.webp", "/3d/wedgie.json", "/3d/wedgie.bin",
  ...["hello", "demo", "demo-2", "clear-sign", "wallet-home", "wallet-chart", "wallet-send", "wallet-receive", "wallet-signing"].map((n) => `/screens/${n}.png`)];
// Lazy chunks the hero wedgie imports (three.js lives in wedgie3d): fetched up front, run later.
const HERO_CHUNKS = /^assets\/(wedgie3d|demo)-[^/]+\.js$/;
// Only the latin subsets are fetched up front; the others load on demand through unicode-range.
const FONT_UP_FRONT = /(latin-wght-normal|dm-mono-latin-500-normal|silkscreen-latin-400-normal)[^/]*\.woff2$/;

function firmware(): Plugin {
  // In config(), not buildStart: vite lists public/ once, before buildStart. On a fresh clone public/fw
  // didn't exist yet, so the first `npm run dev` answered /fw/manifest.json with the home page.
  return { name: "wedgie-firmware", config() { buildFirmware(); }, configureServer(server) {
    server.watcher.add("firmware");
    server.watcher.on("change", (f) => { if (f.includes("/firmware/")) buildFirmware(); });
  } };
}

// The built page's script policy (audit 11-13): only this site's files, WebAssembly (the virtual wedgie) and the
// inline scripts that are in the HTML right now, each by its hash. Script that got in through a string the page
// drew (an XSS) doesn't run, and no inline handler does. A <meta>, not a header: the loader's script changes with
// every build. vercel.json's header still says who may frame the site. tools/loadprobe.mjs fails on a violation.
function csp(html: string) {
  const hashes = [...html.matchAll(/<script>([^]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const policy = `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}; object-src 'none'; base-uri 'self'`;
  if (!html.includes('<meta charset="utf-8">')) throw new Error("csp: no <meta charset> in index.html");
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

function loaderManifest(): Plugin {
  return {
    name: "wedgie-loader",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!html.includes("__MANIFEST__")) return html;   // other pages (emu.html) load normally
        html = html.replace("%PRICE_KIT%", String(ITEMS.kit.cents / 100));   // the structured data's "from" price
        html = html.replace("%LOADER_LOGO%", readFileSync("src/loader-logo.txt", "utf8").trim());
        const files: { u: string; n: number; t: string }[] = [];
        for (const u of PRELOAD_FILES) files.push({ u, n: statSync("public" + u).size, t: "img" });
        if (ctx.bundle) {
          html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>\s*/g, (_, u) => {
            files.push({ u, n: 0, t: "js" });
            return "";
          });
          html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">\s*/g, (_, u) => {
            files.push({ u, n: 0, t: "css" });
            return "";
          });
          for (const [name, out] of Object.entries(ctx.bundle)) {
            const u = "/" + name;
            const size = out.type === "chunk" ? Buffer.byteLength(out.code) : typeof out.source === "string" ? Buffer.byteLength(out.source) : out.source.byteLength;
            const f = files.find((f) => f.u === u);
            if (f) f.n = size;
            else if (FONT_UP_FRONT.test(name)) files.push({ u, n: size, t: "font" });
            else if (HERO_CHUNKS.test(name)) {
              files.push({ u, n: size, t: "lazy" });
              if (out.type === "chunk") for (const imp of out.imports) if (!files.some((f) => f.u === "/" + imp)) {
                const o = ctx.bundle[imp]; files.push({ u: "/" + imp, n: o && o.type === "chunk" ? Buffer.byteLength(o.code) : 0, t: "lazy" });
              }
            }
          }
        }
        html = html.replace("__MANIFEST__", JSON.stringify(files));
        return ctx.bundle ? csp(html) : html;    // the dev server adds its own inline scripts
      },
    },
  };
}

// Each page gets its own HTML: a copy of the built index.html with its title, description, canonical link, link
// preview and the words under the loader swapped, served by a vercel.json rewrite (/order -> /order.html).
// Crawlers that run no JS read only the HTML, so the words must be in it. Titles: src/pages/titles.ts.
// `card`: its own link preview picture and words (/claim). `text`: what the page is, in plain sentences.
type Page = { desc: string; text: string[]; card?: { title: string; desc: string; img: string; alt: string } };
const PAGES: Record<string, Page> = {
  order: { desc: "Order a wedgie: an open-source Ethereum hardware wallet and signer, assembled or as a kit. US shipping included. Pay by card or USDC.",
    text: ["Order a wedgie, the open-source DIY Ethereum hardware wallet and hardware signer. Assembled, or a kit with every part and the case.",
      "US shipping is included; outside the US it is a flat fee. Pay by card or USDC. Built by hand by Austin and Gus Griffith, shipped within a week."] },
  assemble: { desc: "Build your own hardware wallet: assemble a wedgie from a Pico, a screen hat and a secure chip, step by step. No soldering.",
    text: ["Build your own Ethereum hardware wallet. Every step to assemble a wedgie from three off-the-shelf parts: a Raspberry Pi Pico, a Waveshare Pico-LCD-1.3 screen hat and an Infineon OPTIGA Trust M secure chip.",
      "No soldering. Print the case yourself: it is MIT licensed, like everything else."] },
  "assemble/3d": { desc: "Every step of building a wedgie hardware wallet, in 3D: which part goes where, turn it around and look.",
    text: ["The wedgie assembly steps in 3D. See where the Pico, the screen hat, the secure chip and each wire go in a DIY hardware wallet."] },
  build: { desc: "Build your own wedgie: pick its app, its chip and its colors, then flash it from the browser.",
    text: ["Build your own wedgie: pick its app, its secure chip and its colors. A DIY hardware signer and pocket computer from three off-the-shelf parts."] },
  safe: { desc: "Use a wedgie as a hardware signer for a Safe multisig: deploy a Safe, send, and sign dapp transactions with clear signing. The key never leaves the chip.",
    text: ["A wedgie is a hardware signer for a Safe multisig on Ethereum, Base, Arbitrum, Optimism and more, with Safe's own audited contracts.",
      "Deploy a Safe, send from it, and connect to dapps like Uniswap over WalletConnect. The wedgie's screen says what each transaction does (clear signing, ERC-7730) and nothing signs until you press the green button. The key never leaves the secure chip."] },
  virtual: { desc: "A virtual wedgie in your browser: the real hardware wallet firmware on a virtual chip. Try apps and signing with no hardware.",
    text: ["The virtual wedgie: the real wedgie firmware running in your browser on a virtual RP2040. Try the hardware signer, its apps and its screens with no hardware."] },
  sandbox: { desc: "Paste an Ethereum transaction and see the pages a wedgie hardware signer shows before it signs. Clear signing with ERC-7730.",
    text: ["The clear signing sandbox. Paste an Ethereum transaction and see, page by page, what a wedgie hardware wallet shows before it signs, from ERC-7730 descriptors."] },
  connect: { desc: "Plug in a wedgie and manage it from the browser: install apps and games, update the firmware, keep your saves.",
    text: ["Connect a wedgie over USB in Chrome or Edge. Install apps and games, update the signed firmware, and read its saves."] },
  update: { desc: "Update a wedgie's firmware from the browser. Releases are signed and checked on the wedgie before anything is written.",
    text: ["Update a wedgie's firmware. Each release is signed, and the wedgie checks the signature itself before it writes anything."] },
  test: { desc: "Test a wedgie: its screen, joystick, buttons and secure chip.", text: ["Test a wedgie's screen, joystick, buttons and secure chip from the browser."] },
  reset: { desc: "Reset a wedgie: put MicroPython and the wedgie firmware back on from scratch.", text: ["Reset a wedgie: put MicroPython and the wedgie firmware back on from scratch."] },
  secret: { desc: "Secret chat: messages only a wedgie can read. Sealed in the browser to the wedgie's key, shown only on its screen.", text: ["Secret chat where only a wedgie can read what it is sent. Messages are sealed in the browser to the wedgie's key and show only on its screen."] },
  terms: { desc: "The terms for buying a wedgie from wedgie.dev.", text: ["The terms for buying a wedgie from wedgie.dev. Sold by BuidlGuidl DAO LLC."] },
  privacy: { desc: "What wedgie.dev knows about you: as little as it can. Your address is sealed in your browser and wiped after delivery.", text: ["Privacy at wedgie.dev. The shop never holds an address it can read: your browser seals it, and it is wiped after delivery."] },
  pq: { desc: "How a wedgie hardware signer goes post-quantum: one-time hash signatures for a Safe. What works on a real wedgie today and what is left.",
    text: ["The post-quantum plan for the wedgie hardware signer. A quantum computer breaks P-256, so a wedgie signs for a Safe with one-time hash signatures (WOTS), a new key for every transaction.",
      "Two ways are measured on a real wedgie: one-time keys (0.55 s to sign) and SLH-DSA, the NIST standard (8.2 s). Plug in a wedgie and try SLH-DSA on the page. Left: the owner contract, an address that keeps when the key changes, and an audit."] },
  claim: { desc: "Staked CLAWD on larv.ai? Burn CV for a free wedgie, shipped. One per wallet.", text: ["Staked CLAWD on larv.ai? Burn CV for a free wedgie, shipped. One per wallet."],
    card: { title: "Free wedgie for CLAWD stakers.", desc: "Staked CLAWD on larv.ai? Burn CV for a free wedgie, shipped. One per wallet.",
      img: "https://wedgie.dev/img/og-claim.png?v=1", alt: "Clawd, the red diamond in a tuxedo, holding up a wedgie with a pixel heart on its screen, next to the words Free wedgie." } },
};
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
/** The built home page, made into the page at /<path>. Throws if index.html lost a tag it swaps. */
function pageHtml(h: string, path: string, pg: Page) {
  const swap = (re: RegExp, to: string, what: string) => {
    if (!re.test(h)) throw new Error(`pages: no ${what} in index.html`);
    h = h.replace(re, () => to);
  };
  const meta = (attr: string, key: string, v: string) =>
    swap(new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`), `<meta ${attr}="${key}" content="${esc(v)}"`, key);
  const title = TITLES[path.split("/")[0]] + (path.includes("/") ? " (3D)" : ""), url = "https://wedgie.dev/" + path;
  swap(/<title>[^<]*<\/title>/, `<title>${esc(title)} · wedgie.dev</title>`, "<title>");
  swap(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, "canonical");
  swap(/<!--ld-->[^]*?<!--\/ld-->\n?/, "", "ld");      // the product and who makes it: said once, on the home page
  swap(/<!--pre-->[^]*?<!--\/pre-->/, `<div class="pre">\n<h1>${esc(title)}</h1>\n${pg.text.map((t) => `<p>${esc(t)}</p>`).join("\n")}\n<p><a href="/">wedgie: the open-source DIY Ethereum hardware wallet</a></p>\n</div>`, "pre");
  meta("name", "description", pg.desc);
  meta("property", "og:url", url);
  const c = pg.card;
  for (const [k, v] of [["title", c ? c.title : title], ["description", c ? c.desc : pg.desc], ...(c ? [["image", c.img], ["image:alt", c.alt]] : [])]) {
    meta("property", "og:" + k, v);
    meta("name", "twitter:" + k, v);
  }
  return h;
}
function pages(): Plugin {
  return {
    name: "wedgie-pages",
    writeBundle(opts) {
      const dir = opts.dir || "dist";
      if (!existsSync(dir + "/index.html")) return;
      const home = readFileSync(dir + "/index.html", "utf8");
      for (const [path, pg] of Object.entries(PAGES)) writeFileSync(`${dir}/${path.replace("/", "-")}.html`, pageHtml(home, path, pg));
    },
  };
}

// The shop's server (api/*.ts, Vercel functions in production) under `vite` and `vite preview`, so the
// probes can order end to end. Always the dev database branch (SHOP_DATABASE_URL_DEV in .env), never
// the real orders. Only SHOP_*, STRIPE_* and BANKR_LLM_* (api/explain.ts) come from .env.
function shopApi(): Plugin {
  const env = loadEnv("development", process.cwd(), "");
  for (const [k, v] of Object.entries(env)) if (/^(SHOP_|STRIPE_|BANKR_LLM_)/.test(k) && !(k in process.env)) process.env[k] = v;
  process.env.SHOP_DATABASE_URL = process.env.SHOP_DATABASE_URL_DEV || "";
  let load: (u: string) => Promise<Record<string, any>>;
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    const m = /^\/api\/(\w+)(?:\?|$)/.exec(req.url || "");
    if (!m) return next();
    try {
      const mod = await load(`/api/${m[1]}.ts`);
      const fn = mod[req.method || "GET"];
      if (!fn) { res.statusCode = 405; return res.end(); }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r: Response = await fn(new Request(`http://${req.headers.host}${req.url}`, { method: req.method,
        headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { console.error("api:", e); res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  };
  return {
    name: "wedgie-shop-api",
    configureServer(server) { load = (u) => server.ssrLoadModule(u); server.middlewares.use(mw); },
    async configurePreviewServer(server) {
      const { createServer } = await import("vite");
      const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
      load = (u) => vs.ssrLoadModule(u);
      server.middlewares.use(mw);
    },
  };
}

// The virtual wedgie (src/emu) needs SharedArrayBuffer, i.e. cross-origin isolation. vercel.json
// sends the same headers in production.
const ISOLATE = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  plugins: [firmware(), loaderManifest(), pages(), shopApi()],
  // shopprobe with no database account: an in-memory Postgres in Neon's place (tools/neonlite.mjs).
  ...(process.env.SHOP_DATABASE_URL_DEV === "pglite" ? { resolve: { alias: { "@neondatabase/serverless": new URL("./tools/neonlite.mjs", import.meta.url).pathname } } } : {}),
  // emu.html (the virtual wedgie's test page) is served by `vite` in dev; it is built only for
  // tools/emuprobe.mjs (WEDGIE_EMU_TEST=1), so the production site's chunks stay as they were.
  build: { target: "es2022", assetsInlineLimit: 0, ...(process.env.WEDGIE_EMU_TEST ? { rollupOptions: { input: { main: "index.html", emu: "emu.html" } } } : {}) },
  worker: { format: "es" },
  server: { headers: ISOLATE },
  preview: { headers: ISOLATE },
});
