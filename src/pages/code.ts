// /code: make software for the wedgie. The prompt to hand your AI (it reads /code.md, the skill), and the
// emulator: open the folder your agent is writing in (or a GitHub repo), play its app in a virtual wedgie,
// and it runs again by itself every time a file changes. Saves outlive runs and can be edited, so a game
// can start at level 8 without playing to it. Then the steps to your own wedgie and to the shelf.
import "./code.css";
import { esc } from "../ui/device";
import { cartHtml } from "../ui/cart";
import { firmwareManifest, cartV, type Cart, type Manifest } from "../serial/install";
import { loadRepo } from "../apps/repos";
import { checkAppJson } from "../apps/appjson.mjs";
import type { VirtualWedgie, ExtraApp } from "../emu";

const STARTER = "clawdbotatg/wedgie-starter";
const PROMPT = "Read https://wedgie.dev/code.md, then make me a wedgie app: ";
const KEY_HELP = `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> joystick · <kbd>Space</kbd> press it in · <kbd>J</kbd><kbd>K</kbd><kbd>L</kbd><kbd>;</kbd> A B X Y · <kbd>R</kbd> run again`;

type Source = { label: string; link?: string; carts: Cart[]; data: Record<string, Uint8Array>; dir?: FileSystemDirectoryHandle; stamp?: string };
type Saves = Record<string, { ext: string; b64: string }>;

// ---- saves kept per app on this browser (the virtual wedgie's flash is new every run) -----------------
const saveKey = (mod: string) => `wedgie.emu.saves.${mod}`;
function getSaves(mod: string): Saves { try { return JSON.parse(localStorage.getItem(saveKey(mod)) || "{}"); } catch { return {}; } }
function putSaves(mod: string, s: Saves) { try { localStorage.setItem(saveKey(mod), JSON.stringify(s)); } catch { /* private window */ } }
const b64dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64enc = (u: Uint8Array) => btoa(String.fromCharCode(...u));

// ---- the last folder opened, kept in IndexedDB so a reload offers it again ------------------------------
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((res) => {
    const o = indexedDB.open("wedgie-code", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onerror = () => res(undefined);
    o.onsuccess = () => { try { const r = fn(o.result.transaction("kv", mode).objectStore("kv")); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); } catch { res(undefined); } };
  });
}

export function code(main: HTMLElement) {
  const canPick = "showDirectoryPicker" in window;
  main.innerHTML = `
  <section class="sec codepage">
    <div class="sec-head">
      <span class="kicker">Code</span>
      <h2>Make games for the wedgie.</h2>
      <p>Hand your AI the skill file and say what to make. Play it here in the emulator while it writes, then put it on your own wedgie.</p>
    </div>

    <div class="card code-prompt">
      <h3>1. Give this to your AI</h3>
      <div class="code-ask recess"><code>${esc(PROMPT)}</code><input id="c-idea" placeholder="a snake game" autocomplete="off" spellcheck="false"></div>
      <div class="row"><button class="btn btn-green" id="c-copy">Copy</button><a class="btn" href="/code.md" target="_blank" rel="noopener">Read the skill</a></div>
      <p class="fine">Claude Code, Codex, Cursor: anything that can read a web page and write files. It makes a folder with a <code>wedgie.json</code> and the game in it.</p>
    </div>

    <div class="card code-emu">
      <h3>2. Play it</h3>
      <div class="code-emu-grid">
        <div>
          <div class="code-vw" id="c-vw"><p class="fine">Open your game's folder, then tap its cartridge.</p></div>
          <p class="fine code-keys">${KEY_HELP}<br>Click the wedgie first. It's an emulator: the speed isn't a real wedgie's.</p>
        </div>
        <div class="code-side">
          <div class="row">
            <button class="btn btn-green btn-sm" id="c-open"${canPick ? "" : " hidden"}>Open a folder</button>
            <button class="btn btn-sm" id="c-reopen" hidden></button>
            <label class="btn btn-sm file-btn"${canPick ? " hidden" : ""}>Open a folder<input type="file" id="c-dirin" webkitdirectory hidden></label>
          </div>
          <form class="row" id="c-try"><input id="c-repo" class="recess name" placeholder="or a GitHub repo: owner/name" autocomplete="off" spellcheck="false"><button class="btn btn-sm">Load</button></form>
          <p class="fine" id="c-note"></p>
          <div class="shelf" id="c-shelf"></div>
          <div class="row code-run" id="c-run" hidden>
            <button class="btn btn-sm" id="c-again">Run again</button>
            <label class="fine"><input type="checkbox" id="c-auto" checked> run again when a file changes</label>
          </div>
          <div id="c-saves" hidden>
            <h4>Saves <span class="fine">kept between runs; edit one to start anywhere</span></h4>
            <div id="c-save-list"></div>
            <textarea class="recess code-save-edit" id="c-save-edit" spellcheck="false" hidden></textarea>
            <div class="row" id="c-save-btns" hidden><button class="btn btn-sm btn-green" id="c-save-put">Save and run again</button><button class="btn btn-sm" id="c-save-del">Delete</button></div>
          </div>
          <h4>Output</h4>
          <pre class="recess out code-out" id="c-out"></pre>
        </div>
      </div>
    </div>

    <ol class="code-steps">
      <li class="card"><span class="num">3</span><h3>On your wedgie</h3><p>Your AI can put it on with <code>wedgie.py install .</code> (the skill says how). Or push it to GitHub, open your wedgie's page in <a href="/connect">Connect</a>, and add the repo under <b>Apps from a GitHub repo</b>.</p></li>
      <li class="card"><span class="num">4</span><h3>For everyone</h3><p>Soon: a list of games anyone can put on their wedgie, from repos people send in. Start from <a href="https://github.com/${STARTER}" target="_blank" rel="noopener">${STARTER}</a> so yours is ready.</p></li>
    </ol>

    <div class="card code-fast">
      <h3>Fast graphics, the short version</h3>
      <p class="fine">Measured on a real wedgie. A full screen push takes 18 ms of a 25 ms frame, so:</p>
      <ul>
        <li><b>Push by DMA.</b> <code>lcd.show_start()</code> sends the frame while the next one's game logic runs; <code>lcd.show_wait()</code> before drawing again.</li>
        <li><b>Push less.</b> <code>lcd.show(y0, y1)</code> sends only those rows (24 rows: 2.4 ms), <code>lcd.show_rect(x, y, w, h)</code> only that box.</li>
        <li><b>Sprites are framebufs.</b> A 16x16 blit is 0.17 ms; 4-bit through a palette is 0.33 ms and a quarter of the RAM.</li>
        <li><b>Viper for pixel loops.</b> Plain Python is 6.8 us a pixel (0.4 s a screen); <code>@micropython.viper</code> is 26x faster.</li>
        <li><b>Nothing new in the loop.</b> A garbage collection costs 8 ms. Reuse lists, build text only when it changes.</li>
      </ul>
      <p class="fine">All of it, with numbers and code: <a href="/code.md">code.md</a>. The <b>Speed lab</b> app times each trick on your own wedgie.</p>
    </div>
  </section>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => main.querySelector(s) as T;
  const note = $("#c-note"), outEl = $("#c-out");

  $("#c-copy").onclick = async () => {
    const text = PROMPT + ($<HTMLInputElement>("#c-idea").value.trim() || "a snake game");
    try { await navigator.clipboard.writeText(text); $("#c-copy").textContent = "Copied"; } catch { $("#c-copy").textContent = "Select and copy it"; }
    setTimeout(() => ($("#c-copy").textContent = "Copy"), 1600);
  };

  let m: Manifest | undefined;
  const ready = firmwareManifest().then((x) => (m = x));
  let src: Source | null = null;
  let mod = "";                          // the app it runs
  let vw: VirtualWedgie | null = null;
  let alive = true;

  const log = (s: string) => {
    outEl.textContent += s + "\n";
    if (outEl.textContent!.length > 20000) outEl.textContent = outEl.textContent!.slice(-15000);
    outEl.scrollTop = outEl.scrollHeight;
  };

  // ---- a folder on this computer: read wedgie.json and the files it names ------------------------------
  async function fileAt(dir: FileSystemDirectoryHandle, path: string) {
    const parts = path.split("/");
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return (await d.getFileHandle(parts[parts.length - 1])).getFile();
  }
  async function readFolder(get: (path: string) => Promise<File>, label: string): Promise<Source> {
    const man = await ready;
    let jf: File;
    try { jf = await get("wedgie.json"); } catch { throw new Error(`${label} has no wedgie.json at its top. Open the folder that has it.`); }
    let j: unknown;
    try { j = JSON.parse(await jf.text()); } catch (e: any) { throw new Error(`wedgie.json isn't valid JSON: ${e.message}`); }
    const { apps, errors } = checkAppJson(j, man.core, []);
    if (errors.length) throw new Error(`wedgie.json: ${errors.join("; ")}`);
    const data: Record<string, Uint8Array> = {}, carts: Cart[] = [];
    let stamp = String(jf.lastModified);
    for (const { paths, ...a } of apps) {
      let size = 0;
      for (let i = 0; i < paths.length; i++) {
        let f: File;
        try { f = await get(paths[i]); } catch { throw new Error(`${a.mod}: ${paths[i]} isn't in the folder`); }
        data[a.files[i]] = new Uint8Array(await f.arrayBuffer());
        size += f.size; stamp += "|" + f.lastModified + ":" + f.size;
      }
      carts.push({ ...a, size, v: await cartV(a.files.map((n) => String(data[n].length))) });
    }
    return { label, carts, data, stamp };
  }
  async function openDir(dir: FileSystemDirectoryHandle) {
    try {
      const s = await readFolder((p) => fileAt(dir, p), dir.name);
      use({ ...s, dir });
      idb("readwrite", (st) => st.put(dir, "dir"));
    } catch (e: any) { note.innerHTML = `<b class="bad">Couldn't open it:</b> ${esc(e?.message || e)}`; }
  }
  $("#c-open").onclick = async () => {
    try { await openDir(await (window as any).showDirectoryPicker({ id: "wedgie-code", mode: "read" })); } catch { /* cancelled */ }
  };
  // Browsers without the folder picker: pick the folder once (no watching for changes then).
  $<HTMLInputElement>("#c-dirin").onchange = async (e) => {
    const list = [...((e.target as HTMLInputElement).files || [])];
    if (!list.length) return;
    const top = list[0].webkitRelativePath.split("/")[0];
    const byPath = new Map(list.map((f) => [f.webkitRelativePath.slice(top.length + 1), f]));
    try { use(await readFolder(async (p) => { const f = byPath.get(p); if (!f) throw new Error("missing"); return f; }, top)); }
    catch (err: any) { note.innerHTML = `<b class="bad">Couldn't open it:</b> ${esc(err?.message || err)}`; }
  };
  if (canPick) idb<FileSystemDirectoryHandle>("readonly", (st) => st.get("dir")).then((dir) => {
    if (!dir || !alive) return;
    const b = $<HTMLButtonElement>("#c-reopen");
    b.hidden = false;
    b.textContent = `Open ${dir.name} again`;
    b.onclick = async () => {
      try { if ((await (dir as any).requestPermission({ mode: "read" })) !== "granted") return; } catch { return; }
      b.hidden = true;
      openDir(dir);
    };
  });

  // ---- a GitHub repo ------------------------------------------------------------------------------------
  async function openRepo(spec: string) {
    note.textContent = `Reading ${spec}…`;
    try {
      const r = await loadRepo(spec, await ready, true);
      use({ label: `${r.repo} at ${r.sha.slice(0, 7)}`, link: `https://github.com/${r.repo}/tree/${r.sha}`, carts: r.carts, data: r.data });
    } catch (e: any) { note.innerHTML = `<b class="bad">Couldn't load it:</b> ${esc(e?.message || e)}`; }
  }
  $<HTMLFormElement>("#c-try").onsubmit = (e) => { e.preventDefault(); const s = $<HTMLInputElement>("#c-repo").value.trim(); if (s) openRepo(s); };

  // ---- the shelf of what's open, and running one ----------------------------------------------------
  function use(s: Source) {
    const again = src && src.label === s.label && s.carts.some((c) => c.mod === mod);
    src = s;
    note.innerHTML = `${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : `<b>${esc(s.label)}</b>`}: ${s.carts.length} app${s.carts.length === 1 ? "" : "s"}. Tap one to play.`;
    $("#c-shelf").innerHTML = s.carts.map((c) => `<div class="cart-slot" data-mod="${esc(c.mod)}"><button class="cart" title="${esc(c.about || "")}">${cartHtml(c)}</button><p class="cart-about">${esc(c.about || "")}</p></div>`).join("");
    $("#c-shelf").querySelectorAll<HTMLButtonElement>("button.cart").forEach((b) => (b.onclick = () => run(b.closest<HTMLElement>(".cart-slot")!.dataset.mod!)));
    $("#c-run").hidden = false;
    $<HTMLInputElement>("#c-auto").parentElement!.hidden = !s.dir;
    if (again) run(mod);
    else if (s.carts.length === 1) run(s.carts[0].mod);
    else paintShelf();
  }
  function paintShelf() {
    $("#c-shelf").querySelectorAll<HTMLElement>(".cart-slot").forEach((el) => el.querySelector(".cart")!.classList.toggle("playing", el.dataset.mod === mod));
  }

  async function run(which: string) {
    if (!src) return;
    const c = src.carts.find((x) => x.mod === which);
    if (!c) return;
    mod = which;
    paintShelf();
    const files: Record<string, Uint8Array> = Object.fromEntries(c.files.map((n) => [n, src!.data[n]]));
    for (const [name, sv] of Object.entries(getSaves(mod))) files[`saves/${mod}/${name}${sv.ext}`] = b64dec(sv.b64);
    const extra: ExtraApp = { app: { mod: c.mod, name: c.name, entry: c.entry, usb: c.usb, about: c.about, v: c.v }, files };
    outEl.textContent = "";
    paintSaves();
    if (!vw) {
      const el = $("#c-vw");
      el.innerHTML = "";
      const { mountVirtualWedgie } = await import("../emu");
      if (!alive) return;
      vw = await mountVirtualWedgie(el, { extra, autofocus: true, onOutput: onLine });
      vw.el.addEventListener("keydown", (e) => { if (e.code === "KeyR" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); run(mod); } });
      (window as any).__codeVw = vw;          // tools/codeprobe.mjs drives it
    } else {
      vw.el.focus();
      await vw.reboot(undefined, extra).catch(() => {});   // "rebooted": a newer run started before this one booted
    }
  }
  $("#c-again").onclick = () => run(mod);

  // Every save.store on the virtual wedgie prints one @emusave line (src/emu/flash.ts): keep it here.
  // Output shows the app's own lines: not the firmware's boot log, nor the slot's JSON on USB.
  function onLine(line: string) {
    if (line.startsWith('{"') || /^(loader|drive|slot): /.test(line)) return;
    if (line.startsWith("@emusave ")) {
      try {
        const e = JSON.parse(line.slice(9));
        const s = getSaves(e.game);
        if (e.del) delete s[e.name]; else s[e.name] = { ext: e.ext, b64: e.b64 };
        putSaves(e.game, s);
        if (e.game === mod) paintSaves();
      } catch { /* a half line */ }
      return;
    }
    log(line);
  }

  // ---- saves: list, edit (JSON as text), delete; a change runs the game again from it -------------------
  let editing = "";
  function paintSaves() {
    const s = getSaves(mod), names = Object.keys(s).sort();
    $("#c-saves").hidden = !mod;
    $("#c-save-list").innerHTML = names.length ? names.map((n) => `<button class="btn btn-sm${n === editing ? " on" : ""}" data-sv="${esc(n)}">${esc(n)}${s[n].ext}</button>`).join(" ")
      : `<p class="fine">None yet. When the game calls <code>save.store("level", 8)</code>, it shows up here.</p>`;
    $("#c-save-list").querySelectorAll<HTMLButtonElement>("[data-sv]").forEach((b) => (b.onclick = () => { editing = editing === b.dataset.sv ? "" : b.dataset.sv!; paintSaves(); }));
    const sv = editing ? s[editing] : undefined;
    if (editing && !sv) editing = "";
    const ta = $<HTMLTextAreaElement>("#c-save-edit");
    ta.hidden = $("#c-save-btns").hidden = !sv;
    if (sv && ta.dataset.for !== editing + sv.b64) {
      ta.dataset.for = editing + sv.b64;
      const raw = b64dec(sv.b64);
      ta.value = sv.ext === ".json" ? JSON.stringify(JSON.parse(new TextDecoder().decode(raw)), null, 1) : "base64:" + sv.b64;
      ta.readOnly = sv.ext !== ".json";
    }
  }
  $("#c-save-put").onclick = () => {
    const s = getSaves(mod), ta = $<HTMLTextAreaElement>("#c-save-edit");
    if (!s[editing] || s[editing].ext !== ".json") return;
    try { s[editing].b64 = b64enc(new TextEncoder().encode(JSON.stringify(JSON.parse(ta.value)))); }
    catch (e: any) { log(`that save isn't valid JSON: ${e.message}`); return; }
    putSaves(mod, s);
    run(mod);
  };
  $("#c-save-del").onclick = () => { const s = getSaves(mod); delete s[editing]; putSaves(mod, s); editing = ""; run(mod); };

  // ---- run again when a file in the folder changes -----------------------------------------------------
  let checking = false;
  const watch = setInterval(async () => {
    if (!src?.dir || checking || !$<HTMLInputElement>("#c-auto").checked || document.hidden) return;
    checking = true;
    try {
      const s = await readFolder((p) => fileAt(src!.dir!, p), src.dir.name);
      if (s.stamp !== src.stamp) { log("— a file changed: running it again —"); use({ ...s, dir: src.dir }); }
    } catch (e: any) { if (src) src.stamp = ""; note.innerHTML = `<b class="bad">${esc(e?.message || e)}</b>`; }
    checking = false;
  }, 1000);

  return () => { alive = false; clearInterval(watch); vw?.destroy(); vw = null; };
}
