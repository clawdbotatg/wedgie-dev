// A wedgie app's internet (firmware/net.py). Only for what the running app's wedgie.json lists in "net" (sites,
// and "chain"); public/usb.md has the wire. A site (firmware 0.3.67+): the wedgie's own TLS, carried by answerTcp
// below. A chain read (and a site for 0.3.61-0.3.66): {"type": "net", "rid", url | chain+method+params}, fetched
// through wedgie.dev (api/net.ts, api/rpc.ts: Alchemy's key stays there), answered {"type": "net", "rid", data | error}.
import type { Repl } from "./repl";
import { netAllows } from "../apps/appjson.mjs";

const LINE = 5000;          // a wedgie reads a 6 KB line at most (wedgie.lines)

/** JSON in plain ASCII (\u escapes): its length is the bytes it takes on the wedgie's USB line. */
const ascii = (v: any) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ error: "wedgie.dev said " + r.status }));
}

/** One request from the app: answered, always (an error is an answer too). net: its wedgie.json "net". */
export async function answerNet(r: Repl, v: any, net: string[] | undefined, seen?: (what: string) => void) {
  const rid = v?.rid;
  if (!Number.isInteger(rid)) return;
  const send = (o: Record<string, unknown>) => r.write(ascii({ type: "net", rid, ...o }) + "\n").catch(() => {});
  try {
    let data: any;
    if (typeof v.url === "string") {
      if (!netAllows(net, v.url)) {
        let h = v.url;
        try { h = new URL(v.url).hostname; } catch {}
        return send({ error: `${String(h).slice(0, 40)} isn't in the app's "net" (wedgie.json)` });
      }
      seen?.(new URL(v.url).hostname);
      const j = await post("/api/net", { url: v.url, pick: v.pick, max: LINE - 100 });
      if (j.error) return send({ error: String(j.error).slice(0, 120) });
      data = j.data;
    } else if (typeof v.method === "string") {
      if (!net?.includes("chain")) return send({ error: `chain calls need "chain" in the app's "net" (wedgie.json)` });
      seen?.("chain " + v.chain);
      const j = await post(`/api/rpc?chain=${Number(v.chain) || 1}`, { jsonrpc: "2.0", id: 1, method: v.method, params: Array.isArray(v.params) ? v.params : [] });
      if (j.error) return send({ error: String(j.error?.message || j.error).slice(0, 120) });
      data = j.result;
    } else return send({ error: "a url, or a chain and method" });
    const line = ascii({ type: "net", rid, data });
    if (line.length > LINE) return send({ error: "the answer is too big for a wedgie: pick fewer parts" });
    await r.write(line + "\n");
  } catch {
    send({ error: "no internet" });
  }
}

// ---- a site, over the wedgie's own TLS (firmware 0.3.67+: net.py, tls.py) ----------------------------------
// The wedgie sends {"type": "tcp", "rid", "host"}, then its encrypted bytes as {"type": "tcp", "rid", "d": base64};
// this carries them over wedgie.dev's relay (relay/: a WebSocket in, the site's port 443 out) and the site's
// bytes back the same way, then {"end": true} or {"error"}. Only encrypted bytes pass here: this page and the
// relay can block them, never read or change them.
const RELAY = "wss://relay.wedgie.dev";
const PART = 1000;          // site bytes per line. 3000 (4 KB lines) got lost on a wedgie running its app: the TLS stalled (10-25)
const socks = new Map<number, { ws: WebSocket; held: Uint8Array<ArrayBuffer>[] }>();
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** One "tcp" line from the app. net: its wedgie.json "net". */
export function answerTcp(r: Repl, v: any, net: string[] | undefined, seen?: (what: string) => void) {
  const rid = v?.rid;
  if (!Number.isInteger(rid)) return;
  const send = (o: Record<string, unknown>) => r.write(JSON.stringify({ type: "tcp", rid, ...o }) + "\n").catch(() => {});
  const s = socks.get(rid);
  if (typeof v.host === "string") {
    s?.ws.close();
    const host = v.host.toLowerCase();
    if (!netAllows(net, `https://${host}/`)) return send({ error: `${host.slice(0, 40)} isn't in the app's "net" (wedgie.json)` });
    seen?.(host);
    const ws = new WebSocket(`${RELAY}/?host=${encodeURIComponent(host)}`);
    ws.binaryType = "arraybuffer";
    const me = { ws, held: [] as Uint8Array<ArrayBuffer>[] };
    socks.set(rid, me);
    ws.onopen = () => { for (const b of me.held.splice(0)) ws.send(b); };
    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      for (let o = 0; o < b.length; o += PART) send({ d: b64(b.subarray(o, o + PART)) });
    };
    ws.onclose = (e) => {
      if (socks.get(rid) !== me) return;
      socks.delete(rid);
      send(e.code === 1000 || e.code === 1005 ? { end: true } : { error: e.reason || "the relay closed" });
    };
    return;
  }
  if (!s) {           // not ours (a page opened since: the wedgie kept a connection, net keep): say so at once
    if (typeof v.d === "string") send({ error: "that connection is gone" });
    return;
  }
  if (v.end) {
    socks.delete(rid);
    s.ws.close();
  } else if (typeof v.d === "string") {
    const b = unb64(v.d);
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(b); else s.held.push(b);
  }
}
