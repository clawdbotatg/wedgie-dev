// /api/icon: a connected app's logo (WalletConnect metadata), passed through so /safe can show it.
//   GET ?u=<https image url>  -> the image
// The site is cross-origin isolated (COEP require-corp), so another site's <img> only loads if it sends
// CORS/CORP headers, and most apps' favicons don't. Images only, 200 KB at most, cached a day.
// Public https sites only, each redirect checked the same (net.ts publicHost), and a rate limit per IP: else it
// reaches addresses inside Vercel's network for anyone, and hosts any image on wedgie.dev (audit 11-13, SHOP-19).
import { publicHost } from "./net.js";
import { overLimit } from "./rpc.js";
const MAX = 200_000;
const no = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  let u: URL;
  try { u = new URL(new URL(req.url).searchParams.get("u") || ""); } catch { return no(400); }
  if (!publicHost(u)) return no(400);
  if (await overLimit(req, 60, 1000, "icon:")) return no(429);
  try {
    let r: Response | null = null;
    for (let i = 0; i < 4; i++) {
      if (!publicHost(u)) return no(400);
      r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const to = r.headers.get("location");
      if (r.status < 300 || r.status > 399 || !to) break;
      u = new URL(to, u);
      r = null;
    }
    if (!r) return no(508);
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type)) return no(404);
    if (Number(r.headers.get("content-length") || 0) > MAX) return no(413);
    const reader = r.body!.getReader(), parts: Uint8Array[] = [];     // the cap as it comes: never a huge answer in memory
    let n = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if ((n += value.length) > MAX) { reader.cancel().catch(() => {}); return no(413); }
      parts.push(value);
    }
    const body = Buffer.concat(parts);
    return new Response(body, { headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",   // an SVG opened by itself runs nothing
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return no(502);
  }
}
