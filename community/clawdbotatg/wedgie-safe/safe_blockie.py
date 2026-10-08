# Blockies: the 8x8 picture an address gets in wallets (ethereum-blockies, as Instant Wallet's `blo` draws it),
# so an address can be checked at a glance against the one on the phone or computer. Same pattern as theirs;
# the colors are the nearest of the wedgie's 16 (lcd.PALETTE), so close, not exact.
import lcd as L

_M = 0xFFFFFFFF


def _i32(x):
    x &= _M
    return x - 0x100000000 if x & 0x80000000 else x


def _seed(s):
    r = [0, 0, 0, 0]
    for i in range(len(s)):
        j = i & 3
        r[j] = ((r[j] << 5) - r[j] + ord(s[i])) & _M
    return r


def _next(r):
    t = _i32(r[0]) ^ _i32(r[0] << 11)
    r[0], r[1], r[2] = r[1], r[2], r[3]
    w = _i32(r[3])
    r[3] = (w ^ (w >> 19) ^ t ^ (t >> 8)) & _M
    return r[3] / 2147483648


def _color(r):
    h = int(_next(r) * 360) & 0xFFFF
    s = int(40 + _next(r) * 60) & 0xFFFF
    l = int((_next(r) + _next(r) + _next(r) + _next(r)) * 25) & 0xFFFF
    return h, s, l


def _rgb(h, s, l):
    """HSL (as CSS takes it: degrees, %, %) -> 0-255 RGB."""
    s, l = s / 100, l / 100
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    r, g, b = ((c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x))[int(h // 60) % 6]
    return int((r + m) * 255 + 0.5), int((g + m) * 255 + 0.5), int((b + m) * 255 + 0.5)


def image(a):
    """(32 cells of 0 background / 1 color / 2 spot, the left half row by row, [bg, color, spot] as HSL)."""
    r = _seed(a.lower())
    c = _color(r)
    b = _color(r)
    s = _color(r)
    return [int(_next(r) * 2.3) for _ in range(32)], (b, c, s)


def _disc(d, x, y, n, colf):
    """A disc n px across at x, y, row by row; colf(px, py) -> (color, run end) for the run starting at px."""
    r = n / 2
    for py in range(n):
        dy = py + 0.5 - r
        w = (r * r - dy * dy) ** 0.5
        px, x1 = int(r - w + 0.5), int(r + w + 0.5)
        while px < x1:
            c, e = colf(px, py)
            e = min(e, x1)
            d.hline(x + px, y + py, e - px, c)
            px = e


def draw(d, a, x, y, cell=4, edge=None):
    """The blockie of address `a`, 8x8 cells of `cell` px, as a circle 8*cell across at x, y (wallets draw
    it round), ringed in `edge`."""
    cells, hsl = image(a)
    cols = [L.color(*_rgb(*v)) for v in hsl]
    n = 8 * cell
    if edge is not None:
        _disc(d, x - 1, y - 1, n + 2, lambda px, py: (edge, n + 2))

    def colf(px, py):
        cx = px // cell
        return cols[cells[(py // cell) * 4 + (cx if cx < 4 else 7 - cx)]], (cx + 1) * cell
    _disc(d, x, y, n, colf)
