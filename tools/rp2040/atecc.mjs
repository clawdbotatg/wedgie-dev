// A stand-in ATECC608 for a virtual board with no secure chip: slot 0 holds a locked key (only its public half
// matters) and can't sign, so a yes ends in the app's error answer at the chip step. Used by tools/safechip.mjs
// and tools/sandboximage.mjs (wedgie.dev/sandbox).
export const key = { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32), chip: "ATECC608" };
export const ATECC = `OP_LOCK = 0x17
CONFIG = bytes(20) + b"\\xaf\\x2f" + bytes(74) + b"\\x33\\x00" + bytes(30)
class ATECC608:
    def __init__(self, sda=None, scl=None):
        pass
    def wake(self):
        pass
    def sleep(self):
        pass
    def read_config(self, b):
        c = bytearray(CONFIG)
        c[86] = c[87] = 0
        c[88], c[89] = 0xFE, 0xFF
        return bytes(c[b * 32:b * 32 + 32])
    def lock_state(self):
        return {"configLocked": True, "dataLocked": True}
    def pubkey(self, slot=0):
        return 0x${"11".repeat(32)}, 0x${"22".repeat(32)}
    def sign(self, digest, slot=0):
        raise OSError("the key is in an ATECC608 and none answered")
`;
