# The /assemble drawings whose wires take your cable's colors (the "Cable not these colors?" box).
#   python3 tools/asmwires.py key <dNN>             the image model repaints each wire in a key color -> art/wires/dNN.key.webp
#   python3 tools/asmwires.py split <dNN> [...]     key image -> public/img/assemble/dNN.webp (kit colors) + dNN.m.png (the mask)
# Keys: white -> magenta, yellow -> green, black -> cyan, red -> blue (none of them is anywhere else in a drawing).
# Each pixel is a * key + (1 - a) * what's behind it (outline, board, paper). The mask keeps which wire (R: 50 per wire,
# 1..4) and a (G); the page swaps a * kit color for a * yours (src/pages/assemble.ts recolor). Needs pillow numpy scipy.
import os, sys, io, json, base64, uuid, urllib.request
import numpy as np
from PIL import Image, ImageChops
from scipy import ndimage

OUT = "public/img/assemble"
KEYS = np.array([[1, 0, 1], [0, 1, 0], [0, 1, 1], [0, 0, 1]], float)          # white, yellow, black, red
KIT = np.array([[0xf4, 0xf4, 0xef], [0xf2, 0xc4, 0x17], [0x23, 0x23, 0x23], [0xd8, 0x26, 0x2a]], float) / 255   # = PALETTE in cablecolors.ts
PROMPT = """This is an illustration from a hardware assembly manual. It shows a 4-wire cable with a white wire, a yellow wire, a black wire and a red wire (some may be hidden or cut short; only recolor the ones you see).
Repaint ONLY the colored plastic insulation of those four wires with flat, pure key colors, no shading, no outline change:
- the WHITE wire -> pure magenta #FF00FF
- the YELLOW wire -> pure green #00FF00
- the BLACK wire -> pure cyan #00FFFF
- the RED wire -> pure blue #0000FF
The cable has exactly four wires: never add, split or duplicate one; each key color appears on exactly one wire. Keep the wires' exact shape, path and width. Do not recolor the bare copper tips, the white plastic plug, connectors, sockets, tape, boards, tools or background. Everything else must stay exactly the same, pixel for pixel, same framing, same size."""


def key(d):
    k = [l.split("=", 1)[1].strip().strip('"') for l in open(os.path.expanduser("~/clawd/clawd-web-chat/.env")) if l.startswith("OPENAI_API_KEY=")][0]
    im = Image.open(f"{OUT}/{d}.webp").convert("RGB"); W, H = im.size
    size = "1024x1536" if H > W * 1.15 else ("1536x1024" if W > H * 1.15 else "1024x1024")
    buf = io.BytesIO(); im.save(buf, "PNG")
    b = "----" + uuid.uuid4().hex; parts = []
    def f(n, v): parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'.encode())
    f("model", "gpt-image-2.5-sunburst"); f("prompt", PROMPT); f("size", size); f("quality", "high")
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + buf.getvalue() + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    req = urllib.request.Request("https://api.openai.com/v1/images/edits", data=b"".join(parts),
                                 headers={"Authorization": "Bearer " + k, "Content-Type": "multipart/form-data; boundary=" + b})
    r = json.load(urllib.request.urlopen(req, timeout=600))
    os.makedirs("art/wires", exist_ok=True)
    Image.open(io.BytesIO(base64.b64decode(r["data"][0]["b64_json"]))).convert("RGB").save(f"art/wires/{d}.key.webp", lossless=True, method=6)
    print("ok", d)


def split(d, src=None):
    im = Image.open(src or f"art/wires/{d}.key.webp").convert("RGB")
    bg = Image.new("RGB", im.size, im.getpixel((4, 4)))                 # trim the paper like tools/asmimg.py
    box = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > 18 else 0).getbbox()
    if box:
        m = 40; im = im.crop((max(0, box[0] - m), max(0, box[1] - m), min(im.width, box[2] + m), min(im.height, box[3] + m)))
    im.thumbnail((900, 1100), Image.LANCZOS)
    p = np.asarray(im, float) / 255
    R, G, B = p[..., 0], p[..., 1], p[..., 2]
    raw = np.stack([np.minimum(R, B) - G, G - np.maximum(R, B), np.minimum(G, B) - R, B - np.maximum(R, G)], -1).clip(0, 1)
    a = np.zeros_like(raw)
    for k in range(4):                                                   # only near a real wire: long, solid runs of the key
        strict = k >= 2                                                  # cyan and blue: the board's traces are close
        lab, n = ndimage.label(raw[..., k] > (0.7 if strict else 0.45))
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        core = np.isin(lab, 1 + np.flatnonzero(sizes > (150 if strict else 25)))
        weak, m = ndimage.label(raw[..., k] > 0.15)                      # paler bits of it (highlights, thin ends) touching a run
        ids = np.unique(weak[core & (weak > 0)])
        wsz = ndimage.sum(np.ones_like(weak), weak, ids) if len(ids) else []
        csz = ndimage.sum(core, weak, ids) if len(ids) else []
        ok = [i for i, w_, c_ in zip(ids, wsz, csz) if w_ < 1.6 * c_]      # mostly wire, not a board it touches
        keep = np.isin(weak, ok) | ndimage.binary_dilation(core, iterations=1)
        a[..., k] = raw[..., k] * ndimage.binary_dilation(keep, iterations=2)
    which = a.argmax(-1); al = a.max(-1)
    al[al < 0.04] = 0
    K, T = KEYS[which], KIT[which]
    A = al[..., None]
    behind = np.where(A < 0.97, (p - A * K) / np.maximum(1 - A, 1e-3), 0).clip(0, 1)
    base = A * T + (1 - A) * behind
    Image.fromarray((base * 255).round().astype(np.uint8)).save(f"{OUT}/{d}.webp", quality=88, method=6)
    mask = np.zeros(p.shape, np.uint8)
    mask[..., 0] = np.where(al > 0, (which + 1) * 50, 0)
    mask[..., 1] = (al * 255).round()
    Image.fromarray(mask).save(f"{OUT}/{d}.m.png", optimize=True)
    print(d, im.size, "wire px:", [int((al[which == k] > 0.5).sum()) for k in range(4)])


if __name__ == "__main__":
    cmd, *ds = sys.argv[1:]
    for d in ds: (key if cmd == "key" else split)(d)
