// "Wedgies around the world" on the home page (#world): the globe (globe.ts), the build a pin opens, and the
// form to send yours. What's sent waits for one of us to look at it (api/builds.ts); only then is it on the globe.
// The photo is shrunk and re-encoded here, which also drops its metadata (GPS, camera); the server cuts it again.
import type { Build, Globe } from "./globe";

const STAGE: Record<string, string> = { printed: "Case printed", assembled: "Put together", running: "Running the firmware" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A photo as a base64 JPEG, its long side at most 1280 px. */
async function shrink(f: File): Promise<{ b64: string; url: string }> {
  const src = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const s = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.84));
    if (!blob) throw 0;
    const b = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { b64: btoa(bin), url: URL.createObjectURL(blob) };
  } catch { throw new Error("Couldn't read that photo. Try a JPG or PNG."); }
  finally { URL.revokeObjectURL(src); }
}

export function world(sec: HTMLElement) {
  const side = sec.querySelector<HTMLElement>(".world-side")!;
  const box = sec.querySelector<HTMLElement>(".globe")!;
  let globe: Globe | null = null, builds: Build[] = [];
  let placing: ((lat: number, lon: number) => void) | null = null;   // the form is open: globe taps place its pin
  const setPlace = (cb: typeof placing) => { placing = cb; globe?.place(cb); };

  const intro = () => {
    setPlace(null);
    side.innerHTML = `<div class="world-intro">
      <p class="world-n"><b>${builds.length || "No"}</b> ${builds.length === 1 ? "wedgie" : "wedgies"} on the globe${builds.length ? "" : " yet"}.</p>
      <p>Printed a case? Got one booting? Send a photo, even halfway there. We look at every one before it goes up.</p>
      <div class="row"><button class="btn btn-green add">Put yours on the globe</button></div>
      ${builds.length ? `<p class="fine">Tap an underwear to meet its builder.</p>` : ""}
    </div>`;
    side.querySelector<HTMLButtonElement>(".add")!.onclick = form;
  };

  const show = (b: Build | null) => {
    if (!b) return intro();
    const i = builds.indexOf(b), n = builds.length;
    const date = new Date(b.at).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    side.innerHTML = `<div class="world-build">
      <img class="world-photo recess" src="/api/builds?img=${encodeURIComponent(b.id)}" alt="">
      <h3></h3>
      <p class="world-meta"><span class="world-stage"></span><span class="fine where"></span></p>
      <p class="world-note"></p>
      <p class="link" hidden><a target="_blank" rel="noopener nofollow ugc"></a></p>
      <div class="row world-nav">
        ${n > 1 ? `<button class="btn btn-sm prev" aria-label="Previous">‹</button><span class="fine">${i + 1} of ${n}</span><button class="btn btn-sm next" aria-label="Next">›</button>` : ""}
        <button class="btn btn-sm back">All</button>
      </div>
    </div>`;
    const $ = (s: string) => side.querySelector<HTMLElement>(s)!;
    $("h3").textContent = b.name;
    $(".world-stage").textContent = STAGE[b.stage] || b.stage;
    $(".where").textContent = [b.place, date].filter(Boolean).join(" · ");
    $(".world-note").textContent = b.note;
    $(".world-note").hidden = !b.note;
    if (b.link) {
      const a = side.querySelector<HTMLAnchorElement>(".link a")!;
      a.href = b.link; a.textContent = b.link.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "");
      $(".link").hidden = false;
    }
    const go = (d: number) => { const nb = builds[(i + d + n) % n]; globe?.select(nb.id); show(nb); };
    if (n > 1) { $(".prev").onclick = () => go(-1); $(".next").onclick = () => go(1); }
    $(".back").onclick = () => { globe?.select(null); intro(); };
  };

  function form() {
    globe?.select(null);
    let photo = "", lat: number | null = null, lon: number | null = null, stage = "";
    side.innerHTML = `<form class="world-form" novalidate>
      <h3>Put yours on the globe</h3>
      <label class="world-drop recess"><input type="file" accept="image/*" hidden><img alt="" hidden><span>Add a photo of it</span></label>
      <input class="recess name" maxlength="40" placeholder="Your name or nickname" autocomplete="nickname">
      <div class="seg world-seg" role="radiogroup" aria-label="how far along">
        ${Object.entries(STAGE).map(([k, v]) => `<button type="button" role="radio" aria-checked="false" data-s="${k}">${v}</button>`).join("")}
      </div>
      <p class="world-where fine"><b>Tap the globe</b> where you are, or <button type="button" class="linkish here">use my location</button>.</p>
      <input class="recess place" maxlength="60" placeholder="Your city (optional)" autocomplete="address-level2">
      <textarea class="recess about" rows="2" maxlength="280" placeholder="Anything about it (optional)"></textarea>
      <input class="recess link" maxlength="200" placeholder="@handle or https:// link (optional)" autocomplete="url">
      <input class="website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p class="fine">Everyone will see the photo, these words, and the spot on the globe (rounded to about 10 km). We check each one first.</p>
      <p class="fine said" hidden></p>
      <div class="row"><button class="btn btn-green send">Send</button><button type="button" class="btn cancel">Cancel</button></div>
    </form>`;
    const $ = <T extends HTMLElement>(s: string) => side.querySelector<T>(s)!;
    const said = (m: string) => { $(".said").hidden = !m; $(".said").innerHTML = m ? `<b class="bad">${esc(m)}</b>` : ""; };
    const where = (a: number, o: number) => {
      lat = a; lon = o;
      $(".world-where").innerHTML = `Placed at <b>${a.toFixed(1)}, ${o.toFixed(1)}</b>. Tap the globe to move it.`;
    };
    setPlace(where);
    $(".cancel").onclick = intro;
    const file = $<HTMLInputElement>("input[type=file]");
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      said("");
      try {
        const r = await shrink(f);
        photo = r.b64;
        const img = $<HTMLImageElement>(".world-drop img");
        img.src = r.url; img.hidden = false;
        $(".world-drop span").textContent = "Change photo";
      } catch (e: any) { said(e.message); }
    };
    side.querySelectorAll<HTMLButtonElement>(".world-seg button").forEach((b) => (b.onclick = () => {
      stage = b.dataset.s!;
      side.querySelectorAll<HTMLButtonElement>(".world-seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    }));
    $(".here").onclick = () => navigator.geolocation?.getCurrentPosition(
      (p) => { const a = Math.round(p.coords.latitude * 10) / 10, o = Math.round(p.coords.longitude * 10) / 10; globe?.mark(a, o); where(a, o); },
      () => said("Couldn't get your location. Tap the globe instead."), { maximumAge: 600_000, timeout: 15_000 });
    $<HTMLFormElement>("form").onsubmit = async (e) => {
      e.preventDefault();
      const name = $<HTMLInputElement>(".name").value.trim();
      const miss = !photo ? "Add a photo." : !name ? "Your name, or a nickname." : !stage ? "How far along is it?" : lat === null ? "Tap the globe where you are." : "";
      if (miss) return said(miss);
      const b = $<HTMLButtonElement>(".send");
      b.disabled = true; b.textContent = "Sending"; said("");
      try {
        const r = await fetch("/api/builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          name, stage, lat, lon, img: photo, place: $<HTMLInputElement>(".place").value, note: $<HTMLTextAreaElement>(".about").value,
          link: $<HTMLInputElement>(".link").value.trim(), website: $<HTMLInputElement>(".website").value }) });
        const v = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(v.error || `Didn't send (${r.status}).`);
        setPlace(null);
        side.innerHTML = `<div class="world-intro"><h3>Sent. Thank you.</h3><p>We look at every one. Yours shows up on the globe once we have.</p>
          <div class="row"><button class="btn btn-green done">Done</button></div></div>`;
        $(".done").onclick = intro;
      } catch (err: any) { said(err.message); b.disabled = false; b.textContent = "Send"; }
    };
  }

  intro();
  fetch("/api/builds").then((r) => r.json()).then((r) => {
    builds = r.builds || [];
    globe?.setBuilds(builds);
    if (side.querySelector(".world-n")) intro();   // still on the count: refresh it
  }, () => {});
  return {
    async mount() {
      const { mountGlobe } = await import("./globe");
      globe = await mountGlobe(box, (b) => show(b));
      globe.setBuilds(builds);
      if (placing) globe.place(placing);
    },
  };
}
