// A wedgie app's internet (firmware/net.py). The app sends {"type": "net", "rid", url | chain+method+params} on
// USB; the page holding its port (its /connect/<ID> page) fetches through wedgie.dev (api/net.ts for a site,
// api/rpc.ts for a chain read, Alchemy's key staying there) and writes back {"type": "net", "rid", data | error}.
// Only for what the running app's wedgie.json lists in "net" (sites, and "chain"). public/usb.md has the wire.
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
