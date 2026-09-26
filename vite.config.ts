import { defineConfig, type Plugin } from "vite";
import { readFileSync, statSync } from "node:fs";
// @ts-ignore plain JS build helper
import { buildFirmware } from "./tools/fw.mjs";

// The page paints the underwear and the loading bar from the first byte of HTML (index.html inlines
// both). Everything else is fetched by the inline loader with byte-level progress, like the
// device's loader.py fills its bar by each file's share of the total size. So at build time we
// take Vite's own <script>/<link> tags out of the HTML and hand the loader a manifest instead:
// every file the site needs up front, with its size.
const PRELOAD_IMAGES = ["/img/sticker-wedgie-dev.webp", "/img/sticker.webp"];
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
        for (const u of PRELOAD_IMAGES) files.push({ u, n: statSync("public" + u).size, t: "img" });
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
          }
        }
        return html.replace("__MANIFEST__", JSON.stringify(files));
      },
    },
  };
}

// The virtual wedgie (src/emu) needs SharedArrayBuffer, i.e. cross-origin isolation. vercel.json
// sends the same headers in production.
const ISOLATE = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  plugins: [firmware(), loaderManifest()],
  // emu.html (the virtual wedgie's test page) is served by `vite` in dev; it is built only for
  // tools/emuprobe.mjs (WEDGIE_EMU_TEST=1), so the production site's chunks stay as they were.
  build: { target: "es2022", assetsInlineLimit: 0, ...(process.env.WEDGIE_EMU_TEST ? { rollupOptions: { input: { main: "index.html", emu: "emu.html" } } } : {}) },
  worker: { format: "es" },
  server: { headers: ISOLATE },
  preview: { headers: ISOLATE },
});
