# Boot loading bar. boot.py already put the logo on screen (splash.show). load(app) reads the app's
# import lines, loads the files it needs from flash one at a time, and fills the bar (bar.bin, from
# tools/bar) by each file's share of the total size. The app itself is left for main.py to import:
# many apps draw as soon as they load, and the bar must not paint over them. Apps need no changes.
# main.py: import lcd, loader.load("app"), then import and start the app as usual.
import os, sys, time, gc, struct, micropython
import lcd, splash


def _size(name):
    for ext in (".py", ".mpy"):
        try:
            return name + ext, os.stat(name + ext)[6]
        except OSError:
            pass
    return None, 0


def _starts(s, words):
    for w in words:
        if s.startswith(w):
            return True
    return False


def _imports(path):
    """Modules a .py file always loads when it is imported: unindented import lines above its first
    top-level def or class (reading the whole file is slow on the board, and imports go at the top).
    Indented ones sit in a try or an if, may be meant to fail or be skipped, so the app does those
    itself. Read line by line so a big file never needs one big block of RAM."""
    out = []
    with open(path) as f:
        for line in f:
            s = line.split("#")[0].split(";")[0].strip()
            if not s or line[0] in " \t":
                continue
            if _starts(s, ("def ", "class ", "async def ", "@")):
                break
            if s.startswith("import "):
                out += [p.split()[0].split(".")[0] for p in s[7:].split(",") if p.strip()]
            elif s.startswith("from ") and not s.startswith("from ."):
                out.append(s.split()[1].split(".")[0])
    return out


def _plan(app):
    """(module, bytes) for every module file the app needs that is not loaded yet, dependencies
    first, the app itself last."""
    order, seen = [], set()

    def visit(m):
        if m in seen or m in sys.modules:
            return
        seen.add(m)
        path, n = _size(m)
        if not path:
            return                       # built in (machine, time, ...) or not on this board
        if path.endswith(".py"):
            for d in _imports(path):
                visit(d)
        order.append((m, n))

    visit(app)
    return order


@micropython.viper
def _fill(buf, n: int, v: int):
    """buf[0:n] = v, 16-bit pixels, at machine speed (a Python loop costs ms per bar update)."""
    p = ptr16(buf)
    i = 0
    while i < n:
        p[i] = v
        i += 1


class _Bar:
    """The plastic bar from tools/bar (bar.bin), drawn only while an app's helper files load: it
    appears empty, fills grey, turns green, and is wiped back to the logo's background partway
    through the wait for the app's first screen. Any fill is copied from pre-rendered pieces; nothing
    waits. Pieces are stored as their two ends plus the one middle column that repeats (see tools/bar)."""
    def __init__(self, f):
        self.d = lcd.LCD()               # the panel is already up, so this keeps the logo on screen
        (self.X, self.Y, self.W, self.H, self.F0, self.F1, self.CW, self.CR,
         self.L, self.R, self.T0, self.TH) = struct.unpack(">12H", f.read(24))
        e, t = self._size(self.H), self._size(self.TH)
        c = self.TH * self.CW * 2
        self.green_at = 24 + e + t + c
        if (self.X + self.W > self.d.width or self.Y + self.H > self.d.height or self.CR > self.CW
                or not self.F0 < self.F1 <= self.W or self.L + self.R >= self.W or self.T0 + self.TH > self.H
                or os.stat("bar.bin")[6] != self.green_at + t):
            raise ValueError("bar.bin does not fit this screen or is damaged")
        buf = bytearray(e + t + c)
        f.readinto(buf)
        mv = memoryview(buf)
        self.empty, self.full, self.cap = mv[:e], mv[e:e + t], mv[e + t:]
        self.run = bytearray(self.W * 2)                 # one row of the repeated middle colour
        self.rv = memoryview(self.run)
        self.p = self.F0                 # where the fill ends now, in strip columns
        self._block(self.empty, self.H, 0, 0, self.W)

    def _size(self, rows):
        return rows * (self.L + 1 + self.R) * 2

    def _window(self, a, b, r0, r1):
        """Open strip columns a..b, rows r0..r1 for writing; the caller streams pixels, then cs(1)."""
        d, x0, x1, y0, y1 = self.d, self.X + a, self.X + b - 1, self.Y + r0, self.Y + r1 - 1
        d._cmd(0x2A, [x0 >> 8, x0 & 255, x1 >> 8, x1 & 255])
        d._cmd(0x2B, [y0 >> 8, y0 & 255, y1 >> 8, y1 & 255])
        d._cmd(0x2C)
        d.dc(1); d.cs(0)

    def _block(self, s, rows, y0, a, b):
        """Draw columns a..b of piece s (rows tall) at strip rows y0..: each end in one write when
        it is whole, the middle one row at a time from its repeated column."""
        L, R, W, spi, cs = self.L, self.R, self.W, self.d.spi, self.d.cs
        right = rows * (L + 1) * 2       # where the right block starts in s
        if a < L:
            e = min(b, L)
            self._window(a, e, y0, y0 + rows)
            if a == 0 and e == L:
                spi.write(s[:rows * L * 2])
            else:
                for r in range(rows):
                    spi.write(s[(r * L + a) * 2:(r * L + e) * 2])
            cs(1)
        m0, m1 = max(a, L), min(b, W - R)
        if m1 > m0:
            self._window(m0, m1, y0, y0 + rows)
            n = m1 - m0
            for r in range(rows):
                i = (rows * L + r) * 2
                _fill(self.run, n, s[i] | s[i + 1] << 8)
                spi.write(self.rv[0:n * 2])
            cs(1)
        if b > W - R:
            e0 = max(a, W - R)
            self._window(e0, b, y0, y0 + rows)
            if e0 == W - R and b == W:
                spi.write(s[right:])
            else:
                for r in range(rows):
                    spi.write(s[right + (r * R + e0 - (W - R)) * 2:right + (r * R + b - (W - R)) * 2])
            cs(1)

    def to(self, frac):
        extra = self.CW - self.CR
        p = max(self.F0 + int((self.F1 - self.F0) * frac), self.F0 + 2 * self.CR)
        if p <= self.p:
            return
        a = max(0, self.p - self.CR)     # from 0 at first: the fill's shadow starts left of F0
        if p >= self.F1 - extra:         # at the end the cap would overlap the track's round end
            self._block(self.full, self.TH, self.T0, a, self.W)
        else:
            self._block(self.full, self.TH, self.T0, a, p - self.CR)
            self._window(p - self.CR, p + extra, self.T0, self.T0 + self.TH)
            self.d.spi.write(self.cap)
            self.d.cs(1)
        self.p = p

    def green(self):
        """Full bar in green, then let go of the pieces so the app's own file has the RAM, and get
        ready to be wiped from a hard interrupt (which may not allocate: everything is prebuilt)."""
        with open("bar.bin", "rb") as f:
            f.seek(self.green_at)
            f.readinto(self.full)
        self._block(self.full, self.TH, self.T0, 0, self.W)
        self.empty = self.full = self.cap = None
        # The logo is plain background under the bar (tools/bar checks), so one row of that colour
        # repaints it. Not the framebuffer itself: the app is drawing into that by now.
        self.row = self.rv
        bg = splash.bg
        for i in range(0, len(self.row), 2):
            self.row[i:i + 2] = bg
        x0, x1, y0, y1 = self.X, self.X + self.W - 1, self.Y, self.Y + self.H - 1
        self.cmds = [(bytearray([c]), bytearray(a)) for c, a in
                     ((0x2A, [x0 >> 8, x0 & 255, x1 >> 8, x1 & 255]), (0x2B, [y0 >> 8, y0 & 255, y1 >> 8, y1 & 255]), (0x2C, []))]

    def hide(self, _t=None):
        """Put the logo's background back where the bar is. Runs as a hard timer interrupt."""
        d, i = self.d, 0
        while i < 3:
            c, a = self.cmds[i]
            d.dc(0); d.cs(0); d.spi.write(c); d.cs(1)
            if len(a):
                d.dc(1); d.cs(0); d.spi.write(a); d.cs(1)
            i += 1
        d.dc(1); d.cs(0)
        i = 0
        while i < self.H:
            d.spi.write(self.row)
            i += 1
        d.cs(1)


def logo(d):
    """The boot logo into d's framebuffer (the screen isn't pushed): its background everywhere, the logo
    in its box. Returns the y just under the logo (None: no logo.bin, a white screen)."""
    try:
        with open("logo.bin", "rb") as f:
            x, y, w, h = struct.unpack(">4H", f.read(8))
            bg = f.read(2)
            d.fill(lcd.index565(bg[0] | bg[1] << 8))
            lcd.art(x, y, w, h, "logo.bin", 10)          # full color, read from flash at each show
        return y + h
    except (OSError, ValueError):
        import ui
        d.fill(ui.WHITE)
        return None


def screen(title="", what="", bar=True):
    """The boot screen with the boot bar, for anything with progress (an install, an update): the logo,
    title over it, what under the bar, the bar empty. Returns the bar (bar.to(0..1) fills it) or None
    without bar.bin. The one progress bar a wedgie shows: don't draw another.
    bar=False: the bar drawn empty into the framebuffer and nothing kept (the bar's pieces take 9 KB in one
    block: on an app's heap that failed, the Wallet's at the yes). For a screen up while an app is still
    loaded, or with nothing to measure; the install draws the real bar after its clean restart."""
    import ui
    d = lcd.LCD()
    logo(d)
    lines = [l for l in ui.wrap(title, ui.COLS_BIG) if l][:2]
    for i, l in enumerate(lines):
        d.center_text(l[:ui.COLS_BIG], (30 if len(lines) == 1 else 16) + i * 24, ui.INK, 2)
    if what:
        d.center_text(what[:ui.COLS_SMALL], 214, ui.MUTED)
    if not bar:
        _track(d)
    d.show()
    if not bar:
        return None
    try:
        with open("bar.bin", "rb") as f:
            return _Bar(f)
    except Exception as e:
        print("loader: no bar:", e)
        return None


def _track(d):
    """The empty bar into d's framebuffer, straight from bar.bin: each row's two ends read into place,
    the middle filled from its one repeated pixel. Allocates nothing big (no _Bar)."""
    try:
        with open("bar.bin", "rb") as f:
            X, Y, W, H, F0, F1, CW, CR, Lw, Rw, T0, TH = struct.unpack(">12H", f.read(24))
            if X + W > 240 or Y + H > 240 or Lw + Rw >= W:
                return
            b, px = memoryview(lcd._ROWS), bytearray(2)     # bar.bin is full color: lcd.put565 picks
            for r in range(H):                          # left end: H rows of Lw pixels   (the nearest of 16)
                f.readinto(b[:Lw * 2])
                lcd.put565(b, Lw, (Y + r) * 240 + X)
            for r in range(H):                          # the middle: one pixel a row, repeated
                f.readinto(px)
                d.fill_rect(X + Lw, Y + r, W - Lw - Rw, 1, lcd.index565(px[0] | px[1] << 8))
            for r in range(H):                          # right end
                f.readinto(b[:Rw * 2])
                lcd.put565(b, Rw, (Y + r) * 240 + X + W - Rw)
    except (OSError, ValueError):
        pass


def what(text):
    """Change the line under the bar (screen()) without touching the bar."""
    d = lcd.LCD()
    try:
        with open("logo.bin", "rb") as f:
            f.seek(8)
            bg = f.read(2)
            c = lcd.index565(bg[0] | bg[1] << 8)
    except OSError:
        import ui
        c = ui.WHITE
    import ui
    d.fill_rect(0, 210, 240, 16, c)
    d.center_text(text[:ui.COLS_SMALL], 214, ui.MUTED)
    d.show(210, 226)


def _bar():
    if not splash.up or not splash.bg:   # no logo on screen: load without a bar
        return None
    try:
        with open("bar.bin", "rb") as f:
            return _Bar(f)
    except Exception as e:               # a missing or bad bar is cosmetic: boot without it
        print("loader: no bar:", e)
        return None


_timer = None
TIMES = "apptimes.txt"                   # "app ms" lines: last boot's wait for each app's first screen


def _times():
    t = {}
    try:
        with open(TIMES) as f:
            for line in f:
                k, v = line.split()
                t[k] = int(v)
    except (OSError, ValueError):
        pass
    return t


GREEN_SHARE = 70                         # % of the wait for the app's first screen that the green bar stays


def _hide_later(bar, app):
    """Wipe the green bar partway through the wait for the app's first screen. Python cannot run
    while the app's own file loads, but a hard timer interrupt can. The app's first show() stops the
    timer (that screen covers the bar anyway) and the wait is remembered for the next boot."""
    global _timer
    from machine import Timer
    times = _times()
    guess = times.get(app) or _size(app)[1] * 28 // 1000     # first boot: ~28 ms per KB of source
    t0 = time.ticks_ms()
    _timer = Timer(period=max(1, guess * GREEN_SHARE // 100), mode=Timer.ONE_SHOT, callback=bar.hide, hard=True)

    def up():
        lcd._on_show = None
        _timer.deinit()
        took = time.ticks_diff(time.ticks_ms(), t0)
        print("loader: %s up after %d ms (guessed %d)" % (app, took, guess))
        if abs(took - guess) * 100 > guess * 15:             # write flash only when it matters
            times[app] = took
            try:
                with open(TIMES, "w") as f:
                    for k in times:
                        f.write("%s %d\n" % (k, times[k]))
            except OSError:
                pass
    lcd._on_show = up


def load(app):
    """Load the files app needs with the bar filling as they go; app itself is still to be imported
    (the bar goes green and is wiped partway through the wait for its first screen). An app with no helper files never shows
    a bar. Errors propagate to main.py."""
    t0 = time.ticks_ms()
    plan = _plan(app)[:-1]
    total = sum(n for _, n in plan) or 1
    bar = _bar() if plan else None
    done = 0
    for m, n in plan:
        t = time.ticks_ms()
        __import__(m)
        print("loader: %s %d bytes %d ms" % (m, n, time.ticks_diff(time.ticks_ms(), t)))
        gc.collect()
        done += n
        if bar:
            bar.to(done / total)
    if bar:
        bar.to(1)
        bar.green()
        gc.collect()
        _hide_later(bar, app)
    print("loader: %s, %d files, %d bytes, %d ms" % (app, len(plan), total, time.ticks_diff(time.ticks_ms(), t0)))
