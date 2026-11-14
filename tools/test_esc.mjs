// Text from outside never becomes HTML on /safe (audit 11-13). An ENS avatar's data: URL starts with the server's
// Content-Type; a queue's nonce, a token's address and a tx hash come from Safe's service, Instant Wallet's queue or
// an RPC node. Each is checked where it comes in and escaped where it's written.
//   node tools/test_esc.mjs
import { createServer } from "vite";
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
globalThis.document = { addEventListener() {}, querySelectorAll: () => [] };      // the module listens for copy clicks
const A = "0x" + "ab".repeat(20), EVIL = 'data:image/png;x=" onerror="window.__x=1";base64,AAAA';
// what an older page kept: a name for A, and its picture with a Content-Type that ends the attribute
for (const k of ["wedgie.ens", "wedgie.safe.ens", "wedgie.names"]) mem[k] = JSON.stringify({ n: { [`1:${A}`]: { name: "evil.eth", at: Date.now() } }, p: { "evil.eth": { src: EVIL, at: Date.now() }, "good.eth": { src: "data:image/png;base64,AAAA", at: Date.now() } } });
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const src = (await import("node:fs")).readFileSync("src/safe/address.ts", "utf8");
const KEY = /localStorage\.getItem\(([A-Z_]+|"[^"]+")/.exec(src)?.[1];
const name = KEY?.startsWith('"') ? KEY.slice(1, -1) : new RegExp(`const ${KEY} = "([^"]+)"`).exec(src)?.[1];
if (name) mem[name] = mem["wedgie.ens"];
const m = await vs.ssrLoadModule("/src/safe/address.ts");
const D = await vs.ssrLoadModule("/src/safe/describe.ts");
let bad = 0;
const check = (ok, what, got) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what, ok ? "" : String(got).slice(0, 300)); };
/** The attributes of every tag in some HTML, as a browser reads them: [tag, {name: value}]. */
const tags = (html) => [...html.matchAll(/<([a-z0-9]+)((?:\s+[^\s=>"']+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi)].map((t) =>
  [t[1], Object.fromEntries([...t[2].matchAll(/([^\s=>"']+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]))]);
const handlers = (html) => tags(html).flatMap(([, at]) => Object.keys(at).filter((k) => k.startsWith("on")));

check(!!name, `found the page's storage key (${name})`);
for (const [what, html] of [["address()", m.address(A)], ["address() long, linked", m.address(A, { long: true, link: "https://etherscan.io", chain: 1 })], ["face()", m.face(A)]]) {
  check(handlers(html).length === 0 && !/onerror/i.test(html), `${what}: a kept avatar with a quote in its type adds no handler`, html);
  const img = tags(html).find(([t]) => t === "img")?.[1];
  check(img && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(img.src), `${what}: the picture is the blockie instead (${img?.src?.slice(0, 30)}…)`, html);
}
check(html0(m.address("<img src=x onerror=1>")), "address() of text that isn't an address: escaped");
function html0(h) { return handlers(h).length === 0 && tags(h).every(([t]) => t !== "img"); }
for (const [s, ok] of [["data:image/png;base64,AAAA", true], ["data:image/svg+xml;base64,PHN2Zz4=", true], ["blob:https://wedgie.dev/1b2c-3d", true],
  [EVIL, false], ["data:image/png;charset=x;base64,AAAA", false], ["data:text/html;base64,AAAA", false], ['data:image/png;base64,AA"A', false],
  ["javascript:alert(1)", false], ["https://x.example/a.png", false], ['blob:https://wedgie.dev/1" onerror="x', false], [null, false], [{}, false]])
  check(m.okPic(s) === ok, `okPic(${JSON.stringify(s)?.slice(0, 50)}) is ${ok}`, m.okPic(s));

const S = "0x" + "11".repeat(20);
const d = D.describe({ to: S, value: "0", data: "0x", operation: 0, nonce: '<img src=x onerror="window.__x=1">' }, { safe: S, chain: 1, owners: [], threshold: 1 });
check(handlers(d.title).length === 0 && !/[<>]/.test(d.title.replace(/<\/?(b|span|i|em|strong)[^>]*>/g, "")), `describe(): a cancel whose nonce is HTML: "${d.title}"`, d.title);
const d2 = D.describe({ to: S, value: "0", data: "0x", operation: 0, nonce: 12 }, { safe: S, chain: 1, owners: [], threshold: 1 });
check(d2.title === "Cancel #12", `describe(): a real nonce still reads (${d2.title})`, d2.title);

const page = (await import("node:fs")).readFileSync("src/pages/safe.ts", "utf8");
check(!/data-tok="\$\{a\.token/.test(page) && !/value="\$\{a\.token/.test(page), "safe.ts: a token's address is escaped in data-tok and <option>");
check(/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(hash\)/.test(page), "safe.ts: an activity row's link needs a real tx hash");
check(/esc = .*&#39;/.test(page) && /esc = .*&#39;/.test(src), "esc() escapes ' too");
const assets = (await import("node:fs")).readFileSync("src/safe/assets.ts", "utf8");
check(/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(b\.token\)/.test(assets), "assets.ts: a token that isn't an address is dropped");
await vs.close();
console.log(bad ? `${bad} FAILED` : "ALL OK");
process.exit(bad ? 1 : 0);
