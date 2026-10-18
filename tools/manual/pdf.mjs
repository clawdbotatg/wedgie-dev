// Shared by the printed manuals (tools/asmpdf.mjs, tools/userpdf.mjs): fonts, QR codes, HTML -> Letter PDF.
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const ROOT = resolve(import.meta.dirname, "../..");
export const dir = mkdtempSync(join(tmpdir(), "manual-"));

// manual.css with its fonts filled in
export const css = (f = "manual.css") => readFileSync(join(ROOT, "tools/manual", f), "utf8")
  .replace("NUNITO", "file://" + join(ROOT, "node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2"))
  .replace("DMMONO", "file://" + join(ROOT, "node_modules/@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2"));

export const qr = (url) => QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1a1b1a", light: "#0000" } });

// Chromium keeps a JPEG as is but stores a webp uncompressed, so print from JPEG copies (python3 + Pillow), see-through parts white, an off-white background made pure white.
export const img = (path) => {
  const out = join(dir, path.replace(/\W/g, "_") + ".jpg");
  execFileSync("python3", ["-c", "import sys;from PIL import Image;i=Image.open(sys.argv[1]).convert('RGBA');w=Image.new('RGB',i.size,'white');w.paste(i,mask=i);c=w.getpixel((2,2));w=w.point([min(255,round(v*255/c[k])) if min(c)>=235 else v for k in range(3) for v in range(256)]);w.save(sys.argv[2],quality=90)", join(ROOT, path), out]);
  return "file://" + out;
};

export async function pdf(html, out, footer) {
  const page = join(dir, "manual.html");
  writeFileSync(page, html);
  const cache = homedir() + "/Library/Caches/ms-playwright";
  const shell = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()[0];
  const b = await chromium.launch({ executablePath: `${cache}/${shell}/${process.platform === "linux" ? "chrome-headless-shell-linux64" : "chrome-headless-shell-mac-arm64"}/chrome-headless-shell`, args: ["--allow-file-access-from-files"] });
  const p = await b.newPage();
  await p.goto("file://" + page, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: join(ROOT, out), format: "Letter", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="width:100%;font:9px Helvetica, Arial, sans-serif;color:#888;padding:0 0.6in;display:flex;justify-content:space-between">
      <span>${footer}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` });
  await b.close();
  console.log(out, (readFileSync(join(ROOT, out)).length / 1e6).toFixed(1) + " MB");
}
