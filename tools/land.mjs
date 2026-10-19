// The globe's land (src/ui/globe.ts): Natural Earth 1:110m land, from world-atlas, as public/geo/land.json:
// a list of rings, each a flat [lon, lat, lon, lat, ...] in tenths of a degree. Run once; commit the output.
// Run: node tools/land.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const topo = await (await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json")).json();
const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
const arcs = topo.arcs.map((a) => { let x = 0, y = 0; return a.map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]); });
const arc = (i) => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
const rings = [];
for (const g of topo.objects.land.geometries) {
  const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
  for (const p of polys) for (const r of p) {
    const pts = r.flatMap((i, k) => arc(i).slice(k ? 1 : 0));
    const flat = [];
    for (const [lon, lat] of pts) {
      const a = Math.round(lon * 10), b = Math.round(lat * 10);
      if (flat.length && flat[flat.length - 2] === a && flat[flat.length - 1] === b) continue;
      flat.push(a, b);
    }
    if (flat.length >= 6) rings.push(flat);
  }
}
mkdirSync("public/geo", { recursive: true });
writeFileSync("public/geo/land.json", JSON.stringify(rings));
console.log(rings.length, "rings,", rings.reduce((n, r) => n + r.length / 2, 0), "points");
