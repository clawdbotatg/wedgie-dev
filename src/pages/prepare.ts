// /prepare: the last stop before a wedgie goes in its box. Plug it in; a few seconds later its card is
// green (Ready to ship) or red (what's wrong). Nothing to press when it's right. As many at once as there
// are ports, like /update. Checked without the REPL and without changing anything:
//  1. firmware: every core file's sha256 is the latest release's (not just the version it says), and no
//     old .py beside a .mpy (MicroPython would run the .py);
//  2. Welcome is its one app, its files the latest;
//  3. the Trust M: the check every plug-in gets (wedgies.ts prove) signed fresh random bytes with its factory
//     key and its certificate chains to Infineon (chipcheck.ts). The factory key proves the chip is real;
//     it isn't the person's key, so this needs no press. Only that once: Welcome uses the chip too, and a
//     chip request over USB resets it, so one of Welcome's reads caught in it hung 10 s (2026-10-18);
//  4. the rest on its own screen: Welcome's second slide checks the chip's wires, its random, its key slots
//     (empty and unlocked), no saves, and every button as it's pressed (clawdbotatg/wedgie-welcome checks()).
//     The page can't read those without full control, so the person looks at its screen.
// 1 or 2 off: one checked install (the green button on its screen), it restarts, and all of it is checked again.
import * as W from "../serial/wedgies";
import type { Repl } from "../serial/repl";
import { installCore, useApp, firmwareManifest, type Manifest, type Cart } from "../serial/install";
import { benchSetup } from "./format";
import { cmpVersion } from "../apps/appjson.mjs";

type Job = { uid: string; key: number; state: "checking" | "installing" | "restarting" | "screen" | "ready" | "fail"; p: number; what: string;
  lines: string[]; error?: string; at: number; tried: string[]; gone?: boolean };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<Job["state"], string> = { checking: "Checking", installing: "Updating", restarting: "Restarting", screen: "Check its screen", ready: "Ready to ship", fail: "Not ready" };

export function prepare(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page upd-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Prepare to ship</h1>
    <div class="test-status" id="p-status">
      <div class="status-text" id="p-text">Plug in a wedgie</div>
      <div class="status-detail" id="p-detail">Latest firmware, Welcome, a working Trust M, no key locked on it.</div>
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
    $("p-fine").textContent = `Ready means: wedgie ${x.version}, Welcome as its app, its Trust M signed and traced to Infineon, then you tap All green once its own screen shows every row green and all 9 buttons pressed. Out of date: the green button on it updates it.`;
    tick();
  });

  function paint() {
    const list = [...jobs.values()].sort((a, b) => b.at - a.at);
    $("p-grid").innerHTML = list.map((j) => `<div class="upd-card ${j.state === "ready" ? "done" : j.state}${j.gone ? " gone" : ""}" data-uid="${esc(j.uid)}">
        <div class="upd-top"><span class="idtag">${j.uid.startsWith("key") ? "no ID" : esc(j.uid.slice(-6).toUpperCase())}</span><b class="upd-state">${LABEL[j.state]}${j.state === "ready" ? " ✓" : j.state === "fail" ? " ✗" : "…"}</b></div>
        ${j.state === "fail" ? `<div class="upd-line">${esc(j.error)}</div>` : ""}
        ${j.lines.map((l) => `<div class="upd-line fine">${esc(l)}</div>`).join("")}
        ${j.state === "installing" || j.state === "checking" ? `<div class="upd-line fine">${esc(j.what)}</div>` : ""}
        ${j.state === "screen" ? `<div class="row"><button class="btn btn-green" data-ok="1" data-uid="${esc(j.uid)}">All green</button><button class="btn" data-ok="0" data-uid="${esc(j.uid)}">Not green</button></div>` : ""}
        <div class="meter"${j.state === "installing" ? "" : " hidden"}><div class="meter-track"><div class="meter-fill" style="width:${8 + 92 * j.p}%"></div></div></div>
      </div>`).join("");
    const busy = list.filter((j) => j.state !== "ready" && j.state !== "fail" && j.state !== "screen").length;
    const look = list.filter((j) => j.state === "screen" && !j.gone).length;
    const ok = list.filter((j) => j.state === "ready").length, bad = list.filter((j) => j.state === "fail" && !j.gone).length;
    $("p-text").textContent = busy ? `Checking ${busy}…` : look ? "Check its screen" : list.length ? [ok && `${ok} ready`, bad && `${bad} not ready`].filter(Boolean).join(" · ") || "Unplugged" : "Plug in a wedgie";
    $("p-detail").textContent = busy ? "Don't unplug it yet." : look ? "Press every button on it. Every row and all 9 squares green? Tap All green." : list.length ? "Box the green ones. Plug in the next." : "Latest firmware, Welcome, a working Trust M, no key locked on it.";
    $("p-status").className = `test-status ${busy ? "" : bad ? "bad" : list.length ? "good" : ""}`;
  }

  /** What's off in its software, from file hashes (no REPL, no question): the firmware, and Welcome as its
   *  one app. Each is its own question when it's off (EXPECTATIONS.md: one job, one thing). */
  async function software(r: Repl): Promise<{ core: string[]; app: string[] }> {
    const names = [...new Set([...m!.core, ...welcome!.files])];
    const twins = names.filter((n) => n.endsWith(".mpy")).map((n) => n.slice(0, -4) + ".py").filter((n) => !names.includes(n));
    const v = await r.request({ type: "sums", names, exists: twins }, 30000);
    if (v.type !== "sums") throw new Error(`it wouldn't list its files: ${v.error || v.type}`);
    const sha = (n: string) => m!.files.find((f) => f.name === n)?.sha256;
    const core: string[] = [], app: string[] = [];
    const bad = m!.core.filter((n) => v.sums[n] !== sha(n));
    if (bad.length) core.push(`${bad.length} firmware file${bad.length > 1 ? "s" : ""} not the latest`);
    const shadow = twins.filter((n) => v.sums[n]);
    if (shadow.length) core.push(`old ${shadow.join(", ")} on it`);
    if (welcome!.files.some((n) => v.sums[n] !== sha(n))) app.push("Welcome missing or old");
    const mods = (v.apps || []).map((a: any) => a?.mod);
    if (mods.length !== 1 || mods[0] !== "welcome") app.push(mods.length ? `its app is ${mods.join(", ")}, not Welcome` : "no app");
    return { core, app };
  }

  /** The Trust M, from the check every plug-in gets. */
  function trustm(w: W.Wedgie) {
    if (!w.proof?.pass) throw new Error(w.proof?.detail || "the chip wasn't checked");
    if (w.chip?.type !== "OPTIGA Trust M") throw new Error(`its chip is ${w.chip?.type || "unknown"}, not a Trust M`);
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
        const { core, app } = await software(r);
        const off = core.length ? core : app;
        if (off.length) {
          const kind = core.length ? "firmware" : "app";
          if (j.tried.includes(kind)) throw new Error(`Still off after its update: ${off.join("; ")}`);
          j.tried.push(kind);
          Object.assign(j, { state: "installing", what: `${off.join("; ")}. Press the green button on it.` });
          paint();
          const prog = (p: number, what: string) => { j.p = p; if (what) j.what = what; paint(); };
          // the firmware first (its own question), then Welcome (its own), each with a restart
          const res = core.length ? await installCore(r, prog) : await useApp(r, welcome!, prog);
          if (!res.restarted) throw new Error("It can't take a checked install: run it through /test");
          restarting = true;
          return;
        }
        j.lines = [`wedgie ${w.version} + Welcome, every file checked`];
        trustm(w);
        j.lines.push("Trust M signed, traced to Infineon");
      });
      // Its key slots, saves and buttons only show on its own screen (Welcome's checks): a person says.
      if (restarting) { Object.assign(j, { state: "restarting", what: "", at: Date.now() }); W.reidentify(w); }
      else j.state = "screen";
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
      if (j.state === "restarting" && w?.state === "error")
        Object.assign(j, { state: "fail", error: `after its update: ${w.error}` });
      else if (j.state === "restarting" && Date.now() - j.at > 60000)
        Object.assign(j, { state: "fail", error: "didn't come back after its update; unplug it and plug it back in" });
    }
    for (const w of ws) {
      if (w.state === "error") {
        const id = w.uid || "key" + w.key;      // "key<n>": a board that never said its ID
        if (!jobs.has(id)) jobs.set(id, { uid: id, key: w.key, state: "fail", p: 0, what: "", lines: [], tried: [], at: Date.now(),
          error: /No MicroPython/.test(w.error || "") ? "No MicroPython on it: run it through /test" : w.error });
        continue;
      }
      // in install mode (its update's job owns it): wait for the restart after
      if (w.state !== "ready" || !w.uid || running.has(w.key) || w.proof?.detail === "It's installing") continue;
      const j = jobs.get(w.uid);
      const back = j?.state === "restarting" && (w.readyAt || 0) > j.at;          // its own restart after the update
      const again = j && (j.state === "ready" || j.state === "fail" || j.state === "screen") && j.key !== w.key && (w.readyAt || 0) > j.at + 5000;   // plugged in again
      if (j && !back && !again) continue;
      const nj: Job = j || { uid: w.uid, key: w.key, state: "checking", p: 0, what: "", lines: [], tried: [], at: 0 };
      if (again) nj.tried = [];
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
  // the person's word on its screen (the grid is repainted wholesale, so one listener on it)
  $("p-grid").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-ok]");
    const j = b && jobs.get(b.dataset.uid || "");
    if (!j || j.state !== "screen") return;
    Object.assign(j, b!.dataset.ok === "1" ? { state: "ready" } : { state: "fail", error: "Its screen wasn't all green" });
    paint();
  });
  W.onChange(tick);
  setInterval(tick, 5000);        // the 60 s "didn't come back" check
  W.arm();
  W.start();
  $("p-actions").innerHTML = `<p class="fine">Plugged in and nothing happens? No profile yet: <a href="#" id="p-pick">pick it</a></p>`;
  $("p-pick").onclick = (e) => { e.preventDefault(); W.connectNew().catch(() => {}); };
  tick();
}
