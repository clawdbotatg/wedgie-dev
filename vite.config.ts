import { defineConfig, loadEnv, type Plugin, type Connect } from "vite";
import { readFileSync, statSync } from "node:fs";
// @ts-ignore plain JS build helper
import { buildFirmware } from "./tools/fw.mjs";

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
  return { name: "wedgie-firmware", buildStart() { buildFirmware(); }, configureServer(server) {
    server.watcher.add("firmware");
    server.watcher.on("change", (f) => { if (f.includes("/firmware/")) buildFirmware(); });
  } };
}

function loaderManifest(): Plugin {
  return {
    name: "wedgie-loader",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!html.includes("__MANIFEST__")) return html;   // other pages (emu.html) load normally
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
        return html.replace("__MANIFEST__", JSON.stringify(files));
      },
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
  plugins: [firmware(), loaderManifest(), shopApi()],
  // shopprobe with no database account: an in-memory Postgres in Neon's place (tools/neonlite.mjs).
  ...(process.env.SHOP_DATABASE_URL_DEV === "pglite" ? { resolve: { alias: { "@neondatabase/serverless": new URL("./tools/neonlite.mjs", import.meta.url).pathname } } } : {}),
  // emu.html (the virtual wedgie's test page) is served by `vite` in dev; it is built only for
  // tools/emuprobe.mjs (WEDGIE_EMU_TEST=1), so the production site's chunks stay as they were.
  build: { target: "es2022", assetsInlineLimit: 0, ...(process.env.WEDGIE_EMU_TEST ? { rollupOptions: { input: { main: "index.html", emu: "emu.html" } } } : {}) },
  worker: { format: "es" },
  server: { headers: ISOLATE },
  preview: { headers: ISOLATE },
});
