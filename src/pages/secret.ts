// /secret: chat where only a wedgie can read what it's sent. The wedgie app is clawdbotatg/wedgie-secret; the
// format is src/secret/box.ts; the mailbox is api/chat.ts (sealed text only, gone after 7 days).
//   /secret#<key>  someone's share link: add them (or, with no wedgie of your own, write to them once)
//   /secret        your wedgie's key and link, your chats. What you write is sealed here to their key and
//                  sent; what they write shows only on your wedgie's screen (a green press for each one;
//                  wedgie-secret 3+ never shows the sender's name, which only this page vouches for). Never on this page.
// The key rides in the # so it never reaches a server. Kept in this browser (localStorage, per key of yours):
// your chats' names and keys, their sealed messages, and the text you sent (you typed it here anyway).
import * as W from "../serial/wedgies";
import * as Drive from "../serial/drive";
import * as S from "../secret/box";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const msgOf = (e: any) => e?.message || String(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
const when = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const POLL = 4000;

type Msg = { n: number; from: string; blob: string; at: number };
type Sent = { at: number; text: string };
type Book = { names: Record<string, string>; inbox: Msg[]; sent: Record<string, Sent[]>; after: number; seen: Record<string, number> };

const me0 = () => { try { return JSON.parse(localStorage.getItem("secret:me") || "null"); } catch { return null; } };
function loadBook(pub: string): Book {
  try { const b = JSON.parse(localStorage.getItem("secret:" + pub) || ""); if (b && b.names) return { seen: {}, ...b }; } catch {}
  return { names: {}, inbox: [], sent: {}, after: 0, seen: {} };
}
const saveBook = (pub: string, b: Book) => { try { localStorage.setItem("secret:" + pub, JSON.stringify(b)); } catch {} };

async function boxOf(pub: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pub))));
}
async function post(to: string, from: string, blob: string) {
  const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, from, blob }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The mailbox said ${r.status}.`);
}

export function secret(main: HTMLElement) {
  main.innerHTML = `
  <section class="test-page safe-page secret-page">
    <div class="safe-box recess" id="x-me"></div>
    <div class="safe-box recess" id="x-add" hidden></div>
    <div class="safe-box recess" id="x-chats" hidden></div>
    <div class="safe-box recess" id="x-thread" hidden>
      <h2 id="x-who"></h2>
      <div id="x-msgs" class="chat-msgs"></div>
      <textarea id="x-text" rows="3" placeholder="Your message"></textarea>
      <p class="row"><button class="btn btn-green" id="x-send" disabled>Send</button> <span id="x-smsg" class="fine"></span></p>
    </div>
  </section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const copy = (s: string, b: HTMLElement) => navigator.clipboard.writeText(s).then(() => { const t = b.textContent; b.textContent = "Copied"; setTimeout(() => b.textContent = t, 1200); }, () => {});

  // me: your wedgie's key, remembered so the chats show with it unplugged
  let me: { pub: string; id: string } | null = me0();
  let book: Book | null = me ? loadBook(me.pub) : null;
  let open: string | null = null;          // the chat on screen: their key's hex
  let onWedgie: string | null = null;      // the chat open on the wedgie (its name there), so new ones go straight to it
  const nameOf = (pub: string) => book?.names[pub] || "";

  // ---- the wedgie ----
  const DRIVE = { key: -1, state: "ready", running: "secret", short: "", log: "" } as unknown as W.Wedgie;
  let driveState = "";
  const ask = <T,>(w: W.Wedgie, fn: (r: Drive.Asker) => Promise<T>): Promise<T> => w === DRIVE ? Drive.withDrive(fn) : W.withRepl(w, fn);
  const ready = () => Drive.inApp() ? (driveState === "here" ? [DRIVE] : []) : W.wedgies().filter((w) => w.state === "ready");
  let wedgie: W.Wedgie | null = null, live: { pub: string; id: string } | null = null, noKey = false, tries = 0, busy = false;

  async function readKey(w: W.Wedgie) {
    wedgie = w;
    try {
      const h = await ask(w, (r) => r.request({ type: "hello" }, 5000));
      live = h.secret || null;
      noKey = !live;
      tries = 0;
      if (live && live.pub !== me?.pub) {
        me = { pub: live.pub, id: live.id };
        try { localStorage.setItem("secret:me", JSON.stringify(me)); } catch {}
        book = loadBook(me.pub);
        open = null;
        onWedgie = null;
        poll();
      }
      paintAll();
      if (noKey) { await sleep(3000); if (wedgie === w) { wedgie = null; paintMe(); } }   // look again: the wedgie's own green makes it
    } catch {
      if (++tries <= 6) { await sleep(800 * tries); wedgie = null; paintMe(); }    // a port still held by the last page
    }
  }

  function paintMe() {
    const ws = ready(), app = ws.filter((w) => w.running === "secret");
    if (wedgie && !ws.includes(wedgie)) { wedgie = null; live = null; noKey = false; onWedgie = null; }
    let h = `<h2>Your wedgie</h2>`;
    if (Drive.inApp() && !ws.length) h += `<p class="fine">Plug in your wedgie. <button class="btn btn-sm" id="x-drive">Find it</button></p>`;
    else if (!Drive.inApp() && !W.supported()) h += `<p class="fine">This browser can't talk to a wedgie over USB. Use Chrome, Edge or Brave on a computer.</p>`;
    else if (!ws.length) h += `<p class="fine">Plug it in. Not showing? <a href="/connect">Connect</a> it first.</p>`;
    else if (!app.length) h += `<p class="fine">It isn't running Secrets. <a class="btn btn-sm btn-green" href="/connect/${esc(ws[0].short)}">Install Secrets</a> (on its page, Software: Apps from a GitHub repo, add <b class="mono">clawdbotatg/wedgie-secret</b>).</p>`;
    else if (!live) h += noKey ? `<p><b>Press green on the wedgie to make its key.</b></p>` : `<p class="fine">Reading its key.</p>`;
    if (me) h += `<p>Key <b class="mono">${esc(me.id)}</b>${live ? " (the wedgie shows the same)" : ""}</p>
      <p class="row"><button class="btn btn-sm" id="x-link">Copy my link</button> <span class="fine">Give it out: anyone with it can write to you.</span></p>`;
    $("x-me").innerHTML = h;
    $("x-drive")?.addEventListener("click", () => Drive.panel());
    $("x-link")?.addEventListener("click", () => copy(S.link(unhex(me!.pub), location.origin), $("x-link")));
    if (app.length && !live && wedgie !== app[0]) readKey(app[0]);
    paintSend();
  }

  // ---- add someone: a link in the #, or pasted ----
  async function paintAdd() {
    const box = $("x-add"), k = S.parseKey(location.hash.slice(1));
    const pub = k ? hex(k) : "";
    if (k && me && pub === me.pub) { history.replaceState(null, "", "/secret"); return paintAdd(); }
    if (k && me && book!.names[pub]) { history.replaceState(null, "", "/secret"); show(pub); return paintAdd(); }
    box.hidden = !k && !me;
    if (!k) {
      box.innerHTML = `<h2>Add someone</h2>
        <p><input id="x-key" placeholder="Their wedgie.dev/secret link" style="width:100%"></p>`;
      $("x-key").oninput = () => { const kk = S.parseKey(($("x-key") as HTMLInputElement).value); if (kk) location.hash = S.b64u(kk); };
      return;
    }
    const id = await S.keyId(k);
    if (!me) {             // no wedgie of yours: write to them once, no replies
      box.innerHTML = `<h2>Write to <span class="mono">${esc(id)}</span></h2>
        <textarea id="x-one" rows="5" placeholder="Your message"></textarea>
        <p class="row"><button class="btn btn-green" id="x-onesend" disabled>Send</button> <span id="x-onemsg" class="fine"></span></p>
        <p class="fine">Only the wedgie showing <b class="mono">${esc(id)}</b> can read it. To get replies, plug in your own wedgie running Secrets.</p>`;
      const t = $("x-one") as HTMLTextAreaElement, b = $("x-onesend") as HTMLButtonElement;
      t.oninput = () => { const n = S.size(t.value); b.disabled = !n || n > S.MAX; $("x-onemsg").innerHTML = n > S.MAX ? `<b class="bad">${n} / ${S.MAX} bytes: too long</b>` : ""; };
      b.onclick = async () => {
        b.disabled = true;
        try { await post(pub, "", await S.seal(k, t.value)); t.value = ""; $("x-onemsg").innerHTML = `<span class="good">Sent.</span>`; }
        catch (e) { $("x-onemsg").innerHTML = `<b class="bad">${esc(msgOf(e))}</b>`; b.disabled = false; }
      };
      box.hidden = false;
      return;
    }
    box.innerHTML = `<h2>Add <span class="mono">${esc(id)}</span></h2>
      <p class="row"><input class="name" id="x-name" placeholder="Their name" maxlength="20"> <button class="btn btn-green" id="x-save" disabled>Add</button></p>
      <p class="fine">Check their wedgie shows <b class="mono">${esc(id)}</b>.</p>`;
    const nm = $("x-name") as HTMLInputElement, sv = $("x-save") as HTMLButtonElement;
    nm.oninput = () => sv.disabled = !nm.value.trim();
    sv.onclick = () => {
      book!.names[pub] = nm.value.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 20) || id;
      saveBook(me!.pub, book!);
      history.replaceState(null, "", "/secret");
      paintAdd();
      show(pub);
    };
    nm.focus();
  }
  window.addEventListener("hashchange", paintAdd);

  // ---- chats ----
  const unread = (pub: string) => book!.inbox.filter((m) => m.from === pub && m.n > (book!.seen[pub] || 0)).length;
  function paintChats() {
    const box = $("x-chats");
    box.hidden = !me;
    if (!me) return;
    const strangers = [...new Set(book!.inbox.map((m) => m.from).filter((f) => !book!.names[f]))];
    const all = [...Object.keys(book!.names), ...strangers];
    const last = (p: string) => Math.max(0, ...book!.inbox.filter((m) => m.from === p).map((m) => m.at), ...(book!.sent[p] || []).map((s) => s.at));
    all.sort((a, b) => last(b) - last(a));
    box.innerHTML = `<h2>Chats</h2>` + (all.length ? all.map((p) => {
      const u = unread(p), name = book!.names[p] || (p ? "New " + p.slice(2, 8) : "No name");
      return `<p class="row"><button class="btn btn-sm${open === p ? " btn-green" : ""}" data-pub="${esc(p)}">${esc(name)}</button>${u ? ` <span class="badge">${u}</span>` : ""}</p>`;
    }).join("") : `<p class="fine">None yet. Add someone with their link, or give out yours.</p>`);
    box.querySelectorAll<HTMLButtonElement>("[data-pub]").forEach((b) => b.onclick = () => show(b.dataset.pub!));
  }

  function show(pub: string) {
    if (open !== pub) { ($("x-text") as HTMLTextAreaElement).value = ""; $("x-smsg").textContent = ""; }
    open = pub;
    paintThread();
    paintChats();
  }

  // the thread: what you sent (here), what they sent (sealed: it shows on the wedgie)
  function paintThread() {
    const box = $("x-thread");
    box.hidden = !me || open === null;
    if (box.hidden) return;
    const p = open!, name = nameOf(p);
    $("x-who").innerHTML = name ? esc(name) : p ? `Someone new <button class="btn btn-sm" id="x-keep">Add</button>` : "No name";
    $("x-keep")?.addEventListener("click", () => { location.hash = S.b64u(unhex(p)); });
    const items: ({ t: "in"; m: Msg } | { t: "out"; s: Sent })[] = [
      ...book!.inbox.filter((m) => m.from === p).map((m) => ({ t: "in" as const, m })),
      ...(book!.sent[p] || []).map((s) => ({ t: "out" as const, s })),
    ].sort((a, b) => (a.t === "in" ? a.m.at : a.s.at) - (b.t === "in" ? b.m.at : b.s.at));
    const list = $("x-msgs"), atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = items.length ? items.map((x) => x.t === "out"
      ? `<div class="chat-out"><span>${esc(x.s.text)}</span><i>${when(x.s.at)}</i></div>`
      : `<div class="chat-in"><span>🔒 <button class="btn btn-sm" data-n="${x.m.n}"${live ? "" : " disabled"}>Show on wedgie</button></span><i>${when(x.m.at)}</i></div>`).join("")
      : `<p class="fine">Nothing yet.</p>`;
    list.querySelectorAll<HTMLButtonElement>("[data-n]").forEach((b) => b.onclick = () => toWedgie(book!.inbox.find((m) => m.n === Number(b.dataset.n))!));
    if (atEnd) list.scrollTop = list.scrollHeight;
    const n = Math.max(0, ...book!.inbox.filter((m) => m.from === p).map((m) => m.n));
    if (n > (book!.seen[p] || 0)) { book!.seen[p] = n; saveBook(me!.pub, book!); }
    paintSend();
  }

  function paintSend() {
    const t = $("x-text") as HTMLTextAreaElement, n = S.size(t.value), b = $("x-send") as HTMLButtonElement;
    b.disabled = !me || !open || !n || n > S.MAX;
    if (open === "") { b.disabled = true; $("x-smsg").textContent = "They didn't say who they are, so you can't write back."; }
    else if (n > S.MAX) $("x-smsg").innerHTML = `<b class="bad">${n} / ${S.MAX} bytes: too long</b>`;
  }
  ($("x-text") as HTMLTextAreaElement).oninput = () => { $("x-smsg").textContent = ""; paintSend(); };
  ($("x-text") as HTMLTextAreaElement).onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("x-send").click(); } };
  $("x-send").onclick = async () => {
    const t = $("x-text") as HTMLTextAreaElement, text = t.value, to = open!, b = $("x-send") as HTMLButtonElement;
    if (!me || !to || b.disabled) return;
    b.disabled = true;
    try {
      await post(to, me.pub, await S.seal(unhex(to), text));
      (book!.sent[to] ||= []).push({ at: Date.now(), text });
      saveBook(me.pub, book!);
      t.value = "";
      $("x-smsg").textContent = /[^\x20-\x7e\n]/.test(text) ? "Sent. Their wedgie shows emoji and accents as ?" : "";
      paintThread();
      paintChats();
    } catch (e) {
      $("x-smsg").innerHTML = `<b class="bad">${esc(msgOf(e))}</b>`;
    }
    paintSend();
  };

  // ---- to the wedgie's screen ----
  let queued: Msg | null = null;
  async function toWedgie(m: Msg) {
    if (!wedgie || !live) return;
    if (busy) { queued = m; return; }
    busy = true;
    const name = nameOf(m.from) || (m.from ? "Someone new" : "");
    const first = onWedgie !== name || !name;
    if (first) $("x-smsg").innerHTML = "<b>Press green on your wedgie.</b> It shows there, not here.";
    try {
      const r = await ask(wedgie, (q) => q.request({ type: "secret_open", blob: m.blob, from: name }, 200000));
      if (r.type === "secret_shown") { onWedgie = r.chat ? name : null; $("x-smsg").innerHTML = `<span class="good">On your wedgie. Red closes it.</span>`; }
      else { onWedgie = null; $("x-smsg").innerHTML = r.type === "refused" ? "Not opened." : `<span class="bad">${esc(r.error || r.type)}</span>`; }
    } catch (e) {
      onWedgie = null;
      $("x-smsg").innerHTML = `<span class="bad">${esc(msgOf(e))}</span>`;
    } finally {
      busy = false;
    }
    const q = queued;
    queued = null;
    if (q && onWedgie && nameOf(q.from) === onWedgie) toWedgie(q);
  }

  // ---- the mailbox ----
  let polling = false;
  async function poll() {
    if (!me || polling || document.hidden) return;
    polling = true;
    const mine = me.pub;
    try {
      const r = await fetch(`/api/chat?box=${await boxOf(mine)}&after=${book!.after}`);
      const j = await r.json();
      if (me?.pub !== mine || !Array.isArray(j.msgs) || !j.msgs.length) return;
      const fresh: Msg[] = j.msgs.filter((m: Msg) => S.isSealed(m.blob));
      book!.inbox.push(...fresh);
      book!.after = Math.max(book!.after, ...j.msgs.map((m: Msg) => m.n));
      book!.inbox = book!.inbox.slice(-500);
      saveBook(mine, book!);
      paintChats();
      if (open !== null) paintThread();
      const next = fresh.filter((m) => onWedgie && nameOf(m.from) === onWedgie).pop();   // their chat is open on the wedgie
      if (next) toWedgie(next);
    } catch {} finally { polling = false; }
  }
  setInterval(poll, POLL);
  document.addEventListener("visibilitychange", poll);

  function paintAll() { paintMe(); paintAdd(); paintChats(); paintThread(); }

  if (Drive.inApp()) {
    const look = async () => { const s = await Drive.status().catch(() => "away"); if (s !== driveState) { driveState = s; paintMe(); } };
    look(); setInterval(look, 1500);
  }
  W.onChange(paintMe);
  if (W.armed()) W.start();
  paintAll();
  poll();
}
