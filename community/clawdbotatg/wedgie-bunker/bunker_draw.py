# Demon Bunker's renderer (viper): cast() draws the walls, spr() the things. Viper is machine code, so
# this file stays .py and compiles on the wedgie (it's small); bunker.mpy is the rest, compiled ahead.
# bunker.py sets ZB, SH, ROWC, CAMT before the first frame.
import micropython

ZB = SH = ROWC = CAMT = None


@micropython.viper
def cast(buf_, mp_, tex_, st_):
    buf = ptr8(buf_)
    mp = ptr8(mp_)
    tex = ptr8(tex_)
    st = ptr32(st_)
    zb = ptr32(ZB)
    sh = ptr8(SH)
    rc = ptr8(ROWC)
    ct = ptr32(CAMT)
    px = st[0]
    py = st[1]
    dx = st[2] - 65536
    dy = st[3] - 65536
    plx = st[4] - 65536
    ply = st[5] - 65536
    mw = st[6]
    vh = st[7]
    half = vh >> 1
    x = 0
    while x < 120:
        cam = ct[x] - 65536
        rx = dx + ((plx * cam) >> 12)
        ry = dy + ((ply * cam) >> 12)
        mx = px >> 8
        my = py >> 8
        if rx < 0:
            ax = 0 - rx
            sx = -1
            fx = px & 255
        else:
            ax = rx
            sx = 1
            fx = 256 - (px & 255)
        if ry < 0:
            ay = 0 - ry
            sy = -1
            fy = py & 255
        else:
            ay = ry
            sy = 1
            fy = 256 - (py & 255)
        ddx = 1 << 22
        if ax > 0:
            ddx = (1 << 20) // ax
        ddy = 1 << 22
        if ay > 0:
            ddy = (1 << 20) // ay
        sdx = (fx * ddx) >> 8
        sdy = (fy * ddy) >> 8
        side = 0
        cell = 0
        n = 0
        while n < 64:
            if sdx < sdy:
                sdx += ddx
                mx += sx
                side = 0
            else:
                sdy += ddy
                my += sy
                side = 1
            cell = mp[my * mw + mx]
            if cell:
                break
            n += 1
        if cell == 0:
            cell = 1
        if side == 0:
            d = sdx - ddx
        else:
            d = sdy - ddy
        if d < 24:
            d = 24
        zb[x] = d
        h = (vh << 8) // d
        if h < 1:
            h = 1
        if side == 0:
            tx = ((py + ((d * ry) >> 12)) >> 4) & 15
            if rx < 0:
                tx = 15 - tx
        else:
            tx = ((px + ((d * rx) >> 12)) >> 4) & 15
            if ry > 0:
                tx = 15 - tx
        lvl = (d >> 9) + side
        if lvl > 5:
            lvl = 5
        t0 = ((cell - 1) << 8) + (tx << 4)
        s0 = lvl << 4
        top = half - (h >> 1)
        step = (16 << 16) // h
        tp = 0
        y0 = top
        if y0 < 0:
            tp = (0 - y0) * step
            y0 = 0
        y1 = top + h
        if y1 > vh:
            y1 = vh
        o = x
        y = 0
        while y < y0:
            buf[o] = rc[y]
            o += 120
            y += 1
        while y < y1:
            c = sh[s0 + tex[t0 + (tp >> 16)]]
            buf[o] = (c << 4) | c
            tp += step
            o += 120
            y += 1
        while y < vh:
            buf[o] = rc[y]
            o += 120
            y += 1
        x += 1


@micropython.viper
def spr(buf_, img_, a_):
    """One 16x16 billboard: a = center column, width (columns), top row, height (px), depth, frame
    offset, shade level, view height, mirrored. Skips columns where a wall is nearer."""
    buf = ptr8(buf_)
    img = ptr8(img_)
    a = ptr32(a_)
    zb = ptr32(ZB)
    sh = ptr8(SH)
    cx = a[0] - 65536
    w = a[1]
    top = a[2] - 65536
    h = a[3]
    d = a[4]
    io = a[5]
    s0 = a[6] << 4
    vh = a[7]
    fl = a[8]
    c0 = cx - (w >> 1)
    xs = (16 << 16) // w
    ys = (16 << 16) // h
    x = c0
    if x < 0:
        x = 0
    x1 = c0 + w
    if x1 > 120:
        x1 = 120
    y0 = top
    ty0 = 0
    if y0 < 0:
        ty0 = (0 - y0) * ys
        y0 = 0
    y1 = top + h
    if y1 > vh:
        y1 = vh
    while x < x1:
        if zb[x] > d:
            tx = ((x - c0) * xs) >> 16
            if fl:
                tx = 15 - tx
            b = io + (tx << 4)
            ty = ty0
            o = y0 * 120 + x
            y = y0
            while y < y1:
                p = img[b + (ty >> 16)]
                if p < 16:
                    c = sh[s0 + p]
                    buf[o] = (c << 4) | c
                ty += ys
                o += 120
                y += 1
        x += 1
