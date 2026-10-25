// A Safe Signer proof (wedgie-safe safe_prove.py): this wedgie's Safe key signed the site's text and code after a
// press on the wedgie, and the chip's factory key vouches that the key lives in that chip (its certificate traces
// to Infineon). Returns the chip's id (SHA-256 of its certificate), or throws a short reason.
import { trustmCert, trustmSigned } from "../src/serial/chipcheck.js";

const enc = new TextEncoder();
const hexb = (h: string) => Uint8Array.from(String(h).replace(/^0x/, "").match(/../g) || [], (x) => parseInt(x, 16));
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
const word = (h: unknown) => { const b = hexb(String(h)); if (b.length !== 32) throw new Error("bad proof"); return b; };

export async function checkProof(d: any, text: string, code: string, base = "https://wedgie.dev") {
  if (d?.type !== "safe_proof" || d.text !== text || d.code !== code) throw new Error("bad proof");
  const xy = cat(word(d.x), word(d.y));
  const pub = await crypto.subtle.importKey("raw", cat(Uint8Array.of(4), xy) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const said = cat(enc.encode("wedgie prove\0"), await sha(enc.encode(`${text}\n${code}`)));
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, cat(word(d.r), word(d.s)) as BufferSource, said as BufferSource)))
    throw new Error("the Safe key's signature doesn't check");
  const der = trustmCert(d);
  const f = await trustmSigned(der, cat(enc.encode("wedgie safe key\0"), xy), hex(word(d.fr)) + hex(word(d.fs)), base);
  if (!f.sigOk) throw new Error("the chip didn't vouch for this key");
  if (f.chain) throw new Error(`not a genuine Trust M: ${f.chain}`);
  return hex(await sha(der));
}
