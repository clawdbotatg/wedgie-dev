// /api/builds: "Wedgies around the world", the globe on the home page (src/ui/globe.ts).
//   GET                          the approved builds: {id, name, place, stage, note, link, lat, lon, at}
//   GET ?img=<id>                its photo (a JPEG). A build not yet approved: only with &k=<its key>
//   POST {name, place?, stage, note?, link?, lat, lon, img}    a new build, img a base64 JPEG the browser made
//                                (src/ui/globe.ts shrinks and re-encodes it). Held for review: nobody sees it yet.
//   GET ?review=<id>&k=<key>     the review page: its photo and words, Approve / Reject (or Take down once live)
//   GET ?review=all&k=<key>      every build waiting, each a link to its review page
//   POST (form) review, k, do    approve | reject | down
// Nothing a person sends shows on the site until one of us approves it: a photo or a word from a stranger
// never reaches the page on its own. Keys: hmac(SHOP_ADMIN_TOKEN, "build:" + id), in the Telegram note
// and email each new build sends (BUILDS_MAIL_PER_DAY a day, so a flood can't flood the inbox too).
// Approving is a POST from that page, never a GET: a mail scanner opening the link approves nothing.
// Griefing: PER_HOUR / PER_DAY per IP (ipOf, a hash), WAITING_MAX waiting at once, the photo checked as a
// JPEG and its metadata (GPS, camera) cut out here too, words cut to size, a link only as https or @handle.
// The place: lat/lon rounded to 0.1° (about 10 km), the person picks where on the globe. Never log a body here.
import { db as shopDb, json, oops, env, ipOf, hmac, same, randomHex } from "./_shop.js";
import { send } from "./_mail.js";

const PER_HOUR = 3, PER_DAY = 8, WAITING_MAX = 300, MAIL_PER_DAY = 30, IMG_MAX = 1_500_000;
export const STAGES = ["printed", "assembled", "running"] as const;

let ready: Promise<unknown> | null = null;
async function db() {
  const sql = await shopDb();
  ready ||= sql`create table if not exists builds (
      id text primary key,
      status text not null default 'new',   -- new (waiting for review) | live
      name text not null, place text not null default '', stage text not null, note text not null default '', link text not null default '',
      lat real not null, lon real not null,
      img text not null,                    -- base64 JPEG, metadata cut
      ip text not null,                     -- ipOf, for PER_HOUR / PER_DAY
      mailed boolean not null default false,
      at timestamptz not null default now(), live_at timestamptz)`
    .catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}

const keyOf = async (id: string) => (await hmac(env("SHOP_ADMIN_TOKEN"), "build:" + id)).slice(0, 32);
const keyOk = async (id: string, k: string) => env("SHOP_ADMIN_TOKEN").length >= 32 && !!k && same(k, await keyOf(id));

// Words: one line (the note may have a few), no control characters, cut to size.
const clean = (v: unknown, max: number, lines = false) =>
  String(v ?? "").replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g : /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
/** https://… or @handle (an X handle) or nothing. Anything else is refused. */
export function linkOf(v: string): string | null {
  if (!v) return "";
  const h = /^@?([A-Za-z0-9_]{1,15})$/.exec(v);
  if (h) return "https://x.com/" + h[1];
  try { const u = new URL(v); return u.protocol === "https:" && v.length <= 200 && !u.username && !u.password ? u.href : null; } catch { return null; }
}

/** A JPEG with every APPn (EXIF: GPS, camera) and comment segment cut out; null if it isn't a JPEG. */
export function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xda) { keep.push(b.subarray(i)); break; }       // start of scan: the picture itself, to the end
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) keep.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (keep.length < 2 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  const out = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let o = 0;
  for (const k of keep) { out.set(k, o); o += k.length; }
  return out;
}

const pub = (r: any) => ({ id: r.id, name: r.name, place: r.place, stage: r.stage, note: r.note, link: r.link,
  lat: Number(r.lat), lon: Number(r.lon), at: r.live_at || r.at });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (!env("SHOP_DATABASE_URL")) return q.get("img") || q.get("review") ? oops("Not here.", 404) : json({ builds: [] });
  const sql = await db();
  const img = q.get("img");
  if (img) {
    const [r] = await sql`select img, status from builds where id = ${img}`;
    if (!r || (r.status !== "live" && !(await keyOk(img, q.get("k") || "")))) return oops("Not here.", 404);
    return new Response(Buffer.from(r.img, "base64"), { headers: { "Content-Type": "image/jpeg",
      "Cache-Control": r.status === "live" ? "public, max-age=3600" : "no-store" } });
  }
  const review = q.get("review");
  if (review) {
    if (!(await keyOk(review, q.get("k") || ""))) return oops("no", 401);
    if (review === "all") {
      const rows = await sql`select id, name, place, stage, at from builds where status = 'new' order by at`;
      const items = await Promise.all(rows.map(async (r: any) => `<li><a href="?review=${r.id}&k=${await keyOf(r.id)}">${esc(r.name)}</a> · ${esc(r.stage)}${r.place ? " · " + esc(r.place) : ""} · ${esc(new Date(r.at).toISOString().slice(0, 16))}</li>`));
      return page(`${rows.length} waiting`, rows.length ? `<ul>${items.join("")}</ul>` : `<p>Nothing waiting.</p>`);
    }
    const [r] = await sql`select * from builds where id = ${review}`;
    if (!r) return page("Gone", "<p>Not here: rejected or taken down.</p>");
    const k = await keyOf(r.id);
    const btn = (d: string, label: string, color: string) =>
      `<form method="post" style="display:inline"><input type="hidden" name="review" value="${r.id}"><input type="hidden" name="k" value="${k}"><input type="hidden" name="do" value="${d}"><button style="font:inherit;font-weight:800;color:#fff;background:${color};border:0;border-radius:999px;padding:12px 26px;cursor:pointer">${label}</button></form>`;
    return page(r.status === "live" ? "Live on the globe" : "Waiting for review", `
      <img src="?img=${r.id}&k=${k}" style="max-width:100%;border-radius:14px;display:block">
      <dl><dt>Name</dt><dd>${esc(r.name)}</dd><dt>Stage</dt><dd>${esc(r.stage)}</dd><dt>Where</dt><dd>${esc(r.place || "—")} (${Number(r.lat).toFixed(1)}, ${Number(r.lon).toFixed(1)})</dd>
      <dt>Note</dt><dd style="white-space:pre-wrap">${esc(r.note || "—")}</dd><dt>Link</dt><dd>${esc(r.link || "—")}</dd></dl>
      <p>${r.status === "live" ? btn("down", "Take down", "#e3312c") : btn("approve", "Approve", "#22c452") + " " + btn("reject", "Reject", "#e3312c")}</p>`);
  }
  const rows = await sql`select id, name, place, stage, note, link, lat, lon, at, live_at from builds where status = 'live' order by live_at`;
  return new Response(JSON.stringify({ builds: rows.map(pub) }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=0, s-maxage=60" } });
}

export async function POST(req: Request) {
  if ((req.headers.get("content-type") || "").startsWith("application/x-www-form-urlencoded")) return decide(req);
  if (Number(req.headers.get("content-length") || 0) > IMG_MAX * 1.4 + 20_000) return oops("That photo is too big.", 413);
  let b: any;
  try { b = await req.json(); } catch { return oops("Bad request."); }
  if (b?.website) return json({ ok: true });   // the form's hidden field: only a bot fills it
  const name = clean(b?.name, 40), place = clean(b?.place, 60), note = clean(b?.note, 280, true), stage = String(b?.stage || "");
  const link = linkOf(clean(b?.link, 200));
  const lat = Math.round(Number(b?.lat) * 10) / 10, lon = Math.round(Number(b?.lon) * 10) / 10;
  if (!name) return oops("Your name, or a nickname.");
  if (!(STAGES as readonly string[]).includes(stage)) return oops("How far along is it?");
  if (link === null) return oops("The link: https://… or an @handle.");
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return oops("Pick where on the globe.");
  if (typeof b?.img !== "string" || b.img.length > IMG_MAX * 1.4) return oops("That photo is too big.");
  const jpeg = stripJpeg(Buffer.from(b.img, "base64"));
  if (!jpeg || jpeg.length < 2000) return oops("That photo didn't come through. Try another.");
  if (!env("SHOP_DATABASE_URL")) return oops("Not open yet.", 503);
  const sql = await db();
  const ip = await ipOf(req);
  await sql`delete from builds where status = 'new' and at < now() - interval '60 days'`;
  const [c] = await sql`select count(*) filter (where ip = ${ip} and at > now() - interval '1 hour')::int as hour,
    count(*) filter (where ip = ${ip} and at > now() - interval '1 day')::int as day,
    count(*) filter (where status = 'new')::int as waiting,
    count(*) filter (where mailed and at > now() - interval '1 day')::int as mailed from builds`;
  if (c.hour >= PER_HOUR || c.day >= PER_DAY) return oops("That's a lot of wedgies. Wait a bit.", 429);
  if (c.waiting >= WAITING_MAX) return oops("We have a pile to look at. Try again tomorrow.", 503);
  const id = randomHex(6), mail = c.mailed < MAIL_PER_DAY;
  await sql`insert into builds (id, name, place, stage, note, link, lat, lon, img, ip, mailed)
    values (${id}, ${name}, ${place}, ${stage}, ${note}, ${link}, ${lat}, ${lon}, ${Buffer.from(jpeg).toString("base64")}, ${ip}, ${mail})`;
  if (mail) await tell(new URL(req.url).origin, id, name, stage, place);
  return json({ ok: true, id });
}

// The review page's buttons.
async function decide(req: Request) {
  const f = new URLSearchParams(await req.text());
  const id = f.get("review") || "", d = f.get("do");
  if (!(await keyOk(id, f.get("k") || "")) || id === "all") return oops("no", 401);
  const sql = await db();
  if (d === "approve") await sql`update builds set status = 'live', live_at = now() where id = ${id} and status = 'new'`;
  else if (d === "reject" || d === "down") await sql`delete from builds where id = ${id}`;
  else return oops("Bad request.");
  return page(d === "approve" ? "Approved: it's on the globe" : "Gone", `<p><a href="?review=all&k=${await keyOf("all")}">What's still waiting</a> · <a href="/#world">The globe</a></p>`);
}

/** Telegram and the inbox: a new build to look at. Never throws. */
async function tell(origin: string, id: string, name: string, stage: string, place: string) {
  const href = `${origin}/api/builds?review=${id}&k=${await keyOf(id)}`;
  const what = `${name} · ${stage}${place ? " · " + place : ""}`;
  const bot = env("TELEGRAM_BOT_TOKEN"), chat = env("TELEGRAM_CHAT_ID");
  if (bot && chat) await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `🩲 a wedgie for the globe, waiting for review: ${what}\n${href}` }) }).catch(() => {});
  await send(env("SHOP_MAIL_USER") || "wedgie@buidlguidl.com", `wedgie for the globe: ${what}`,
    ["A new wedgie for the globe. Nobody sees it until you approve it.", what], { text: "Review it", href }).catch(() => {});
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · wedgie globe</title>
<body style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1b1a;max-width:560px;margin:0 auto;padding:24px 16px;line-height:1.5">
<h2>${esc(title)}</h2>${body}</body>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
