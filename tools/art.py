#!/usr/bin/env python3
# Web art from the source renders in art/. Writes public/img/* and src/loader-logo.txt (the loader's
# logo as a base64 data URI, inlined into index.html so it paints with the first byte of HTML).
#   underwear.jpg           the device boot logo (same file as picowallet art/logo.jpg), on white
#   sticker*.jpg            die-cut sticker renders on black: the black is keyed out to alpha
# Run after changing anything in art/:  python3 tools/art.py
import base64, io, subprocess, sys
from pathlib import Path
from PIL import Image, ImageFilter, ImageChops

root = Path(__file__).resolve().parent.parent
out = root / "public/img"
out.mkdir(parents=True, exist_ok=True)


def webp(img, path, q=86):
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=q, method=6)
    path.write_bytes(buf.getvalue())
    return buf.getvalue()


# --- loader logo: the underwear on white, cropped to its box plus a margin, like splash.py does ---
u = Image.open(root / "art/underwear.jpg").convert("RGB")
diff = ImageChops.difference(u, Image.new("RGB", u.size, (255, 255, 255))).convert("L").point(lambda v: 255 if v > 6 else 0)
x0, y0, x1, y1 = diff.getbbox()
m = 0
box = (max(0, x0 - m), max(0, y0 - m), min(u.width, x1 + m), min(u.height, y1 + m))
logo = u.crop(box)
logo.thumbnail((440, 440), Image.LANCZOS)
data = webp(logo, out / "loader-logo.webp", q=80)
(root / "src/loader-logo.txt").write_text("data:image/webp;base64," + base64.b64encode(data).decode())
print(f"loader-logo.webp {logo.size} {len(data)} bytes")


# --- stickers: key out the black surround, keep the leg-hole greys (they are enclosed) ---------
def cutout(src, dst, width):
    im = Image.open(root / "art" / src).convert("RGB")
    lum = im.convert("L")
    # flood the near-black region connected to the corners
    dark = lum.point(lambda v: 255 if v < 40 else 0)
    seed = Image.new("L", im.size, 0)
    from PIL import ImageDraw
    mask = dark.copy()
    for c in ((0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)):
        ImageDraw.floodfill(mask, c, 128)
    bg = mask.point(lambda v: 255 if v == 128 else 0)
    # feather: the sticker's white edge glows into the black; ramp alpha by brightness near the edge
    edge = bg.filter(ImageFilter.MaxFilter(9))
    ramp = lum.point(lambda v: min(255, max(0, (v - 20) * 255 // 180)))
    alpha = ImageChops.invert(bg)
    alpha = Image.composite(ramp, alpha, ImageChops.multiply(edge, ImageChops.invert(bg)).point(lambda v: 255 if v else 0))
    alpha = ImageChops.multiply(alpha, ImageChops.invert(bg))
    rgba = im.copy()
    # un-premultiply the glow so the edge stays white on any background
    rgba = Image.composite(Image.new("RGB", im.size, (255, 255, 255)), rgba, ImageChops.multiply(edge, ImageChops.invert(bg)).point(lambda v: 255 if v else 0))
    rgba.putalpha(alpha)
    rgba = rgba.crop(alpha.getbbox())
    rgba.thumbnail((width, width), Image.LANCZOS)
    d = webp(rgba, out / dst, q=88)
    print(f"{dst} {rgba.size} {len(d)} bytes")


cutout("sticker-wedgie-dev.jpg", "sticker-wedgie-dev.webp", 1100)
cutout("sticker.jpg", "sticker.webp", 900)
cutout("truck.jpg", "truck.webp", 1100)
# the truck drives left on the site (toward the copy), so flip it
from PIL import ImageOps
tr = Image.open(out / "truck.webp"); ImageOps.mirror(tr).save(out / "truck.webp", "WEBP", quality=88, method=6)

# favicon / touch icon from the plain sticker
ico = Image.open(out / "sticker.webp").convert("RGBA")
sq = Image.new("RGBA", (max(ico.size),) * 2, (0, 0, 0, 0))
sq.paste(ico, ((sq.width - ico.width) // 2, (sq.height - ico.height) // 2), ico)
sq.resize((64, 64), Image.LANCZOS).save(out / "favicon.png")
t = Image.new("RGBA", (180, 180), (244, 244, 241, 255))
s = sq.resize((150, 150), Image.LANCZOS)
t.paste(s, (15, 15), s)
t.convert("RGB").save(out / "apple-touch-icon.png")
print("favicon.png, apple-touch-icon.png")

# social card: rendered from the 3D wedgie by tools/og.mjs (not here)
