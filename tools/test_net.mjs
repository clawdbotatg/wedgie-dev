// An app's internet (firmware/net.py): api/net.ts pick and host rules, appjson "net", and one live fetch.
//   node tools/test_net.mjs
import { createServer } from "vite";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const m = await vs.ssrLoadModule("/api/net.ts");
const a = await vs.ssrLoadModule("/src/apps/appjson.mjs");
const v = { data: [{ title: "a", amount: 1, x: 9 }, { title: "b", amount: 2 }, { title: "c" }], n: { k: "z" } };
let bad = 0;
const eq = (x, y, what) => { const ok = JSON.stringify(x) === JSON.stringify(y); bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what, ok ? "" : JSON.stringify(x)); };
eq(m.pickOf(v, "data.0:2.{title,amount}"), [{ title: "a", amount: 1 }, { title: "b", amount: 2 }], "slice+fields");
eq(m.pickOf(v, "data.*.title"), ["a", "b", "c"], "star");
eq(m.pickOf(v, "data.-1.title"), "c", "last");
eq(m.pickOf(v, { t: "n.k", q: "nope.x" }), { t: "z", q: null }, "dict");
eq(m.pickOf(v, "data.title"), null, "key on array");
eq(m.pickOf({ d: "abcdef" }, "d.0:3"), "abc", "text cut");
eq(m.pickOf({ d: "abcdef" }, "d.x"), null, "field on text");
eq(m.publicHost(new URL("https://127.0.0.1/")), false, "ip");
eq(m.publicHost(new URL("https://localhost/")), false, "localhost");
eq(m.publicHost(new URL("https://api.coinbase.com/x")), true, "coinbase");
eq(m.publicHost(new URL("http://api.coinbase.com/x")), false, "http");
eq(a.netAllows(["coinbase.com"], "https://api.coinbase.com/x"), true, "subdomain");
eq(a.netAllows(["coinbase.com"], "https://evilcoinbase.com/x"), false, "suffix trick");
eq(a.netAllows(["chain"], "https://chain/x"), false, "chain isn't a host");
eq(a.netAllows(["chain"], "https://mainnet.rpc.buidlguidl.com/"), true, "chain reaches the Ethereum RPC node");
eq(a.netAllows(["chain"], "https://x.mainnet.rpc.buidlguidl.com/"), false, "only that host");
eq(a.netAllows(["buidlguidl.com"], "https://mainnet.rpc.buidlguidl.com/"), true, "a listed site still works");
eq(a.checkAppJson({ apps: [{ mod: "zz", name: "Z", files: ["zz.py"], net: ["https://x.com"] }] }).errors.length, 1, "bad net");
// an app can't take a built-in module's name (audit 11-13: /json.py is imported before MicroPython's own json),
// nor a core module's, whatever its ending (slot.mpy is the core's: an app's slot_x.py is fine, its slot.py isn't)
for (const mod of ["json", "hashlib", "os", "time", "machine", "struct", "asyncio", "saves", "lib"])
  eq(a.checkAppJson({ apps: [{ mod, name: "Z", files: [mod + ".py"] }] }).errors.length > 0, true, `mod ${mod}: refused`);
eq(a.checkAppJson({ apps: [{ mod: "tl", name: "Z", files: ["tl.py", "tl_s.py"] }] }, ["tl_s.mpy", "slot.mpy"]).errors.length > 0, true, "a .py twin of a core .mpy: refused");
eq(a.checkAppJson({ apps: [{ mod: "slot", name: "Z", files: ["slot.py"] }] }, ["slot.mpy"]).errors.length > 0, true, "a core module's name as mod: refused");
eq(a.checkAppJson({ apps: [{ mod: "jsonx", name: "Z", files: ["jsonx.py", "jsonx_os.py"] }] }, ["slot.mpy"]).errors.length, 0, "jsonx, jsonx_os.py: fine");
eq(a.checkAppJson({ apps: [{ mod: "zz", name: "Z", files: ["zz.py"], net: ["x.com", "chain"] }] }).apps[0].net, ["x.com", "chain"], "good net");
const post = (b) => m.POST(new Request("https://wedgie.dev/api/net", { method: "POST", body: JSON.stringify(b) })).then((r) => r.json());
eq(await post({ url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", pick: "data.base" }), { data: "ETH" }, "live coinbase");
eq((await post({ url: "https://169.254.169.254/latest" })).error, "url: a public https:// site", "metadata ip");
await vs.close();
console.log(bad ? bad + " FAILED" : "all ok");
process.exit(bad ? 1 : 0);
