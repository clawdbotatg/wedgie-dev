# no ASYNCIFY (it makes every exec async); pointers held in wasm locals get spilled to the C stack by
# binaryen's spill-pointers pass (run after the link, see build.sh), so gc_collect finds them with
# emscripten_scan_stack alone. -g keeps the names that pass needs (__stack_pointer).
JSFLAGS += -s ALLOW_MEMORY_GROWTH -g
FROZEN_MANIFEST ?= variants/wedgie/manifest.py
