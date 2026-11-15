// /safe keeps and tells the wedgie about a Safe only if it is one of Safe's own contracts (audit 11-13, PAGE-7).
// Anything can answer getOwners(): a link to a fake that names the wedgie's address as an owner was remembered in the
// browser and written to the wedgie's own list (safe_note) with no click, then listed on every computer.
//   node tools/test_realsafe.mjs            the rules, no network
//   BASE_RPC=<a Base RPC url> node tools/test_realsafe.mjs      also: two real Safes on Base pass, USDC doesn't
import { createServer } from "vite";
import { readFileSync } from "node:fs";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const R = await vs.ssrLoadModule("/src/safe/real.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
const slot = (a) => "0x" + "0".repeat(24) + a.slice(2);
const L2 = R.SINGLETONS.at(-2);

check(!R.realSafe("0x6080604052", slot(L2)), "a contract of its own code that points slot 0 at a real singleton: not a Safe");
check(!R.realSafe("0x", slot(L2)), "no code: not a Safe");
check(!R.realSafe("0x6080604052", "0x" + "0".repeat(64)), "nothing in slot 0: not a Safe");
check(!R.realSafe("zz", "") && !R.realSafe(undefined, undefined) && !R.realSafe("0x60806", slot(L2)), "junk in, false out (never throws)");
check(R.PROXY_CODE.length === 4 && R.SINGLETONS.length === 10 && R.SINGLETONS.every((a) => /^0x[0-9a-f]{40}$/.test(a)), "four proxy codes, ten singletons, lowercase");

const page = readFileSync("src/pages/safe.ts", "utf8");
check(/real: typeof code === "string"/.test(page) && /eth_getStorageAt/.test(page), "the page reads each Safe's code and slot 0");
check(/wedgieOwns\(\) && i\.real\) \{ remember\(c, a\); tellWedgie\(c, a\); \}/.test(page), "opening a Safe: remembered and sent to the wedgie only when it is real");
check(/info\.real && wedgieOwns\(\)\) remember\(/.test(page) && /r\.wedgie && r\.info\.real\) remember\(/.test(page), "the other two places that remember ask the same");
check(/i\.real === false\) h \+= `<p class="sx-warn">/.test(page), "a contract that isn't one says so on its page, in red");

if (process.env.BASE_RPC) {
  const rpc = async (method, params) => (await (await fetch(process.env.BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
  const is = async (a) => R.realSafe(await rpc("eth_getCode", [a, "latest"]), await rpc("eth_getStorageAt", [a, "0x0", "latest"]));
  check(await is("0x58a2768da4bc6c159456e4c3714c5fab96d9f117"), "live: a Safe 1.4.1 made on Base today is real");
  check(await is("0xfc4438193011d52d164aaec9fc0080391cc32953"), "live: an Instant Wallet (Safe 1.5.0) is real");
  check(!(await is("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")), "live: USDC (a proxy too) is not");
  check(!(await is(L2)), "live: a singleton itself is not");
}
await vs.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
