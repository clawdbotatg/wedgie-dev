// /reset: the link to send someone whose wedgie is stuck on old firmware (or won't start). It never talks to
// the old firmware: they hold BOOTSEL while plugging in, tap Find it (WebUSB, "RP2 Boot"), then Reset it,
// and /connect's set-up card (setup.ts) wipes it, puts on MicroPython (the W build if it has WiFi), the
// latest wedgie firmware and Welcome. Its apps and saves are wiped; the chip and its keys aren't touched.
// Nothing looks at USB until Find it is tapped.
import * as W from "../serial/wedgies";
import { usbSupported, bootDevices } from "../serial/picoboot";
import { setupCard } from "./setup";

export function reset(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page">
    <h1>Reset a wedgie</h1>
    <p class="test-safe">Puts the latest firmware on, whatever is on it now. It never changes the chip. Your crypto stays safe.</p>
    <div class="boot-hint card">
      <div class="boot-hint-3d" id="r-3d"></div>
      <div><h3>Hold BOOTSEL, plug it in</h3>
      <p>1. Unplug it.</p>
      <p>2. Press the button through the hole in the back with a paperclip. Keep holding it.</p>
      <p>3. Plug in the USB cable. Let go once it's in. Its screen stays dark.</p></div>
    </div>
    <div class="test-actions" id="r-actions"></div>
    <div id="r-setup"></div>
    <p class="fine">Its apps and saves get wiped. Nothing shows up? Try another cable (some only charge) and hold the button again.</p>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  import("../ui/bootsel3d").then((m) => m.mountBootsel3D($("r-3d"), { install: true })).catch(() => {});
  if (!W.supported() || !usbSupported()) {
    $("r-actions").innerHTML = `<p class="fine">Can't see USB here. Open wedgie.dev/reset in Chrome or Edge on a computer.</p>`;
    return;
  }
  let card: ReturnType<typeof setupCard> | null = null;
  $("r-actions").innerHTML = `<button class="btn btn-green" id="r-find">Find it</button>
    <p class="fine">Chrome lists it as <b>RP2 Boot</b> or <b>RP2350 Boot</b>.</p>`;
  $("r-find").onclick = async () => {
    W.arm();                      // the tap: now the page may look at USB (it waits for the board after its wipe)
    W.start();
    card ??= setupCard($("r-setup"), { reset: true });
    if (!(await bootDevices().catch(() => [])).length) card.pickNew();
  };
}
