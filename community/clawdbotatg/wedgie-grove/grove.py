# Crystal Grove: a knight walks a big grassy world with a sword. The joystick walks, A (green) slashes; a bush
# you slash has a crystal under it one time in five, and walking over it picks it up. B zooms in, X out.
# Saves: "crystals" (how many you hold). The world is the same every time (seed WORLD_SEED).
#
# Drawing: the knight stays in the middle and the world slides under him. A frame is one fill() in the
# grass color, then only the tiles that aren't plain grass as 16x16 4-bit blits (the screen's own
# format, so no palette lookup) or fill_rects, then the knight, the sword, the HUD.
import time, random, framebuf, gc
from lcd import LCD, Keys, color
import save
import ui

lcd = LCD()
keys = Keys()

FRAME = 40                              # ms a frame: 25 fps (show() alone is ~25 ms)
T = 16                                  # tile size, px
W = H = 110                             # world size, tiles; 78 x 78 of it is land
EDGE = 16                               # water this deep at the edge, so the camera never sees past it,
                                        # even zoomed out (15 tiles each side)
ZOOM = (8, 16, 32)                      # a tile's size on screen at each zoom; the world is in 16s
SPEED = 2                               # px a frame
WORLD_SEED = 7

# Tiles: one byte each in MAP.
GRASS, TUFT, FLOWER, DIRT, WATER, BUSH, TREE, ROCK, STUMP, CRYSTAL = range(10)
SOLID = bytes([0, 0, 0, 0, 1, 1, 1, 1, 0, 0])
MAP = bytearray(W * H)

# The screen has 16 colors (lcd.PALETTE); these are exact ones. KEY is the one the art never uses:
# a sprite's clear pixels hold it, and blit skips it.
KEY = color(60, 60, 60)
PAL = {
    "k": color(0, 0, 0), "i": color(26, 27, 26), "d": color(90, 91, 90), "m": color(120, 123, 120),
    "o": color(148, 149, 150), "g": color(169, 170, 171), "l": color(195, 196, 197),
    "s": color(216, 217, 218), "p": color(236, 237, 238), "w": color(254, 254, 254),
    "G": color(34, 196, 82), "D": color(22, 140, 52), "r": color(227, 49, 44),
    "y": color(255, 220, 0), "b": color(40, 100, 230),
}
GRASS_C = PAL["D"]
PATH_C, PATH_D = PAL["l"], PAL["o"]
WATER_C, WATER_L = PAL["b"], PAL["w"]
HUD_BG = PAL["i"]
LEAF = PAL["G"]


def _fb(rows):
    n = len(rows)
    fb = framebuf.FrameBuffer(bytearray(n * n // 2), n, n, framebuf.GS4_HMSB)
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            fb.pixel(x, y, KEY if ch == "." else PAL[ch])
    return fb


def _half(rows):
    """8x8 from 16x16: each 2x2 block becomes its most common color, or clear if mostly clear."""
    out = []
    for y in range(0, 16, 2):
        r = []
        for x in range(0, 16, 2):
            q = rows[y][x] + rows[y][x + 1] + rows[y + 1][x] + rows[y + 1][x + 1]
            best, n = ".", 1
            for ch in q:
                if ch != "." and q.count(ch) > n:
                    best, n = ch, q.count(ch)
            r.append(best if q.count(".") < 3 else ".")
        out.append("".join(r))
    return out


def _double(rows):
    out = []
    for r in rows:
        d = "".join(ch + ch for ch in r)
        out.append(d)
        out.append(d)
    return out


def sprite(rows):
    """One picture at each zoom (8, 16, 32 px), in the screen's own format (4 bits a pixel), from 16
    strings: '.' clear, a PAL letter a color. Blitted with KEY as the clear color, no palette lookup."""
    return (_fb(_half(rows)), _fb(rows), _fb(_double(rows)))


def mirror(rows):
    return ["".join(r[15 - i] for i in range(16)) for r in rows]


def flip(rows):
    """Upside down."""
    return [rows[15 - i] for i in range(16)]


def rot(rows):
    """90 degrees clockwise: a thing pointing right now points down."""
    return ["".join(rows[15 - c][r] for c in range(16)) for r in range(16)]


HEAD_DOWN = [
    ".......rr.......",
    "......rrr.......",
    ".....kkkkkk.....",
    "....kggggggk....",
    "...kgpggggggk...",
    "...kgkkkkkkgk...",
    "...kgkkkkkkgk...",
    "...kggggggggk...",
    "....kkkkkkkk....",
    "...kkbbbbbbkk...",
    "..kgkbbbbbbkgk..",
    "..kgkyyyyyykgk..",
]
HEAD_UP = [
    ".......rr.......",
    ".......rrr......",
    ".....kkkkkk.....",
    "....kggggggk....",
    "...kgggggggpk...",
    "...kgggggggpk...",
    "...kgggggggpk...",
    "...kggggggggk...",
    "....kkkkkkkk....",
    "...kkbbbbbbkk...",
    "..kgkbbbbbbkgk..",
    "..kgkyyyyyykgk..",
]
LEGS = [
    "....kbbbbbbk....",
    "....kddkkddk....",
    "....kddkkddk....",
    "....kkk..kkk....",
]
LEGS_WALK = [
    "....kbbbbbbk....",
    "....kddkkddk....",
    "....kddk.kkk....",
    "....kkk.........",
]
SIDE = [
    "....rr..........",
    "....rrr.........",
    ".....kkkkkk.....",
    "....kggggggk....",
    "...kggggpggk....",
    "...kggggkkkk....",
    "...kggggkkkk....",
    "...kgggggggk....",
    "....kkkkkkk.....",
    "....kbbbbbk.....",
    "....kbbbkgk.....",
    "....kyyykgk.....",
]
SIDE_LEGS = [
    "....kbbbbbk.....",
    ".....kdddk......",
    ".....kdddk......",
    ".....kkkkkk.....",
]
SIDE_WALK = [
    "....kbbbbbk.....",
    "...kddk.kddk....",
    "...kddk.kddk....",
    "...kkk...kkkk...",
]
# The guy: GUY[facing][step]; facing 0 down, 1 up, 2 left, 3 right.
GUY = [
    [sprite(HEAD_DOWN + LEGS), sprite(HEAD_DOWN + LEGS_WALK)],
    [sprite(HEAD_UP + LEGS), sprite(HEAD_UP + mirror(LEGS_WALK))],
    [sprite(mirror(SIDE + SIDE_LEGS)), sprite(mirror(SIDE + SIDE_WALK))],
    [sprite(SIDE + SIDE_LEGS), sprite(SIDE + SIDE_WALK)],
]
DIRS = ((0, 1), (0, -1), (-1, 0), (1, 0))

BLADE_R = [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "..k.............",
    "kkykkkkkkkkkk...",
    "ddywwwwwwwwwwwk.",
    "kkykgggggggggk..",
    "..k.kkkkkkkkk...",
    "................",
    "................",
    "................",
    "................",
    "................",
]
SWOOSH_R = [
    "....www.........",
    "......www.......",
    "........ww......",
    ".........ww.....",
    "..........w.....",
    "...........w....",
    "...........w....",
    "...........w....",
    "...........w....",
    "...........w....",
    "...........w....",
    "..........w.....",
    ".........ww.....",
    "........ww......",
    "......www.......",
    "....www.........",
]
# BLADE[facing], SWOOSH[facing]: drawn one tile out from the guy, in the facing direction.
BLADE = [sprite(rot(BLADE_R)), sprite(flip(rot(BLADE_R))), sprite(mirror(BLADE_R)), sprite(BLADE_R)]
SWOOSH = [sprite(rot(SWOOSH_R)), sprite(flip(rot(SWOOSH_R))), sprite(mirror(SWOOSH_R)), sprite(SWOOSH_R)]
del BLADE_R, SWOOSH_R

ART = {
    BUSH: [
        "................",
        ".....kkkkk......",
        "...kkGGGGGkk....",
        "..kGGwGGGGGGk...",
        ".kGGwGGGDGGGGk..",
        ".kGGGGGGGGGDGk..",
        "kGGGGGDGGGGGGGk.",
        "kGGDGGGGGwGGDGk.",
        "kGGGGGGGGGGGGGk.",
        "kDGGGGGGGGGDGGk.",
        ".kGGGGDGGGGGGk..",
        ".kDGGGGGGDGGDk..",
        "..kDDGGGGGDDk...",
        "...kkDDDDDkk....",
        ".....kkkkk......",
        "................",
    ],
    TREE: [
        "....kkkkkkk.....",
        "..kkDDDDDDDkk...",
        ".kDDGGDDDDDDDk..",
        "kDDGDDDDDGDDDDk.",
        "kDDDDDDDGDDDDDk.",
        "kDDDDGDDDDDDDDk.",
        "kDDDDDDDDDDDDDk.",
        ".kDDDDDDDDDDDk..",
        "..kkkDDDDDkkk...",
        "....kkkddkkk....",
        "......kdmk......",
        "......kdmk......",
        ".....kddmmk.....",
        "....kkkkkkkk....",
        "................",
        "................",
    ],
    ROCK: [
        "................",
        "................",
        "................",
        "................",
        ".....kkkkkk.....",
        "....klllplok....",
        "...kllllpllok...",
        "..kllllllloook..",
        "..kgllllllooook.",
        ".kgggllllooooomk",
        ".kmggggggooommmk",
        ".kmmmmmmmmmmmmk.",
        "..kkkkkkkkkkkk..",
        "................",
        "................",
        "................",
    ],
    TUFT: [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "...G............",
        "..G.G...........",
        "..G.G.G.........",
        "................",
        "...........G....",
        "..........G.G...",
        "..........G.G.G.",
        "................",
        "................",
    ],
    FLOWER: [
        "................",
        "................",
        "...r............",
        "..ryr...........",
        "...r............",
        "...G......w.....",
        "..........wyw...",
        "..........ww....",
        "...........G....",
        "................",
        "....y...........",
        "...ywy..........",
        "....y...........",
        "....G...........",
        "................",
        "................",
    ],
    STUMP: [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "....G..G.G......",
        "...G.G.G.G.G....",
        "..kkkkkkkkkk....",
        "..kggmggmggk....",
        "...kmmmmmmk.....",
        "....kkkkkk......",
        "................",
        "................",
    ],
    CRYSTAL: [
        "................",
        ".......y........",
        "..y...kkk.......",
        "......kwbk......",
        ".....kwwbbk.....",
        "....kwwbbbbk....",
        "....kwbbbbbk..y.",
        "....kpbbbbbk....",
        "....kpbbbbbk....",
        "....kpbbbbbk....",
        "....kpbbbbbk....",
        ".....kpbbbk.....",
        "......kbbk......",
        ".......kk.......",
        "................",
        "................",
    ],
}
TILE = [None] * 10
for _t, _rows in ART.items():
    TILE[_t] = sprite(_rows)
del ART, _t, _rows
GEM = TILE[CRYSTAL][1]
gc.collect()


def make_world():
    """The same world every time: grass, ponds, dirt paths, tree clumps, bushes, rocks."""
    random.seed(WORLD_SEED)
    rb = random.getrandbits
    m = MAP
    lo, hi = EDGE, W - EDGE
    for y in range(H):
        for x in range(W):
            if x < lo or x >= hi or y < lo or y >= hi:
                m[y * W + x] = WATER
            else:
                r = rb(5)
                m[y * W + x] = TUFT if r < 3 else FLOWER if r == 3 else GRASS
    # ponds
    for _ in range(9):
        cx, cy, r = lo + rb(7) % 70 + 4, lo + rb(7) % 70 + 4, 2 + rb(2)
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r + 1 and lo <= x < hi and lo <= y < hi:
                    m[y * W + x] = WATER
    # stone paths: four out of the middle, one each way, wandering a tile sideways now and then
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        x, y = W // 2, H // 2
        for _ in range(36):
            x, y = x + dx, y + dy
            if m[y * W + x] != WATER:
                m[y * W + x] = DIRT
            if rb(2) == 0:
                s = 1 if rb(1) else -1
                x, y = x + s * dy, y + s * dx
            x, y = min(max(x, lo + 1), hi - 2), min(max(y, lo + 1), hi - 2)
            if m[y * W + x] != WATER:
                m[y * W + x] = DIRT
    # clumps of trees, scattered bushes and rocks, all on grass
    def put(x, y, t):
        if lo <= x < hi and lo <= y < hi and m[y * W + x] <= FLOWER:
            m[y * W + x] = t
    for _ in range(40):
        cx, cy = lo + rb(7) % 78, lo + rb(7) % 78
        for _ in range(4 + rb(3)):
            put(cx + rb(3) - 3, cy + rb(3) - 3, TREE)
    for _ in range(700):
        put(lo + rb(7) % 78, lo + rb(7) % 78, BUSH)
    for _ in range(90):
        put(lo + rb(7) % 78, lo + rb(7) % 78, ROCK)
    # a clearing to start in
    for y in range(H // 2 - 2, H // 2 + 3):
        for x in range(W // 2 - 2, W // 2 + 3):
            if m[y * W + x] != DIRT:
                m[y * W + x] = GRASS
    random.seed(time.ticks_us())        # the crystals aren't the same every time


# The guy: px, py is his sprite's top-left in world pixels; the camera keeps him at (112, 112).
px = py = (W // 2) * T
facing, step, walk = 0, 0, 0
zoom = 1                                # index into ZOOM
swing = 0                               # frames left of a slash
SWING = 10
crystals = save.load("crystals", 0)
leaves = [[0, 0, 0, 0, 0] for _ in range(8)]    # x, y, dx, dy, frames left (world px)
pop = [0, 0, 0]                                 # "+1" over a picked-up crystal: x, y, frames left
hud = framebuf.FrameBuffer(bytearray(80 * 20 // 2), 80, 20, framebuf.GS4_HMSB)


def solid_at(x, y):
    return SOLID[MAP[(y >> 4) * W + (x >> 4)]]


def blocked(x, y):
    """His feet: a 10x5 box at the bottom of the sprite."""
    return solid_at(x + 3, y + 11) or solid_at(x + 12, y + 11) or solid_at(x + 3, y + 15) or solid_at(x + 12, y + 15)


def draw_hud():
    """Redrawn only when the count changes: the gem and the number, 2x."""
    hud.fill(HUD_BG)
    hud.blit(GEM, 1, 2, KEY)
    s = str(crystals)
    tmp = framebuf.FrameBuffer(bytearray(len(s) * 8), len(s) * 8, 8, framebuf.MONO_HLSB)
    tmp.text(s, 0, 0, 1)
    for yy in range(8):
        for xx in range(len(s) * 8):
            if tmp.pixel(xx, yy):
                hud.fill_rect(22 + xx * 2, 2 + yy * 2, 2, 2, ui.WHITE)


def slash():
    """The tile in front of him: a bush there is cut, and has a crystal under it one time in five."""
    dx, dy = DIRS[facing]
    tx, ty = (px + 8 + dx * 14) >> 4, (py + 10 + dy * 14) >> 4
    i = ty * W + tx
    if MAP[i] != BUSH:
        return
    MAP[i] = CRYSTAL if random.getrandbits(8) % 5 == 0 else STUMP
    for k, l in enumerate(leaves):
        l[0], l[1] = tx * T + 8, ty * T + 8
        l[2], l[3] = (k % 4) - 2 + dx, (k // 2) % 4 - 2 + dy
        l[4] = 8 + k % 4


def update():
    global px, py, facing, step, walk, swing, crystals, zoom
    for k in keys.pressed():            # read every frame so presses don't pile up
        if k == "A" and not swing:
            swing = SWING
            slash()
        elif k == "B" and zoom < 2:
            zoom += 1
        elif k == "X" and zoom > 0:
            zoom -= 1
    dx = (keys.held("right") - keys.held("left")) * SPEED
    dy = (keys.held("down") - keys.held("up")) * SPEED
    if swing:
        swing -= 1
        dx = dy = 0                     # he stands still while he swings
    if dx or dy:
        if dx:
            facing = 3 if dx > 0 else 2
        else:
            facing = 0 if dy > 0 else 1
        if not blocked(px + dx, py):
            px += dx
        if not blocked(px, py + dy):
            py += dy
        walk += 1
        step = (walk >> 3) & 1
    else:
        step = 0
    i = ((py + 12) >> 4) * W + ((px + 8) >> 4)
    if MAP[i] == CRYSTAL:
        MAP[i] = STUMP
        crystals += 1
        pop[0], pop[1], pop[2] = ((px + 8) >> 4) * T, ((py + 12) >> 4) * T, 20
        draw_hud()
        save.store("crystals", crystals)
    for l in leaves:
        if l[4]:
            l[0] += l[2]; l[1] += l[3]; l[4] -= 1
    if pop[2]:
        pop[2] -= 1


def draw():
    z = zoom
    S = ZOOM[z]                         # a tile on screen, px
    sh = 3 + z                          # log2(S)
    half = S >> 1
    camx, camy = ((px + 8) * S >> 4) - 120, ((py + 8) * S >> 4) - 120
    ox, oy = -(camx & (S - 1)), -(camy & (S - 1))
    tx0, ty0 = camx >> sh, camy >> sh
    n = 240 // S + 1
    m, tiles, fr = MAP, TILE, lcd.fill_rect
    lcd.fill(GRASS_C)
    sy = oy
    for ty in range(ty0, ty0 + n):
        row = ty * W
        sx = ox
        for tx in range(tx0, tx0 + n):
            t = m[row + tx]
            if t:
                if t == WATER:
                    fr(sx, sy, S, S, WATER_C)
                    if z:
                        if (tx + ty) & 3 == 0:
                            lcd.hline(sx + (3 << z >> 1), sy + (6 << z >> 1), 6 << z >> 1, WATER_L)
                        elif (tx * 3 + ty) & 3 == 1:
                            lcd.hline(sx + (8 << z >> 1), sy + (11 << z >> 1), 5 << z >> 1, WATER_L)
                elif t == DIRT:
                    fr(sx, sy, S, S, PATH_C)
                    if z:
                        fr(sx + (((tx * 5 & 7) + 2) << z >> 1), sy + (((ty * 3 & 7) + 3) << z >> 1), 3 << z >> 1, 2 << z >> 1, PATH_D)
                        fr(sx + (((ty * 7 & 7) + 4) << z >> 1), sy + (((tx * 5 & 7) + 5) << z >> 1), 2 << z >> 1, 2 << z >> 1, PATH_D)
                elif z or t > FLOWER:           # zoomed out, grass tufts and flowers are left off
                    lcd.blit(tiles[t][z], sx, sy, KEY)
            sx += S
        sy += S
    for l in leaves:
        if l[4]:
            fr(((l[0] - px - 8) * S >> 4) + 120, ((l[1] - py - 8) * S >> 4) + 120, 3, 3, LEAF)
    gx = 120 - half
    lcd.blit(GUY[facing][step][z], gx, gx, KEY)
    if swing:
        dx, dy = DIRS[facing]
        bx, by = gx + (dx * 12 * S >> 4), gx + (dy * 12 * S >> 4)
        lcd.blit(BLADE[facing][z], bx, by, KEY)
        if swing < SWING - 1 and swing > 2:
            lcd.blit(SWOOSH[facing][z], bx + (dx * 4 * S >> 4), by + (dy * 4 * S >> 4), KEY)
    if pop[2]:
        lcd.text("+1", ((pop[0] - px - 8) * S >> 4) + 120, ((pop[1] - py - 8) * S >> 4) + 96 + pop[2], ui.WHITE)
    lcd.blit(hud, 0, 0)


def title():
    """The world behind a card with the controls; any button starts."""
    draw()
    lcd.fill_rect(20, 52, 200, 136, ui.WHITE)
    lcd.rect(20, 52, 200, 136, ui.INK)
    ui.band(lcd, 60)
    lcd.center_text("Crystal", 96, ui.INK, 2)
    lcd.center_text("Grove", 116, ui.INK, 2)
    lcd.center_text("joystick  walk", 140, ui.MUTED)
    lcd.center_text("A  slash a bush", 152, ui.GREEN_D)
    lcd.center_text("B  zoom in  X  out", 164, ui.MUTED)
    lcd.center_text("press A to start", 176, ui.MUTED)
    lcd.show()
    keys.pressed()
    while "A" not in keys.pressed():
        time.sleep_ms(30)


def run():
    lcd.fill(ui.WHITE)
    lcd.center_text("growing the grove...", 116, ui.MUTED)
    lcd.show()
    make_world()
    draw_hud()
    gc.collect()
    title()
    n, slow = 0, 0
    while True:
        t = time.ticks_ms()
        update()
        lcd.show_wait()
        draw()
        lcd.show_start()
        took = time.ticks_diff(time.ticks_ms(), t)
        slow = max(slow, took)
        n += 1
        if n % 300 == 0:
            print("grove: frame %d ms (worst of the last 300), %d free" % (slow, gc.mem_free()))
            slow = 0
        left = FRAME - took
        if left > 0:
            time.sleep_ms(left)         # the firmware answers USB in here: always sleep a little
