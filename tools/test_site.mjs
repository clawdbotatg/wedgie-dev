// Links in the shop's mail always point at wedgie.dev (audit 11-13, SHOP-15). They used the request's own host:
// any name that reaches the project (an old *.vercel.app deployment, emu.wedgie.dev) got into sign-in links and
// order links, which carry the order's token.   node tools/test_site.mjs
import { createServer } from "vite";
import { readFileSync, readdirSync } from "node:fs";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const S = await vs.ssrLoadModule("/api/_shop.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
const of = (u) => S.siteOf(new Request(u));
check(of("https://wedgie.dev/api/order") === "https://wedgie.dev", "wedgie.dev: itself");
for (const h of ["https://wedgie-dev-abc123-buidlguidl.vercel.app/api/login", "https://emu.wedgie.dev/api/order", "https://wedgie.dev.evil.example/api/order", "http://wedgie.dev/api/order", "https://evil.example/api/stripe"])
  check(of(h) === "https://wedgie.dev", `${new URL(h).host}${h.startsWith("http:") ? " (http)" : ""}: wedgie.dev, not itself`);
check(of("http://localhost:5173/api/order") === "http://localhost:5173" && of("http://127.0.0.1:4173/api/login") === "http://127.0.0.1:4173", "this computer (development, the probes): itself");
const left = readdirSync("api").filter((f) => f.endsWith(".ts")).filter((f) => /new URL\(req\.url\)\.origin/.test(readFileSync("api/" + f, "utf8")));
check(!left.length, `no api file takes its address from the request (${left})`);
await vs.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
