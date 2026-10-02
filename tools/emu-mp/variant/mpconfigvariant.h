// wedgie.dev's virtual wedgie: the pyscript variant with a FIXED heap, so the emulator runs out of
// memory where an RP2040 would (the pyscript variant grows its heap without limit).
#define MICROPY_CONFIG_ROM_LEVEL                (MICROPY_CONFIG_ROM_LEVEL_FULL_FEATURES)
#define MICROPY_GC_SPLIT_HEAP                   (0)
#define MICROPY_GC_SPLIT_HEAP_AUTO              (0)
#define MICROPY_WEDGIE_SPILL                    (1)     // gc_collect scans the C stack only (build.sh)
