// /safe gives a module a calm name ("Recovery", "Delay") only by address, reads every module, and says so when it
// can't read them (audit 11-13, PAGE-7). Anything can answer getGuardians() or avatar().
//   node tools/test_modules.mjs                     the rules, no network
//   BASE_RPC=<a Base RPC url> node tools/test_modules.mjs      also: every listed address has code on Base
import { createServer } from "vite";
import { readFileSync } from "node:fs";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const M = await vs.ssrLoadModule("/src/safe/modules.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
const clone = (a) => "0x363d3d373d3d3d363d73" + a.slice(2) + "5af43d82803e903d91602b57fd5bf3";
const ROLES = "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5", FAKE = "0x" + "ab".repeat(20);

check(M.knownModule("0x088F6cfD8BB1dDb1BB069CCb3fc1A98927D233f2") === "recovery", "Candide's recovery by address, any case");
check(M.knownModule(FAKE) === null && M.knownModule(FAKE, "0x6080604052") === null, "an address we don't know, whatever it answers: unknown");
check(M.knownModule(FAKE, clone(ROLES)) === "roles", "a Zodiac clone of the Roles mastercopy: roles");
check(M.knownModule(FAKE, clone(FAKE)) === null, "a clone of something else: unknown");
check(M.knownModule(FAKE, clone(ROLES) + "00") === null && M.knownModule(FAKE, "0x00" + clone(ROLES).slice(2)) === null, "clone bytes with anything before or after: unknown");
check(M.knownModule(FAKE, clone("0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2")) === null, "a clone of a fixed-address module is not that module");
check(M.knownModule(undefined) === null && M.knownModule("constructor") === null && M.knownModule(FAKE, 5) === null, "junk in, null out (never throws)");
check([...Object.keys(M.FIXED), ...Object.keys(M.MASTERS)].every((a) => /^0x[0-9a-f]{40}$/.test(a)), "the lists are lowercase addresses");

const w = (x) => BigInt(x).toString(16).padStart(64, "0");
const page = (mods, next) => "0x" + w(64) + w(next) + w(mods.length) + mods.map(w).join("");
const p = M.modulePage(page([FAKE, ROLES], FAKE));
check(p && p.mods.length === 2 && p.mods[1] === ROLES && p.next === FAKE, "a page: its modules and where the next starts");
check(M.modulePage(page([], "0x1")).mods.length === 0, "an empty page reads as empty");
check(M.modulePage("0x") === null && M.modulePage(undefined) === null && M.modulePage("0x" + w(64) + w(1) + w(5)) === null, "a short or cut answer is unread, not empty");

const src = readFileSync("src/pages/safe.ts", "utf8");
check(/if \(!pg\) throw new Error\("modules unread"\)/.test(src) && /at = pg\.next/.test(src), "the page reads every page of modules and fails loudly on one it can't read");
check((src.match(/is === "(recovery|4337|allowance|roles|delay)" &&/g) || []).length === 5, "each calm kind asks knownModule first");
check(/addonRow\("Unknown module", `<span class="sx-warn">Can move money without the owners/.test(src), "an unknown module is never titled by the name it gives itself");
check(/Couldn't read this Safe's add-ons/.test(src) && /addonsErr = true/.test(src), "a failed read says so, not 'None: a plain Safe'");

if (process.env.BASE_RPC) {
  const rpc = async (method, params) => (await (await fetch(process.env.BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
  for (const a of [...Object.keys(M.FIXED), ...Object.keys(M.MASTERS)]) check(((await rpc("eth_getCode", [a, "latest"])) || "").length > 1000, `live: ${a} has code on Base`);
  for (const [a, k] of Object.entries(M.MASTERS)) check(((await rpc("eth_call", [{ to: a, data: "0x5aef7de6" }, "latest"])) || "").length === 66, `live: ${k} mastercopy ${a} answers avatar()`);
}
await vs.close();
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
