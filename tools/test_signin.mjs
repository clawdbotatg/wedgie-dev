// A sign-in link someone else sent you never hands them your orders (audit 11-13, SHOP-17). They asked for a link to
// their own email and sent it to you: your browser signed in as them and claimed every email-less order it held.
// Now orders join only if this browser asked for that link (same email, 20 minutes), or after a click naming the email.
//   node tools/test_signin.mjs
import { createServer } from "vite";
import { readFileSync } from "node:fs";
const vs = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent", root: process.cwd() });
const S = await vs.ssrLoadModule("/src/shop/signin.ts");
let bad = 0;
const check = (ok, what) => { bad += ok ? 0 : 1; console.log(ok ? "ok  " : "FAIL", what); };
const now = 1_800_000_000_000;
check(S.askedHere({ email: "Me@x.com ", at: now - 60000 }, "me@x.com", now), "asked here for that email a minute ago: joins");
check(!S.askedHere(null, "me@x.com", now), "never asked here (a link someone sent): doesn't join");
check(!S.askedHere({ email: "me@x.com", at: now - 60000 }, "them@evil.com", now), "asked for mine, signed in as theirs: doesn't join");
check(!S.askedHere({ email: "me@x.com", at: now - 21 * 60000 }, "me@x.com", now), "asked 21 minutes ago (links last 15): doesn't join");
check(!S.askedHere({ email: "me@x.com", at: now + 60000 }, "me@x.com", now), "a time in the future: doesn't join");
check(!S.askedHere("junk", "me@x.com", now) && !S.askedHere({ email: 5, at: now }, 5, now) && !S.askedHere({ email: "", at: now }, "", now), "junk: doesn't join (never throws)");
check(S.notJoined(["a", "b", "c"], [{ id: "b" }]).join() === "a,c", "the orders here not on the account");
const src = readFileSync("src/pages/order.ts", "utf8");
check(/const claim = s\.ok === true \? /.test(src), "/orders sends this browser's orders only when ok");
check(/ok: askedHere\(asked\(\), r\.email, Date\.now\(\)\)/.test(src), "the link sets ok only if this browser asked for it");
check(/localStorage\.setItem\(ASKED, JSON\.stringify\(\{ email: e, at: Date\.now\(\) \}\)\)/.test(src), "asking for a link remembers which email");
check(/Add to \$\{esc\(lastEmail\(\)\)\}/.test(src) && /Not my email/.test(src), "otherwise it asks, naming the email, with a way out");
await vs.close();
console.log(bad ? `${bad} FAILED` : "all ok");
process.exit(bad ? 1 : 0);
