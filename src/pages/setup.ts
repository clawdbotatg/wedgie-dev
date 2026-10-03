// /connect's "set it up" card: a board that has no wedgie firmware yet, at the top of the list. What /format
// does to a new unit, minus the tests: a Pico in BOOTSEL (a blank one boots there; WebUSB, not serial, so the
// Connect picker never lists it) gets wiped + MicroPython (picoboot.ts), the W build if it has the Pico W's
// WiFi chip, then the wedgie firmware core. Its app gets picked on its own page after.
// Three kinds of board show up here:
//  - boot: a Pico in BOOTSEL this site may use (the test-bench profile, or picked once with "a new Pico");
//  - other: a serial board with no MicroPython (a maker's demo): the 1200-baud knock reboots it into BOOTSEL;
//  - bare: plain MicroPython with nothing on it.
// Nothing starts until Set up is pressed (it wipes the board). Nothing here looks at USB until this browser
// tapped Connect once (wedgies.ts armed), except "a new Pico", which is a tap.
import * as W from "../serial/wedgies";
import { installCore } from "../serial/install";
import { usbSupported, bootDevices, isBoot, pickBoot, flashMicroPython, BOOT_PIDS } from "../serial/picoboot";
import { esc } from "../ui/device";

type Job = { stage: "boot" | "flash" | "back" | "install" | "done" | "fail"; text: string; detail: string; p: number | null; since: number; wifi: boolean; pick?: "boot" | "serial" };
let bench: Promise<string> | null = null;
const benchPy = () => (bench ??= fetch("/device/bench.py").then((r) => { if (!r.ok) throw new Error("bench.py missing"); return r.text(); }));
const bare = (w: W.Wedgie) => w.state === "ready" && w.kind === "micropython" && w.firmware === "nothing yet";
const other = (w: W.Wedgie) => w.state === "error" && /No MicroPython/.test(w.error || "");
/** Boards the card owns: /connect leaves them out of its rows. */
export const needsSetup = (w: W.Wedgie) => other(w);

export function setupCard(el: HTMLElement) {
  let job: Job | null = null;
  let boots: USBDevice[] = [];
  let alive = true;
  let usb = false;                // may look at WebUSB: armed, or a new Pico was picked here

  const paint = () => {
    if (!alive) return;
    if (job) {
      const tone = job.stage === "done" ? " good" : job.stage === "fail" ? " bad" : "";
      el.innerHTML = `<div class="setup card${tone}"><h3>${esc(job.text)}</h3><p class="fine">${esc(job.detail)}</p>
        <div class="meter" ${job.p === null ? "hidden" : ""}><div class="meter-track"><div class="meter-fill" style="width:${8 + 92 * (job.p || 0)}%"></div></div></div>
        ${job.pick ? `<div class="row"><button class="btn btn-green" id="setup-pick">Pick it</button><span class="fine">It's called <b>${job.pick === "boot" ? "RP2 Boot or RP2350 Boot" : "Board in FS mode"}</b>.</span></div>` : ""}
        ${job.stage === "done" || job.stage === "fail" ? `<div class="row"><button class="btn" id="setup-ok">OK</button></div>` : ""}</div>`;
      el.querySelector<HTMLElement>("#setup-pick")?.addEventListener("click", () =>
        void (job?.pick === "boot" ? pickBoot().then(() => { usb = true; if (job) job.pick = undefined; look(); }) : W.connectNew().then(() => { if (job) job.pick = undefined; paint(); })).catch(() => {}));
      el.querySelector<HTMLElement>("#setup-ok")?.addEventListener("click", () => { job = null; look(); });
      return;
    }
    const items = [
      ...boots.map((d, i) => ({ id: `b${i}`, what: `A new Pico (${BOOT_PIDS[d.productId]}, in boot mode)`, go: () => flash(d) })),
      ...W.wedgies().filter(other).map((w) => ({ id: `o${w.key}`, what: "A board with something else on it (not MicroPython)", go: () => knock(w) })),
      ...W.wedgies().filter(bare).map((w) => ({ id: `m${w.key}`, what: `${w.short} · ${w.board}: MicroPython, no wedgie firmware`, go: () => install(w) })),
    ];
    if (!items.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="setup card"><h3>Not set up yet</h3>
      ${items.map((x) => `<div class="setup-item"><span>${esc(x.what)}</span><button class="btn btn-green setup-go" data-id="${x.id}">Set up</button></div>`).join("")}
      <p class="fine">Set up wipes it, then puts on MicroPython and the wedgie firmware. Pick its app after.</p></div>`;
    for (const x of items) el.querySelector<HTMLElement>(`[data-id="${x.id}"]`)!.onclick = () => void x.go();
  };
  const set = (j: Partial<Job>) => { job = { ...(job || { stage: "boot", text: "", detail: "", p: null, since: Date.now(), wifi: false }), ...j }; paint(); };
  const fail = (e: any, what: string) => set({ stage: "fail", text: "Set up failed", detail: `${what}: ${e?.message || e}. Unplug it, hold BOOTSEL, plug it back in, and try again.`, p: null, pick: undefined });

  async function look() {
    if (!alive) return;
    boots = W.armed() || usb ? await bootDevices().catch(() => []) : [];
    if (job?.stage === "boot" && boots.length) return void flash(boots[0]);
    if (job?.stage === "back") {
      const w = W.wedgies().find((x) => x.state === "ready" && x.kind === "micropython" && (x.readyAt || 0) > job!.since);
      if (w) return void install(w);
    }
    paint();
  }
  // Waiting on a board to come back by itself: without the test-bench profile it needs a tap.
  const needPick = (stage: Job["stage"], what: "boot" | "serial"): unknown =>
    setTimeout(() => {
      if (job?.stage !== stage || Date.now() - job.since < 8000) return;
      if (what === "serial" && W.wedgies().some((w) => w.state === "identifying")) return void needPick(stage, what);   // it's back, still being asked
      set({ pick: what });
    }, 8000);

  // A serial board with something else on it: opening it at 1200 baud is the standard "reboot into BOOTSEL".
  async function knock(w: W.Wedgie) {
    set({ stage: "boot", text: "Restarting it into boot mode…", detail: "It came with something else on it. That gets wiped.", since: Date.now() });
    try { await w.port.open({ baudRate: 1200 }); await w.port.close(); } catch {}
    needPick("boot", "boot");
  }

  async function flash(dev: USBDevice) {
    const wifi = !!job?.wifi;
    set({ stage: "flash", text: wifi ? "It has WiFi: WiFi MicroPython going on…" : "Wiping it, putting MicroPython on…", detail: "Don't unplug it.", p: 0, pick: undefined });
    try { await flashMicroPython(dev, (p) => set({ p }), wifi); }
    catch (e) { return fail(e, "MicroPython didn't go on"); }
    set({ stage: "back", text: "Restarting it…", detail: "A few seconds.", p: null, since: Date.now() });
    needPick("back", "serial");
  }

  async function install(w: W.Wedgie) {
    set({ stage: "install", text: "Installing the wedgie firmware…", detail: "Don't unplug it.", p: 0, pick: undefined });
    let reboot = false;
    try {
      await W.withRepl(w, async (r) => {
        await r.enter({ reset: true });          // bare MicroPython: no drive, a reset is safe
        // A Pico W on the plain build: go round once more for the W build (as /format does).
        await r.exec(await W.probe(), 10000);
        await r.exec(await benchPy(), 10000);
        let b: any = null;
        r.onLine = (t, v) => { if (t === "board") b = v; };
        await r.exec("board()", 15000);
        if (b?.wifi && !b.wbuild && !job?.wifi) { reboot = true; await r.write("import machine\nmachine.bootloader()\x04"); return; }
        await installCore(r, (p, what) => set({ p, detail: `${what}. Don't unplug it.` }), { launcher: false });
        await r.leave();                         // the one soft reset: it boots into the new firmware
      });
    } catch (e) { return fail(e, "The firmware didn't go on"); }
    if (reboot) { set({ stage: "boot", wifi: true, text: "It has WiFi: restarting into boot mode…", detail: "For the WiFi build of MicroPython.", p: null, since: Date.now() }); return needPick("boot", "boot"); }
    W.reidentify(w);
    set({ stage: "done", text: `${w.short} is set up`, detail: "It's restarting on the wedgie firmware. Tap it below to pick its app.", p: null });
  }

  const onUsb = (e: Event) => { if (isBoot((e as USBConnectionEvent).device)) setTimeout(look, 300); };
  const onUsbOff = () => setTimeout(look, 300);
  if (usbSupported()) { navigator.usb.addEventListener("connect", onUsb); navigator.usb.addEventListener("disconnect", onUsbOff); }
  const off = W.onChange(look);
  look();
  return {
    /** A Pico in BOOTSEL this site hasn't been allowed yet (no profile): the browser's USB picker. */
    pickNew: () => usbSupported() ? pickBoot().then(() => { usb = true; look(); }, () => {}) : undefined,
    stop() {
      alive = false; off();
      if (usbSupported()) { navigator.usb.removeEventListener("connect", onUsb); navigator.usb.removeEventListener("disconnect", onUsbOff); }
    },
  };
}
