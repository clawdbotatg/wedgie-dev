# Jiro-ikusu on a wedgie: Training (README §8.1), the 16 levels, offline, at 15 Hz, with local best
# scores. The three large blocks come first, largest first, while the heap is least fragmented: the core's 24 KB
# stack, its 18.5 KB Recorder, then jiro_core's 18 KB of code, before any small allocation can
# split the space they need (round E1: right after a power-up, which also starts the WEDGIE drive,
# the code found no block). Then all the app holds from level to level, so that playing allocates
# nothing sizable: the level file, open once (a file on a wedgie's littlefs is a 1,148-byte
# object), the shadow, the level buffer and the bests, which save.load reads through another. The
# stack is passed in a list, so that the app can lend its block to save.store between levels. The
# game's code is precompiled in jiro_app.mpy, because compiling it from source here would scatter
# its parse tree over that heap.
import gc

STACK_BYTES = 24576  # start needs up to 19 KB of stack; the rp2 C stack is 8 KB
RECORDER_BYTES = 18568  # jiro_core.recorder_size(), which jiro_app checks
SHADOW_BYTES = 3600  # jiro_core.shadow_size(), which jiro_app checks
LEVEL_BYTES = 472  # a level's bytes in the level file, which jiro_app checks
LEVELS = "jiro_levels.bin"


def heap(stages, stage):
    """Measures the free heap and the largest bytearray it can hold, to 16 bytes, after a
    collection; prints them and records them in `stages` under `stage`."""
    gc.collect()
    free = gc.mem_free()
    low, high = 0, free
    while high - low > 16:
        size = (low + high) // 2
        try:
            block = bytearray(size)
        except MemoryError:
            high = size
        else:
            del block
            low = size
    gc.collect()
    stages[stage] = (free, low)
    print("jiro: heap %s: free %d B, largest block %d B" % (stage, free, low))


def run():
    stages = {}
    heap(stages, "run")
    stack, recorder = [bytearray(STACK_BYTES)], bytearray(RECORDER_BYTES)
    heap(stages, "buf")
    try:
        import jiro_core  # its 18 KB of code next, then jiro_app's objects fill the holes it leaves
    except MemoryError as error:
        raise MemoryError("%s; heap free/largest at start %d/%d, after the stack and Recorder %d/%d" % (
            (error,) + stages["run"] + stages["buf"]))
    level_file = open(LEVELS, "rb")  # in the hole of the file jiro_core was read through
    shadow, level = bytearray(SHADOW_BYTES), bytearray(LEVEL_BYTES)
    import save
    bests = save.load("bests", {})
    import jiro_app
    heap(stages, "imp")
    jiro_app.main(stack, recorder, shadow, level, level_file, bests, heap, stages)
