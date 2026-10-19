// "Wedgies around the world" end to end (api/builds.ts under vite on an in-memory Postgres, src/ui/world.ts):
//   1. the page's form: a photo, a name, a stage, a tap on the globe: Sent
//   2. it is NOT on the globe, its photo isn't served, the list is empty: only a review shows it
//   3. the review page (its key) approves it with a POST; a wrong key is refused, a GET approves nothing
//   4. now it's a pin; tapping it shows the photo and the words, as text (a <b> in a name stays text)
//   5. the photo's metadata is gone; junk is refused (not a JPEG, a javascript: link, no place); too many from one IP: 429
//   6. Take down: gone from the globe
// Run: node tools/globeprobe.mjs [outdir]   (screenshots there if given)
import { chromium } from "playwright-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const out = process.argv[2], VPORT = 5198, SITE = `http://localhost:${VPORT}`, ADMIN = crypto.randomBytes(24).toString("hex");
const kids = [];
process.on("exit", () => kids.forEach((k) => k.kill()));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (out) mkdirSync(out, { recursive: true });

const vite = spawn("npx", ["vite", "--port", String(VPORT), "--strictPort"], { stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, SHOP_DATABASE_URL_DEV: "pglite", SHOP_MAIL_FILE: "/dev/null", SHOP_ADMIN_TOKEN: ADMIN } });
kids.push(vite);
for (let i = 0; ; i++) { try { if ((await fetch(SITE + "/api/builds")).ok) break; } catch {} if (i > 100) throw new Error("vite didn't start"); await sleep(300); }
const key = (id) => crypto.createHmac("sha256", ADMIN).update("build:" + id).digest("hex").slice(0, 32);
const list = async () => (await (await fetch(SITE + "/api/builds")).json()).builds;

const cache = homedir() + "/Library/Caches/ms-playwright";
const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

// 1. the form
await page.goto(SITE + "/");
await page.locator("#world").scrollIntoViewIfNeeded();
await page.waitForSelector("#world .globe-gl", { timeout: 30000 });
await sleep(1500);
if (out) await page.locator("#world").screenshot({ path: out + "/1-empty.png" });
await page.click("#world .add");
// a photo with EXIF in it, made by the browser so the probe needs no image file
const photo = await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 900; c.height = 600;
  const g = c.getContext("2d"); g.fillStyle = "#e3312c"; g.fillRect(0, 0, 900, 600); g.fillStyle = "#fff"; g.font = "120px sans-serif"; g.fillText("wedgie", 160, 340);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `hsl(${i % 360},70%,50%)`; g.fillRect(Math.random() * 900, Math.random() * 600, 4, 4); }
  const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9))).arrayBuffer());
  const exif = new TextEncoder().encode("Exif\0\0GPS-SECRET-40.5853,-105.0844");
  const seg = new Uint8Array([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif]);
  return Array.from(new Uint8Array([...b.subarray(0, 2), ...seg, ...b.subarray(2)]));
});
await page.setInputFiles("#world input[type=file]", { name: "w.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo) });
await page.waitForSelector("#world .world-drop img:not([hidden])");
await page.fill("#world .name", "Ada <b>bold</b>");
await page.click('#world .world-seg [data-s="running"]');
await page.fill("#world .place", "Fort Collins, CO");
await page.fill("#world textarea.about", "First boot!\n<script>alert(1)</script>");
await page.fill("#world input.link", "@wedgiedev");
await page.click("#world .send");
ok(/Tap the globe/.test(await page.textContent("#world .said")), "no place: it asks for a tap on the globe");
await page.locator("#world .globe-gl").scrollIntoViewIfNeeded();
const gb = await page.locator("#world .globe-gl").boundingBox();
await page.mouse.click(gb.x + gb.width * 0.5, gb.y + gb.height * 0.45);
await page.waitForFunction(() => /Placed at/.test(document.querySelector("#world .world-where").textContent));
if (out) await page.locator("#world").screenshot({ path: out + "/2-form.png" });
await page.click("#world .send");
await page.waitForSelector("#world .done", { timeout: 15000 }).catch(async () => ok(false, "send: " + await page.textContent("#world .world-side")));
ok(true, "the form sends: Sent");

// 2. hidden until reviewed
ok((await list()).length === 0, "not on the globe before review");
const pending = await (await fetch(`${SITE}/api/builds?review=all&k=${key("all")}`)).text();
const id = /review=([0-9a-f]{12})/.exec(pending)?.[1];
ok(id, "the review list (with its key) has it");
ok((await fetch(`${SITE}/api/builds?img=${id}`)).status === 404, "its photo isn't served without the key");
ok((await fetch(`${SITE}/api/builds?review=all&k=${"0".repeat(32)}`)).status === 401, "the review list refuses a wrong key");
ok((await fetch(`${SITE}/api/builds?review=${id}&k=${key("all")}`)).status === 401, "the list's key doesn't open a build");
const img = new Uint8Array(await (await fetch(`${SITE}/api/builds?img=${id}&k=${key(id)}`)).arrayBuffer());
ok(img[0] === 0xff && img[1] === 0xd8 && !Buffer.from(img).includes("GPS-SECRET"), "the stored photo is a JPEG with its metadata cut");

// 3. approve: only a POST with the key
const rev = await (await fetch(`${SITE}/api/builds?review=${id}&k=${key(id)}`)).text();
ok(/Approve/.test(rev) && !/<b>bold/.test(rev) && /&lt;b&gt;/.test(rev), "the review page shows it, its words escaped");
ok((await list()).length === 0, "opening the review page approves nothing");
const form = (k, d) => fetch(SITE + "/api/builds", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ review: id, k, do: d }) });
ok((await form("0".repeat(32), "approve")).status === 401, "approve with a wrong key: refused");
ok((await form(key(id), "approve")).ok && (await list()).length === 1, "approve: on the globe");
ok((await fetch(`${SITE}/api/builds?img=${id}`)).ok, "its photo is served now");

// 4. the pin
await page.reload();
await page.locator("#world").scrollIntoViewIfNeeded();
await page.waitForSelector("#world .globe-gl", { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll("#world .globe-pin:not(.globe-mark)").length === 1);
ok(/1<\/b> wedgie on/.test(await page.innerHTML("#world .world-n")), "the count says 1");
await page.evaluate(() => document.querySelector("#world .globe-pin:not(.globe-mark)").click());   // it may be round the back
await page.waitForSelector("#world .world-build img");
await page.waitForFunction(() => document.querySelector("#world .world-photo").naturalWidth > 0);
await sleep(1200);
if (out) await page.locator("#world").screenshot({ path: out + "/3-pin.png" });
ok(await page.textContent("#world .world-build h3") === "Ada <b>bold</b>" && !(await page.$("#world .world-build h3 b")), "the name is text, not HTML");
ok((await page.textContent("#world .world-note")).includes("<script>"), "the note is text");
ok(await page.getAttribute("#world .world-build .link a", "href") === "https://x.com/wedgiedev", "@handle links to X");
ok(/Running the firmware/.test(await page.textContent("#world .world-stage")), "the stage");

if (out) { await page.setViewportSize({ width: 390, height: 844 }); await sleep(800); await page.locator("#world").screenshot({ path: out + "/4-phone.png" }); }

// 5. junk
const post = (b) => fetch(SITE + "/api/builds", { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": "10.0.0.9" }, body: JSON.stringify(b) });
const good = { name: "x", stage: "printed", lat: 10, lon: 10, img: Buffer.from(img).toString("base64") };
ok((await post({ ...good, img: Buffer.from("<svg onload=alert(1)>").toString("base64") })).status === 400, "not a JPEG: refused");
ok((await post({ ...good, link: "javascript:alert(1)" })).status === 400, "a javascript: link: refused");
ok((await post({ ...good, link: "http://example.com" })).status === 400, "an http link: refused");
ok((await post({ ...good, lat: 999 })).status === 400, "no real place: refused");
ok((await post({ ...good, stage: "x" })).status === 400, "no stage: refused");
const bot = await post({ ...good, website: "spam" });
ok(bot.ok && (await (await fetch(`${SITE}/api/builds?review=all&k=${key("all")}`)).text()).match(/review=/g) === null, "the honeypot: told ok, kept nothing");
const raw = await post({ ...good, img: Buffer.from(photo).toString("base64") });
const rid = (await raw.json()).id;
const rimg = Buffer.from(await (await fetch(`${SITE}/api/builds?img=${rid}&k=${key(rid)}`)).arrayBuffer());
ok(Buffer.from(photo).includes("GPS-SECRET") && rimg[0] === 0xff && !rimg.includes("GPS-SECRET"), "a JPEG sent straight to the API: its EXIF is cut by the server too");
let codes = [];
for (let i = 0; i < 4; i++) codes.push((await post(good)).status);
ok(codes.join() === "200,200,429,429", "3 an hour from one IP, then 429 (" + codes + ")");
ok((await list()).length === 1, "none of that is on the globe");

// 6. take down
ok((await form(key(id), "down")).ok && (await list()).length === 0, "take down: gone");
ok(!errs.length, "no page errors " + errs.join(" | "));
await browser.close();
console.log("globeprobe: all ok");
process.exit(0);
