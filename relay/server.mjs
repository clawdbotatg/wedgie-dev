// relay: the pipe for a wedgie's own TLS (tls/). A wedgie's page opens a WebSocket here with ?host=<site>; this
// opens TCP to that site's port 443 and copies bytes both ways. It only ever carries the wedgie's encrypted bytes:
// it can block them, never read or change them. Runs on the zkllmapi box behind nginx (relay/README.md); Vercel
// can't hold a socket and Cloudflare Workers can't reach sites on Cloudflare (Coinbase, CoinGecko...).
// Port 443 only, a public site name that resolves to a public address (connected to by that address: no
// rebinding to this box's own services), pages on wedgie.dev only, 1 MB and 60 s a connection, 8 at once and
// 60 a minute per IP (an IPv6 caller by its /64), ALL at once in total. Never this box's own addresses.
// The IP is nginx's X-Real-IP, which nginx sets itself (relay/nginx.conf, the box's copy).
import { WebSocketServer } from "ws";
import net from "node:net";
import os from "node:os";
import dns from "node:dns/promises";

const PORT = Number(process.env.PORT || 8796), MAX = 1 << 20, SECONDS = 60, AT_ONCE = 8, PER_MIN = 60, ALL = 200;

// this box: its own interfaces and what relay.wedgie.dev points at (its public address)
const SELF = new Set(Object.values(os.networkInterfaces()).flat().map((a) => a.address.toLowerCase()));
dns.lookup("relay.wedgie.dev", { all: true }).then((l) => l.forEach((a) => SELF.add(a.address.toLowerCase()))).catch(() => {});
const ORIGINS = /^(https:\/\/(www\.|emu\.)?wedgie\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

export function publicHost(h) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) && !/\.(local|localhost|internal|lan|home|corp|intranet)$/.test(h) && h.length < 254;
}

/** A public unicast address (not this box, a private net, link-local, CGNAT, multicast...). */
export function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (!net.isIPv6(ip)) return false;
  const w = v6words(ip);
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 5).every((x) => !x) && (w[5] === 0xffff || w[5] === 0)) return w[5] === 0 && w[6] === 0 && w[7] <= 1 ? false : publicIp(v4(w[6], w[7]));   // ::ffff:a.b.c.d, ::a.b.c.d
  if (w[0] === 0x2002) return publicIp(v4(w[1], w[2]));   // 6to4
  return !((w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] >> 8) === 0xff
    || (w[0] === 0x64 && w[1] === 0xff9b) || (w[0] === 0x2001 && w[1] === 0xdb8) || (w[0] === 0x2001 && w[1] < 0x200));
}

/** An IPv6 address as its 8 16-bit words (handles ::, and a.b.c.d at the end). */
function v6words(ip) {
  let x = ip.toLowerCase().split("%")[0];
  const m = x.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) x = x.slice(0, -m[0].length) + ((+m[1] << 8) | +m[2]).toString(16) + ":" + ((+m[3] << 8) | +m[4]).toString(16);
  const [a, b] = x.split("::");
  const h = a ? a.split(":") : [], t = b ? b.split(":") : [];
  const words = b === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return words.map((v) => parseInt(v || "0", 16));
}

/** A caller's key for the limits: an IPv4 address, or an IPv6 /64 (one host gets a whole /64 to rotate in). */
export function who(ip) {
  return net.isIPv6(ip) && !ip.startsWith("::ffff:") ? v6words(ip).slice(0, 4).map((v) => v.toString(16)).join(":") + "::/64" : ip;
}

const live = new Map(), recent = new Map();
setInterval(() => recent.clear(), 60_000).unref();

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1", maxPayload: 64 * 1024 });
wss.on("connection", async (ws, req) => {
  const ip = who(String(req.headers["x-real-ip"] || req.socket.remoteAddress));
  const host = (new URL(req.url, "http://x").searchParams.get("host") || "").toLowerCase();
  const no = (why) => ws.close(1008, why);
  if (!ORIGINS.test(req.headers.origin || "")) return no("only from wedgie.dev");
  if (!publicHost(host)) return no("host: a public site name");
  if ((live.get(ip) || 0) >= AT_ONCE) return no("too many at once");
  if ([...live.values()].reduce((a, b) => a + b, 0) >= ALL) return no("busy, try again soon");
  const n0 = (recent.get(ip) || 0) + 1;
  recent.set(ip, n0);
  if (n0 > PER_MIN) return no("too many, wait a minute");
  live.set(ip, (live.get(ip) || 0) + 1);
  let n = 0, done = false, sock = null;
  const held = [];
  const end = (code = 1000, why = "closed") => {
    if (done) return;
    done = true;
    live.set(ip, live.get(ip) - 1);
    if (!live.get(ip)) live.delete(ip);
    clearTimeout(timer);
    sock?.destroy();
    try { ws.close(code, why); } catch {}
  };
  const timer = setTimeout(() => end(1000, "time"), SECONDS * 1000);
  ws.on("message", (b, binary) => {
    if (!binary) return;
    if ((n += b.length) > MAX) return end(1009, "too much");
    if (sock?.readyState === "open") sock.write(b); else held.push(b);
  });
  ws.on("close", () => end());
  ws.on("error", () => end());
  let addr;
  try {
    addr = (await dns.lookup(host, { all: true })).map((a) => a.address).find((a) => publicIp(a) && !SELF.has(a.toLowerCase()));
  } catch {}
  if (done) return;
  if (!addr) return end(1011, "can't find " + host);
  sock = net.connect({ host: addr, port: 443 });
  sock.setTimeout(SECONDS * 1000, () => end(1000, "time"));
  sock.on("connect", () => { for (const b of held.splice(0)) sock.write(b); });
  sock.on("data", (b) => {
    if ((n += b.length) > MAX) return end(1009, "too much");
    ws.send(b);
  });
  sock.on("end", () => end());
  sock.on("error", () => end(1011, "the site didn't answer"));
});
console.log("wedgie relay on 127.0.0.1:" + PORT);
