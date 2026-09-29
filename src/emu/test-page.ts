// emu.html: a bare page around mountVirtualWedgie, for development and tools/emuprobe.mjs.
// ?app=<mod> picks the app it runs (default hello; ?app= for none).
import { mountVirtualWedgie, type VirtualWedgie } from "./index";

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const log = $("#log");
const add = (s: string) => { log.textContent += s + "\n"; log.scrollTop = log.scrollHeight; };

const vw = await mountVirtualWedgie($("#vw"), { autofocus: true, onOutput: add, app: new URLSearchParams(location.search).get("app") ?? undefined });
setInterval(() => { $("#fps").textContent = vw.fps + " fps"; }, 1000);
$("#reboot").onclick = () => vw.reboot();
$("#shot").onclick = () => { const a = document.createElement("a"); a.href = vw.screenshotPNG(); a.download = "wedgie.png"; a.click(); };
(window as unknown as { vw: VirtualWedgie }).vw = vw;
document.body.dataset.ready = "1";
