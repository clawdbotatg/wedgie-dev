# Saves: what a game keeps between plug-ins. Each game gets its own folder, /saves/<game>/, picked by
# the firmware (slot.py sets `game` to the running app), so games never see each other's saves.
# Nothing that installs, switches or updates software touches /saves; wedgie.dev/format backs it up
# before a wipe and puts it back after.
#
#   import save
#   save.store("best", {"score": 120})     # anything json can write; bytes are kept as they are
#   best = save.load("best", {"score": 0})  # the default when there is no save yet
#   save.delete("best");  save.names()
#
# No size limit per game: saves share the free flash, but a write that would leave less than FLOOR
# free fails (OSError), so the firmware can always boot and wedgie.dev can always switch software.
# Keep a big save in several names: the older Pico has about 100 KB of RAM for a game.
# A write goes to a temp file first and is renamed into place, so pulling the plug mid-save keeps the
# last good one.
import os, json

ROOT = "/saves"
FLOOR = 32 * 1024
game = None


def _mkdir(p):
    try:
        os.mkdir(p)
    except OSError:
        pass                            # already there


def _check(name):
    if not name or len(name) > 32 or name[0] == "." or any(c in name for c in "/\\ :*?\"<>|"):
        raise ValueError("save name: up to 32 letters, digits, - _ or .")
    if not game:
        raise OSError("no game is running")


def _path(name, ext):
    return "%s/%s/%s%s" % (ROOT, game, name, ext)


def _free():
    try:
        s = os.statvfs("/")
        return s[0] * s[3]
    except Exception:
        return None


def store(name, data):
    _check(name)
    raw = isinstance(data, (bytes, bytearray, memoryview))
    b = bytes(data) if raw else json.dumps(data).encode()
    f = _free()
    if f is not None and f - len(b) < FLOOR:
        raise OSError("flash full: delete some saves at wedgie.dev")
    _mkdir(ROOT)
    _mkdir(ROOT + "/" + game)
    ext, other = (".bin", ".json") if raw else (".json", ".bin")
    p, tmp = _path(name, ext), _path(name, ext + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(b)
    try:
        os.rename(tmp, p)
    except OSError:                     # a file system that won't rename over a file
        os.remove(p)
        os.rename(tmp, p)
    try:
        os.remove(_path(name, other))   # it changed kind (json <-> bytes)
    except OSError:
        pass


def load(name, default=None):
    _check(name)
    try:
        with open(_path(name, ".json")) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        pass
    try:
        with open(_path(name, ".bin"), "rb") as fh:
            return fh.read()
    except OSError:
        return default


def delete(name):
    _check(name)
    for ext in (".json", ".bin"):
        try:
            os.remove(_path(name, ext))
        except OSError:
            pass


def names():
    if not game:
        return []
    try:
        fs = os.listdir("%s/%s" % (ROOT, game))
    except OSError:
        return []
    return [n.rsplit(".", 1)[0] for n in fs if n.endswith(".json") or n.endswith(".bin")]
