// /api/net: a wedgie app's internet (firmware/net.py). The app asks its computer, the computer (its page on
// wedgie.dev, src/serial/net.ts, or wedgie.py net) asks here, and only for a site the app listed in its
// wedgie.json "net" (the page and wedgie.py check that; this end can't know which app asks).
//   POST {url, pick?, max?} -> {data} | {error}
// GET only, https only, no addresses on a private network. The answer is trimmed for a wedgie: pick takes the
// parts the app wants out of a JSON answer (pickOf), and it must fit in max bytes (a wedgie's USB line is 6 KB).
// Never log a body here.
import { json, oops, crossSite } from "./_shop.js";
import { overLimit } from "./rpc.js";

const MAX_IN = 4 << 20, MAX_OUT = 4500, PER_MIN = 120, PER_DAY = 5000;
const CACHE_MS = 30_000;
const CACHE = new Map<string, { at: number; v: any }>();

/** A host a wedgie may reach: a name with a dot, not an address, not a name for this machine or a private net. */
export function publicHost(u: URL) {
  const h = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.port && !u.username && !u.password && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)
    && !/\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h);
}

/**
 * pick: one path ("0:5.{title,amount}") or {name: path}. A path is steps split by ".":
 *   name   a field          3   an item (-1: the last)       2:5   items 2-4, each takes the rest of the path
 *   (on text, 0:500 is its first 500 characters)
 *   *      every item       {a,b}   just those fields, each takes the rest of the path
 * A step that doesn't fit gives null.
 */
export function pickOf(v: any, pick: unknown): any {
  if (typeof pick === "string") return walk(v, pick === "" ? [] : pick.split("."));
  if (pick && typeof pick === "object" && !Array.isArray(pick))
    return Object.fromEntries(Object.entries(pick).slice(0, 30).map(([k, p]) => [k, typeof p === "string" ? pickOf(v, p) : null]));
  return v;
}
function walk(v: any, steps: string[]): any {
  if (!steps.length || v === undefined) return v ?? null;
  const [s, ...rest] = steps;
  if (s.startsWith("{") && s.endsWith("}")) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.fromEntries(s.slice(1, -1).split(",").map((k) => k.trim()).filter(Boolean).map((k) => [k, walk(v[k], rest)]));
  }
  if (typeof v === "string") {
    const sl = s.match(/^(-?\d*):(-?\d*)$/);
    return sl ? walk(v.slice(sl[1] === "" ? 0 : +sl[1], sl[2] === "" ? undefined : +sl[2]), rest) : null;
  }
  if (Array.isArray(v)) {
    if (s === "*") return v.map((x) => walk(x, rest));
    const sl = s.match(/^(-?\d*):(-?\d*)$/);
    if (sl) return v.slice(sl[1] === "" ? 0 : +sl[1], sl[2] === "" ? undefined : +sl[2]).map((x) => walk(x, rest));
    if (/^-?\d+$/.test(s)) return walk(v.at(+s), rest);
    return null;
  }
  if (v && typeof v === "object" && Object.hasOwn(v, s)) return walk(v[s], rest);
  return null;
}

/** JSON in plain ASCII (\u escapes): its length is the bytes it takes on a wedgie's USB line. */
export const ascii = (v: any) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

async function fetchOnce(url: string) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  let u = new URL(url);
  let r: Response | null = null;
  for (let i = 0; i < 4; i++) {           // redirects, each checked like the first
    if (!publicHost(u)) throw new Error("not a public https site");
    r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "wedgie.dev (a wedgie app, +https://wedgie.dev/code.md)", Accept: "application/json, text/plain, */*" } });
    const to = r.headers.get("location");
    if (r.status < 300 || r.status > 399 || !to) break;
    u = new URL(to, u);
    r = null;
  }
  if (!r) throw new Error("too many redirects");
  if (!r.ok) throw new Error("the site said " + r.status);
  const reader = r.body!.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_IN) { reader.cancel().catch(() => {}); throw new Error("the site's answer is over 4 MB"); }
    parts.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(parts));
  let v: any = text;
  try { v = JSON.parse(text); } catch {}
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(url, { at: Date.now(), v });
  return v;
}

export async function POST(req: Request) {
  if (crossSite(req)) return oops("Not from wedgie.dev.", 403);
  const text = await req.text();
  if (text.length > 4000) return oops("Too big.", 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return oops("Bad request."); }
  let u: URL;
  try { u = new URL(String(b?.url)); } catch { return oops("url: a https:// address"); }
  if (!publicHost(u)) return oops("url: a public https:// site");
  if (await overLimit(req, PER_MIN, PER_DAY, "net:")) return oops("Too many. Wait a minute.", 429);
  const max = Math.min(MAX_OUT, Math.max(100, Number(b.max) || MAX_OUT));
  let v: any;
  try { v = await fetchOnce(u.href); } catch (e: any) { return oops(String(e?.message || e).slice(0, 100), 502); }
  const data = b.pick === undefined ? v : typeof v === "string" ? null : pickOf(v, b.pick);
  const out = ascii(data);
  if (out.length > max) {
    if (typeof data === "string") return json({ data: data.slice(0, max - 10) });
    return oops(`answer is ${out.length} bytes, over ${max}: pick fewer parts`, 413);
  }
  return json({ data });
}
