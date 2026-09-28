// The three things you want to know about a wedgie, in plain words: its hardware (and whether the chip
// is proven working), its firmware (and whether an update is ready), and what it's playing. The list
// on /connect shows them one line each; the wedgie's own page shows them at the top of each section.
import { esc } from "./device";
import { miniCart } from "./cart";
import type * as W from "../serial/wedgies";
import type { Manifest } from "../serial/install";

export type Tone = "ok" | "warn" | "bad" | "wait";
export type Fact = { html: string; tone: Tone };

export function chipName(w: W.Wedgie) {
  const t = w.chip?.type;
  return !t || t === "none" ? "" : t === "OPTIGA Trust M" ? "Trust M" : t;
}

export function hardware(w: W.Wedgie): Fact {
  if (w.state === "identifying") return { html: "finding it…", tone: "wait" };
  if (w.state === "error") return { html: esc(w.error || "can't talk to it"), tone: "bad" };
  const board = esc(w.board || "board");
  const p = w.proof;
  if (p?.state === "checking") return { html: `${board} · checking the chip…`, tone: "wait" };
  if (p?.state === "done") return p.pass ? { html: `${board} · ${esc(chipName(w))} <b class="good">✓ working</b>`, tone: "ok" }
    : { html: `${board} · <b class="bad">${chipName(w) ? esc(chipName(w)) + " failed" : "no chip"}</b>`, tone: "bad" };
  return { html: `${board}${chipName(w) ? " · " + esc(chipName(w)) : ""}`, tone: w.kind === "wallet" ? "ok" : "warn" };
}

export const updateReady = (w: W.Wedgie, m?: Manifest) => !!m && w.kind === "wedgie" && !!w.version && w.version !== m.version;

export function firmware(w: W.Wedgie, m?: Manifest): Fact {
  if (w.state !== "ready") return { html: "", tone: "wait" };
  if (w.kind === "wedgie") return updateReady(w, m) ? { html: `wedgie ${esc(w.version)} <span class="badge">update ready: ${esc(m!.version)}</span>`, tone: "warn" }
    : { html: `wedgie ${esc(w.version)}${m ? ` <span class="fine">up to date</span>` : ""}`, tone: "ok" };
  if (w.kind === "wallet") return { html: "wedgie (checked when the Wallet closes)", tone: "ok" };
  return { html: `none yet <span class="badge">install</span>`, tone: "warn" };
}

export function playing(w: W.Wedgie, m?: Manifest): Fact {
  if (w.state !== "ready") return { html: "", tone: "wait" };
  if (w.kind === "micropython") return { html: w.firmware === "its own main.py" ? "its own main.py" : "nothing", tone: "warn" };
  const c = m?.carts.find((x) => x.mod === w.running);
  if (c) return { html: `${miniCart(c)} ${esc(c.name)}`, tone: "ok" };
  if (w.running) return { html: esc(w.running), tone: "ok" };
  const n = (w.carts || w.apps || []).length;
  return { html: n ? `the menu · ${n} cartridge${n > 1 ? "s" : ""}` : "the menu · no cartridges yet", tone: "ok" };
}

/** The worst of the three: the row's status light. */
export function overall(w: W.Wedgie, m?: Manifest): Tone {
  const t = [hardware(w), firmware(w, m), playing(w, m)].map((f) => f.tone);
  return t.includes("bad") ? "bad" : t.includes("wait") ? "wait" : t.includes("warn") ? "warn" : "ok";
}
