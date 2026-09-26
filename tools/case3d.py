#!/usr/bin/env python3
# The 3D wedgie's geometry, from the MIT case (github.com/clawdbotatg/clawd-pico-case). Its
# renders/<rev>/viewer.html carries every part already assembled in one frame (mm; origin = LCD PCB
# bottom-left, +y toward the joystick, +z out of the screen). We take the lid, base, the four button
# caps (one mesh there: split here by x, A is the largest x) and the joystick cap, merge duplicate
# vertices, quantize to uint16 inside each part's box, and write public/3d/wedgie.bin + wedgie.json.
#   python3 tools/case3d.py /path/to/clawd-pico-case [rev]        (rev default v1.3, the current release)
import sys, re, json, base64, struct
from pathlib import Path

case = Path(sys.argv[1])
rev = sys.argv[2] if len(sys.argv) > 2 else "v1.3"
html = (case / "renders" / rev / "viewer.html").read_text()
parts = {p["name"]: p for p in json.loads(re.search(r"const PARTS = (\[.*?\]);\n", html, re.S).group(1))}


def tris(b64):
    b = base64.b64decode(b64)
    n = struct.unpack("<I", b[80:84])[0]
    out = []
    for i in range(n):
        o = 84 + i * 50 + 12
        out.append(struct.unpack("<9f", b[o:o + 36]))
    return out


def split_x(ts, k):
    """Group triangles into k clusters along x (the caps sit in a row)."""
    cx = sorted(set(round((t[0] + t[3] + t[6]) / 3, 1) for t in ts))
    gaps = sorted(((cx[i + 1] - cx[i], (cx[i + 1] + cx[i]) / 2) for i in range(len(cx) - 1)), reverse=True)[:k - 1]
    cuts = sorted(g[1] for g in gaps)
    groups = [[] for _ in range(k)]
    for t in ts:
        x = (t[0] + t[3] + t[6]) / 3
        groups[sum(x > c for c in cuts)].append(t)
    return groups


meshes = {"lid": tris(parts["lid"]["stl"]), "base": tris(parts["base"]["stl"]), "joystick": tris(parts["joystick_cap"]["stl"]),
          # the boards (the case repo's own stand-in models): for the assembly animation
          "hat": tris(parts["hat"]["stl"]), "pico": tris(parts["pico"]["stl"])}
caps = split_x(tris(parts["button_caps"]["stl"]), 4)          # x ascending: Y X B A
for name, g in zip(("Y", "X", "B", "A"), caps):
    meshes[name] = g

blob, index = bytearray(), []
for name, ts in meshes.items():
    verts, vid, idx = [], {}, []
    for t in ts:
        for j in range(3):
            v = (round(t[3 * j], 3), round(t[3 * j + 1], 3), round(t[3 * j + 2], 3))
            if v not in vid:
                vid[v] = len(verts); verts.append(v)
            idx.append(vid[v])
    lo = [min(v[a] for v in verts) for a in range(3)]
    hi = [max(v[a] for v in verts) for a in range(3)]
    q = bytearray()
    for v in verts:
        q += struct.pack("<3H", *(round((v[a] - lo[a]) / ((hi[a] - lo[a]) or 1) * 65535) for a in range(3)))
    wide = len(verts) > 65535
    ib = struct.pack("<%d%s" % (len(idx), "I" if wide else "H"), *idx)
    while len(blob) % 4: blob.append(0)
    pos_off = len(blob); blob += q
    while len(blob) % 4: blob.append(0)
    idx_off = len(blob); blob += ib
    index.append({"name": name, "verts": len(verts), "tris": len(idx) // 3, "lo": lo, "hi": hi,
                  "pos": pos_off, "idx": idx_off, "wide": wide})

out = Path(__file__).resolve().parent.parent / "public/3d"
out.mkdir(parents=True, exist_ok=True)
(out / "wedgie.bin").write_bytes(blob)
glass = {"cx": 26.44 / 2 - 0.2905, "cy": 52.5 / 2 - 0.1393, "w": 25.19, "h": 26.48, "z": 2.05}   # params.py S1 S2 S3 SC1
(out / "wedgie.json").write_text(json.dumps({"source": f"clawd-pico-case renders/{rev}", "parts": index, "glass": glass}, indent=1))
print(f"public/3d/wedgie.bin {len(blob)} bytes; " + ", ".join(f"{p['name']} {p['tris']}" for p in index))
