// /prepare: the last stop before a wedgie goes in its box. Plug it in; a few seconds later its card is
// green (Ready to ship) or red (what's wrong). Nothing to press when it's right. As many at once as there
// are ports, like /update. Checked without the REPL and without changing anything:
//  1. firmware: every core file's sha256 is the latest release's (not just the version it says), and no
//     old .py beside a .mpy (MicroPython would run the .py);
//  2. Welcome is its one app, its files the latest;
//  3. the Trust M, asked ROUNDS times: each time it signs fresh random bytes with its factory key and its
//     certificate chains to Infineon (chipcheck.ts); the same certificate every time, no random repeated.
// 1 or 2 off: one checked install (the green button on its screen), it restarts, and all of it is checked again.
import * as W from "../serial/wedgies";
import type { Repl } from "../serial/repl";
import { coreWithApp, firmwareManifest, type Manifest, type Cart } from "../serial/install";
import { checkChip } from "../serial/chipcheck";
import { benchSetup } from "./format";
import { cmpVersion } from "../apps/appjson.mjs";

/** Trust M rounds on top of the one every plug-in gets (wedgies.ts prove): ~0.5 s each. */
const ROUNDS = 5;
type Job = { uid: string; key: number; state: "checking" | "installing" | "restarting" | "ready" | "fail"; p: number; what: string;
  lines: string[]; error?: string; at: number; installed?: boolean; gone?: boolean };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<Job["state"], string> = { checking: "Checking", installing: "Updating", restarting: "Restarting", ready: "Ready to ship", fail: "Not ready" };

export function prepare(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page upd-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Prepare to ship</h1>
    <div class="test-status" id="p-status">
      <div class="status-text" id="p-text">Plug in a wedgie</div>
      <div class="status-detail" id="p-detail">Latest firmware, Welcome, a working Trust M. Checked in seconds.</div>
    </div>
    <div class="upd-grid" id="p-grid"></div>
    <div class="test-actions" id="p-actions"></div>
    <p class="fine" id="p-fine"></p>
    ${benchSetup()}
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  let m: Manifest | undefined, welcome: Cart | undefined;
  const jobs = new Map<string, Job>();
  const running = new Set<number>();

  firmwareManifest().then((x) => {
    m = x;
    welcome = x.carts.find((c) => c.mod === "welcome");
    $("p-fine").textContent = `Ready means: wedgie ${x.version}, Welcome as its app, its Trust M signed ${ROUNDS + 1} times and traced to Infineon. Out of date: the green button on it updates it.`;
    tick();
  });

  function paint() {
    const list = [...jobs.values()].sort((a, b) => b.at - a.at);
    $("p-grid").innerHTML = list.map((j) => `<div class="upd-card ${j.state === "ready" ? "done" : j.state}${j.gone ? " gone" : ""}" data-uid="${esc(j.uid)}">
        <div class="upd-top"><span class="idtag">${j.uid.startsWith("key") ? "no ID" : esc(j.uid.slice(-6).toUpperCase())}</span><b class="upd-state">${LABEL[j.state]}${j.state === "ready" ? " ✓" : j.state === "fail" ? " ✗" : "…"}</b></div>
        ${j.state === "fail" ? `<div class="upd-line">${esc(j.error)}</div>` : ""}
        ${j.lines.map((l) => `<div class="upd-line fine">${esc(l)}</div>`).join("")}
        ${j.state === "installing" || j.state === "checking" ? `<div class="upd-line fine">${esc(j.what)}</div>` : ""}
        <div class="meter"${j.state === "installing" ? "" : " hidden"}><div class="meter-track"><div class="meter-fill" style="width:${8 + 92 * j.p}%"></div></div></div>
      </div>`).join("");
    const busy = list.filter((j) => j.state !== "ready" && j.state !== "fail").length;
    const ok = list.filter((j) => j.state === "ready").length, bad = list.filter((j) => j.state === "fail" && !j.gone).length;
    $("p-text").textContent = busy ? `Checking ${busy}…` : list.length ? [ok && `${ok} ready`, bad && `${bad} not ready`].filter(Boolean).join(" · ") || "Unplugged" : "Plug in a wedgie";
    $("p-detail").textContent = busy ? "Don't unplug it yet." : list.length ? "Box the green ones. Plug in the next." : "Latest firmware, Welcome, a working Trust M. Checked in seconds.";
    $("p-status").className = `test-status ${busy ? "" : bad ? "bad" : list.length ? "good" : ""}`;
  }

  /** What's off in its software, from file hashes (no REPL, no question). [] = the latest core + Welcome only. */
  async function software(r: Repl): Promise<string[]> {
    const names = [...new Set([...m!.core, ...welcome!.files])];
    const twins = names.filter((n) => n.endsWith(".mpy")).map((n) => n.slice(0, -4) + ".py").filter((n) => !names.includes(n));
    const v = await r.request({ type: "sums", names, exists: twins }, 30000);
    if (v.type !== "sums") throw new Error(`it wouldn't list its files: ${v.error || v.type}`);
    const sha = (n: string) => m!.files.find((f) => f.name === n)?.sha256;
    const off: string[] = [];
    const core = m!.core.filter((n) => v.sums[n] !== sha(n));
    if (core.length) off.push(`${core.length} firmware file${core.length > 1 ? "s" : ""} not the latest`);
    if (welcome!.files.some((n) => v.sums[n] !== sha(n))) off.push("Welcome missing or old");
    const mods = (v.apps || []).map((a: any) => a?.mod);
    if (mods.length !== 1 || mods[0] !== "welcome") off.push(mods.length ? `its app is ${mods.join(", ")}, not Welcome` : "no app named");
    const shadow = twins.filter((n) => v.sums[n]);
    if (shadow.length) off.push(`old ${shadow.join(", ")} on it`);
    return off;
  }

  /** The Trust M, ROUNDS more times. Each answer checked on its own; across them, one certificate and no random twice. */
  async function pound(w: W.Wedgie, r: Repl, j: Job) {
    if (!w.proof?.pass) throw new Error(w.proof?.detail || "the chip wasn't checked");
    if (w.chip?.type !== "OPTIGA Trust M") throw new Error(`its chip is ${w.chip?.type || "unknown"}, not a Trust M`);
    const certs = new Set<string>(), rand = new Set<string>();
    for (let i = 1; i <= ROUNDS; i++) {
      j.what = `Trust M ${i + 1}/${ROUNDS + 1}`; paint();
      const d = await r.request({ type: "chip" }, 15000);
      if (d.kind !== "trustm") throw new Error(`Trust M round ${i + 1}: ${d.error || "no answer"}`);
      const k = await checkChip(d);
      if (!k.pass) throw new Error(`Trust M round ${i + 1}: ${k.detail}`);
      certs.add(d.cert);
      d.random.forEach((x: string) => rand.add(x));
    }
    if (certs.size !== 1) throw new Error("Trust M gave different certificates");
    if (rand.size !== ROUNDS * 2) throw new Error("Trust M repeated a random number");
  }

  async function run(w: W.Wedgie, j: Job) {
    running.add(w.key);
    Object.assign(j, { state: "checking", key: w.key, p: 0, what: "Firmware", lines: [], error: undefined });
    paint();
    let restarting = false;
    try {
      if (w.kind !== "wedgie" || !w.version) throw new Error(w.kind === "micropython" ? "No wedgie firmware: run it through /test" : `Runs ${w.firmware || "something else"}: run it through /test`);
      if (cmpVersion(w.version, "0.3.12") < 0) throw new Error(`Firmware ${w.version} is too old for this: run it through /test`);
      await W.withRepl(w, async (r) => {
        const off = await software(r);
        if (off.length) {
          if (j.installed) throw new Error(`Still off after its update: ${off.join("; ")}`);
          Object.assign(j, { state: "installing", what: `${off.join("; ")}. Press the green button on it.` });
          paint();
          const ok = await coreWithApp(r, welcome!, (p, what) => { j.p = p; if (what) j.what = what; paint(); });
          if (!ok) throw new Error("It can't take a checked install: run it through /test");
          j.installed = true;
          restarting = true;
          return;
        }
        j.lines = [`wedgie ${w.version} + Welcome, every file checked`];
        await pound(w, r, j);
        j.lines.push(`Trust M signed ${ROUNDS + 1}×, traced to Infineon`);
      });
      if (restarting) { Object.assign(j, { state: "restarting", what: "", at: Date.now() }); W.reidentify(w); }
      else j.state = "ready";
    } catch (e: any) {
      j.state = "fail";
      j.error = e?.message || String(e);
    }
    running.delete(w.key);
    paint();
  }

  // Every change on USB: start whatever's new, and pick up wedgies coming back from their update's restart.
  function tick() {
    if (!m) return;
    if (!welcome) { $("p-text").textContent = "Welcome isn't on the shelf"; return; }
    const ws = W.wedgies();
    for (const j of jobs.values()) {
      const w = ws.find((x) => (j.uid.startsWith("key") ? "key" + x.key : x.uid) === j.uid);
      j.gone = !w;
      if (j.state === "restarting" && !w && Date.now() - j.at > 60000)
        Object.assign(j, { state: "fail", error: "didn't come back after its update; unplug it and plug it back in" });
    }
    for (const w of ws) {
      if (w.state === "error") {
        const id = w.uid || "key" + w.key;      // "key<n>": a board that never said its ID
        if (!jobs.has(id)) jobs.set(id, { uid: id, key: w.key, state: "fail", p: 0, what: "", lines: [], at: Date.now(),
          error: /No MicroPython/.test(w.error || "") ? "No MicroPython on it: run it through /test" : w.error });
        continue;
      }
      // in install mode (its update's job owns it): wait for the restart after
      if (w.state !== "ready" || !w.uid || running.has(w.key) || w.proof?.detail === "It's installing") continue;
      const j = jobs.get(w.uid);
      const back = j?.state === "restarting" && (w.readyAt || 0) > j.at;          // its own restart after the update
      const again = j && (j.state === "ready" || j.state === "fail") && j.key !== w.key && (w.readyAt || 0) > j.at + 5000;   // plugged in again
      if (j && !back && !again) continue;
      const nj: Job = j || { uid: w.uid, key: w.key, state: "checking", p: 0, what: "", lines: [], at: 0 };
      if (again) nj.installed = false;
      nj.at = Date.now();
      jobs.set(w.uid, nj);
      run(w, nj);
    }
    for (const [k, j] of jobs) if (k.startsWith("key") && j.gone) jobs.delete(k);
    paint();
  }

  if (!W.supported()) {
    $("p-text").textContent = "Can't see USB here";
    $("p-detail").textContent = "Open wedgie.dev/prepare in Chrome or Edge on a computer.";
    return;
  }
  W.onChange(tick);
  setInterval(tick, 5000);        // the 60 s "didn't come back" check
  W.arm();
  W.start();
  $("p-actions").innerHTML = `<p class="fine">Plugged in and nothing happens? No profile yet: <a href="#" id="p-pick">pick it</a></p>`;
  $("p-pick").onclick = (e) => { e.preventDefault(); W.connectNew().catch(() => {}); };
  tick();
}
