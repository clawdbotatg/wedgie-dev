// An order's steps (/order/<id>): Ordered, Paid, Shipped, On the way, Delivered, each a 16 × 16 pixel
// sprite in the waistband's colours. "On the way" and "Delivered" come from omen (wedgie-shipping
// orders.py track): just the step and its date, never a place.

const INK: Record<string, string> = { k: "#48494b", w: "#ffffff", l: "#d6d6d2", g: "#22c452", s: "#a9aaab", r: "#e3312c" };

export const STEPS = [
  { key: "ordered", name: "Ordered", px: [
    "................",
    "...kkkkkkkkkk...",
    "...kwwwwwwwwk...",
    "...kwggggggwk...",
    "...kwsssssswk...",
    "...kwrrrrrrwk...",
    "...kwwwwwwwwk...",
    "...kwkkkkkwwk...",
    "...kwwwwwwwwk...",
    "...kwkkkkkkwk...",
    "...kwwwwwwwwk...",
    "...kwkkkwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwkwwkwwk...",
    "...kkk.kk.kkk...",
    "................"] },
  { key: "paid", name: "Paid", px: [
    "................",
    ".....kkkkkk.....",
    "...kkwwwwwwkk...",
    "..kwwwwggwwwlk..",
    "..kwwwggggwwlk..",
    ".kwwwwggwwwwwlk.",
    ".kwwwwggwwwwwlk.",
    ".kwwwwggggwwwlk.",
    ".kwwwwwwggwwwlk.",
    ".kwwwwwwggwwwlk.",
    "..kwwwggggwwlk..",
    "..kwwwwggwwllk..",
    "...kkllllllkk...",
    ".....kkkkkk.....",
    "................",
    "................"] },
  { key: "shipped", name: "Shipped", px: [
    "................",
    "................",
    "..kkkkkkkkkkkk..",
    "..kwwwwgsrwwlk..",
    "..kkkkkgsrkkkk..",
    "..kwwwwgsrwwlk..",
    "..kwwwwgsrwwlk..",
    "..kwwwwgsrwwlk..",
    "..kwwwwgsrwwlk..",
    "..kwsswgsrwwlk..",
    "..kwwwwgsrwwlk..",
    "..kwsswgsrwwlk..",
    "..kwwwwgsrwwlk..",
    "..kkkkkkkkkkkk..",
    "................",
    "................"] },
  { key: "moving", name: "On the way", px: [
    "................",
    "................",
    "................",
    "kkkkkkkkkk......",
    "kwwwwwwwwkkkkk..",
    "kwwwwwwwwkwllwk.",
    "kwwwwwwwwkwllwwk",
    "kggggggggggggggk",
    "kssssssssssssssk",
    "krrrrrrrrrrrrrrk",
    "kwwwwwwwwwwwwwlk",
    "kkkkkkkkkkkkkkkk",
    "..kkk......kkk..",
    ".kkskk....kkskk.",
    "..kkk......kkk..",
    "................"] },
  { key: "delivered", name: "Delivered", px: [
    "................",
    "................",
    ".kkkkkkkkkkkkkk.",
    ".kggggggggggggk.",
    ".kssssssssssssk.",
    ".krrrrrrrrrrrrk.",
    ".kwwwwwwwwwwwwk.",
    ".kwwwwwwwwwwwwk.",
    ".kwwwwwwwwwwwlk.",
    ".kwkkwwwwwwkklk.",
    ".kkllkwwwwkllkk.",
    "..kllkwwwlkllk..",
    "...kkkwwllkkk...",
    ".....kkkkkk.....",
    "................",
    "................"] },
] as const;

/** One sprite as crisp SVG rects, a row of same-colour pixels per rect. */
export function sprite(px: readonly string[]) {
  let rects = "";
  px.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let n = 1;
      while (row[x + n] === c) n++;
      if (INK[c]) rects += `<rect x="${x}" y="${y}" width="${n}" height="1" fill="${INK[c]}"/>`;
      x += n;
    }
  });
  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
