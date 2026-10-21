// /api/icon: a connected app's logo (WalletConnect metadata), passed through so /safe can show it.
//   GET ?u=<https image url>  -> the image
// The site is cross-origin isolated (COEP require-corp), so another site's <img> only loads if it sends
// CORS/CORP headers, and most apps' favicons don't. Images only, 200 KB at most, cached a day.
const MAX = 200_000;
const no = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  let u: URL;
  try { u = new URL(new URL(req.url).searchParams.get("u") || ""); } catch { return no(400); }
  if (u.protocol !== "https:") return no(400);
  try {
    const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(5000) });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type)) return no(404);
    const body = await r.arrayBuffer();
    if (body.byteLength > MAX) return no(413);
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
