// /update: the update bench. Plug wedgies in, as many at once as there are ports; each gets the latest
// firmware core by itself, and its app if that's out of date. Its app and its saves stay. A card per
// wedgie here, and a bar on its own screen; when it has restarted on the new firmware its card goes
// green. Hands-off once the computer has the test-bench profile (same as /format).
//
// USB and resets: the update's one soft reset boots the new core. A wedgie that powered up on firmware
// older than 0.1.3 then adds its WEDGIE drive, so its port drops and comes back as a new one; 0.1.3+
// keeps the port. Either way it's matched by its board ID and re-identified (firmware/boot.py).
import * as W from "../serial/wedgies";
import { installCore, useApp, firmwareManifest, type Manifest } from "../serial/install";
import { benchSetup } from "./format";
import * as F from "../ui/facts";

type Job = { uid: string; key: number; state: "waiting" | "updating" | "restarting" | "done" | "fresh" | "fail"; from: string; board: string;
  p: number; what: string; error?: string; at: number; gone?: boolean };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<Job["state"], string> = { waiting: "Waiting", updating: "Updating", restarting: "Restarting", done: "Updated", fresh: "Already up to date", fail: "Failed" };

export function update(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page upd-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    <h1>Wedgie update bench</h1>
    <div class="test-status" id="u-status">
      <div class="status-text" id="u-text">Plug in wedgies</div>
      <div class="status-detail" id="u-detail">As many as you like. Each one updates by itself.</div>
    </div>
    <div class="upd-grid" id="u-grid"></div>
    <div class="test-actions" id="u-actions"></div>
    <p class="fine" id="u-fine"></p>
    ${benchSetup()}
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  let m: Manifest | undefined;
  const jobs = new Map<string, Job>();
  const running = new Set<number>();           // wedgie keys with an update under way

  firmwareManifest().then((x) => {
    m = x;
    $("u-fine").textContent = `Everything plugged in here gets wedgie ${x.version}. Its app and saves stay; an out-of-date app is updated.`;
    tick();
  });

  function paint() {
    const list = [...jobs.values()].sort((a, b) => b.at - a.at);
    $("u-grid").innerHTML = list.map((j) => {
      const w = W.wedgies().find((x) => x.uid === j.uid);
      const chip = w && w.state === "ready" && j.state !== "updating" ? F.hardware(w).html : esc(j.board);
      const to = j.state === "done" || j.state === "fresh" ? `wedgie ${esc(m?.version)}` : j.from ? `${esc(j.from)} → ${esc(m?.version)}` : `→ ${esc(m?.version)}`;
      return `<div class="upd-card ${j.state}${j.gone ? " gone" : ""}" data-uid="${esc(j.uid)}">
        <div class="upd-top"><span class="idtag">${j.uid.startsWith("key") ? "no ID" : esc(j.uid.slice(-6).toUpperCase())}</span><b class="upd-state">${LABEL[j.state]}${j.state === "done" || j.state === "fresh" ? " ✓" : j.state === "fail" ? " ✗" : "…"}</b></div>
        <div class="upd-line">${to}</div>
        <div class="upd-line fine">${j.state === "fail" ? esc(j.error) : j.gone && j.state !== "restarting" ? "unplugged" : chip}</div>
        <div class="meter"${j.state === "updating" ? "" : " hidden"}><div class="meter-track"><div class="meter-fill" style="width:${8 + 92 * j.p}%"></div></div></div>
      </div>`;
    }).join("");
    const busy = list.filter((j) => j.state === "updating" || j.state === "restarting").length;
    const done = list.filter((j) => j.state === "done" || j.state === "fresh").length, bad = list.filter((j) => j.state === "fail" && !j.gone).length;
    $("u-text").textContent = busy ? `Updating ${busy}…` : list.length ? [done && `${done} updated`, bad && `${bad} failed`].filter(Boolean).join(" · ") || "Unplugged" : "Plug in wedgies";
    $("u-detail").textContent = busy ? "Don't unplug them until they turn green." : list.length ? "Unplug the green ones. Plug in more any time." : "As many as you like. Each one updates by itself.";
    $("u-status").className = `test-status ${busy ? "" : bad ? "bad" : list.length ? "good" : ""}`;
  }

  async function run(w: W.Wedgie, j: Job) {
    running.add(w.key);
    Object.assign(j, { state: "updating", p: 0, what: "", error: undefined, key: w.key, from: w.kind === "wedgie" ? w.version || "" : "", board: w.board || "" });
    paint();
    let restarting = false;
    try {
      await W.withRepl(w, async (r) => {
        const res = await installCore(r, (p, what) => { j.p = p * (0.9); j.what = what; paint(); }, { screen: true });
        for (const c of res.outdated) await useApp(r, c, (p) => { j.p = 0.9 + 0.1 * p; paint(); }, { launcher: false });
        if (res.written || w.kind !== "wedgie") {
          await r.leave();          // the one soft reset: boots the new core (the port may drop and come back)
          restarting = true;
        } else await r.leave({ reset: false });
      });
      if (restarting) { j.state = "restarting"; j.at = Date.now(); W.reidentify(w); }
      else j.state = "fresh";
    } catch (e: any) {
      j.state = "fail";
      j.error = e?.message || String(e);
    }
    running.delete(w.key);
    paint();
  }

  // Every change on USB: start whatever's new, and match wedgies coming back from their restart.
  function tick() {
    if (!m) return;
    const ws = W.wedgies();
    for (const j of jobs.values()) {
      const w = ws.find((x) => (j.uid.startsWith("key") ? "key" + x.key : x.uid) === j.uid);   // "key<n>": a board with no ID
      j.gone = !w;
      if (j.state === "restarting") {
        if (w && w.state === "ready" && (w.readyAt || 0) > j.at) {
          const ok = w.kind === "wedgie" && w.version === m.version;
          // key/at move to the wedgie that came back, so only a later replug counts as "plugged in again"
          Object.assign(j, { state: ok ? "done" : "fail", error: ok ? undefined : `came back on ${w.firmware || "?"}`, key: w.key, at: Date.now() });
        }
        else if (Date.now() - j.at > 60000) Object.assign(j, { state: "fail", error: "didn't come back after its restart; unplug it and plug it back in" });
      }
    }
    for (const w of ws) {
      if (w.state === "error") {
        const j = w.uid ? jobs.get(w.uid) : undefined;
        if (!jobs.has("key" + w.key) && !j) jobs.set("key" + w.key, { uid: "key" + w.key, key: w.key, state: "fail", from: "", board: "", p: 0, what: "", at: Date.now(),
          error: /No MicroPython/.test(w.error || "") ? "No MicroPython on it: set it up at wedgie.dev/format first" : w.error });
        continue;
      }
      if (w.state !== "ready" || !w.uid || running.has(w.key)) continue;
      const j = jobs.get(w.uid);
      // Plugged in again later (a new port, not its own restart): check it again.
      const again = j && (j.state === "done" || j.state === "fresh" || j.state === "fail") && j.key !== w.key && (w.readyAt || 0) > j.at + 5000;
      if (j && !again) continue;
      const nj: Job = j || { uid: w.uid, key: w.key, state: "waiting", from: "", board: "", p: 0, what: "", at: Date.now() };
      nj.at = Date.now();
      jobs.set(w.uid, nj);
      run(w, nj);
    }
    for (const [k, j] of jobs) if (k.startsWith("key") && !ws.some((w) => "key" + w.key === k)) jobs.delete(k);
    paint();
  }

  if (!W.supported()) {
    $("u-text").textContent = "Can't see USB here";
    $("u-detail").textContent = "Open wedgie.dev/update in Chrome or Edge on a computer.";
    return;
  }
  W.onChange(tick);
  setInterval(tick, 5000);        // the 60 s "didn't come back" check
  W.arm();                        // the bench is for people with boards in hand
  W.start();
  $("u-actions").innerHTML = `<p class="fine">Plugged in and nothing happens? No profile yet: <a href="#" id="u-pick">pick it</a></p>`;
  $("u-pick").onclick = (e) => { e.preventDefault(); W.connectNew().catch(() => {}); };
  tick();
}
