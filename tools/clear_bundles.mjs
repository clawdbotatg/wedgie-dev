// The clear-signing bundle /safe would send for each transaction, per data tag, with no chip: what
// tools/clear_gallery.py compares to find the transactions a new data release changed.
//   node tools/clear_bundles.mjs <txs.json> <out.json> <tag> [<tag> ...]     out: {tag: {id: hex | null}}
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Clear from "../src/safe/clear.ts";

const [txsFile, outFile, ...tags] = process.argv.slice(2);
const dir = new URL("../public/clear", import.meta.url).pathname;
const txs = JSON.parse(readFileSync(txsFile, "utf8"));
const out = {};
for (const tag of tags) {
  Clear.loadFrom(async (p) => { try { return JSON.parse(readFileSync(join(dir, `${p}.json`), "utf8")); } catch { return null; } });
  out[tag] = {};
  for (const t of txs) out[tag][t.id] = await Clear.bundle(tag, t.chainId, { to: t.to, data: t.data, operation: 0, safe: t.safe });
}
writeFileSync(outFile, JSON.stringify(out));
