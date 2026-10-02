#!/bin/bash
# Builds the virtual wedgie's MicroPython (src/emu/mp/micropython.{mjs,wasm}): the webassembly port's
# pyscript variant at the same version as the boards' firmware, with a FIXED GC heap. The npm build
# (@micropython/micropython-webassembly-pyscript) grows its heap without limit, so the emulator never
# ran out of memory and 0.3.6's crash on a real RP2040 passed every test. Here gc_collect scans the C
# stack, and binaryen's spill-pointers pass puts pointers held in wasm locals there (ASYNCIFY, the
# port's other way, makes every exec async and breaks the page's synchronous calls).
# The heap size is set by the page: DEFAULT_HEAP in src/emu/runtime.ts (calibrated, see there).
#   tools/emu-mp/build.sh [workdir]      needs git, make, python3.12 (emsdk refuses 3.14)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../src/emu/mp"
W="${1:-${TMPDIR:-/tmp}/wedgie-emu-mp}"
MP_TAG=v1.26.0
mkdir -p "$W" && cd "$W"
[ -d emsdk ] || git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git
(cd emsdk && EMSDK_PYTHON=python3.12 python3.12 emsdk.py install latest >/dev/null && EMSDK_PYTHON=python3.12 python3.12 emsdk.py activate latest >/dev/null)
[ -d micropython ] || git clone -q --depth 1 --branch "$MP_TAG" https://github.com/micropython/micropython.git
cd micropython
V=ports/webassembly/variants/wedgie
mkdir -p "$V" && cp "$HERE"/variant/* "$V"/
# gc_collect without emscripten_scan_registers (that needs ASYNCIFY); -Werror off: newer clang warns
grep -q MICROPY_WEDGIE_SPILL ports/webassembly/main.c || python3 - <<'PY'
p = "ports/webassembly/main.c"; s = open(p).read()
s = s.replace("    emscripten_scan_registers(gc_scan_func);", "    #if !MICROPY_WEDGIE_SPILL\n    emscripten_scan_registers(gc_scan_func);\n    #endif")
open(p, "w").write(s)
PY
sed -i.bak 's/^CFLAGS += -std=c99 -Wall -Werror/CFLAGS += -std=c99 -Wall/' ports/webassembly/Makefile
source ../emsdk/emsdk_env.sh >/dev/null 2>&1
make -C mpy-cross -j8 CWARN="-Wall -Wno-gnu-folding-constant" >/dev/null
make -C ports/webassembly VARIANT=wedgie submodules >/dev/null
rm -rf ports/webassembly/build-wedgie
make -C ports/webassembly VARIANT=wedgie -j8 >/dev/null
B=ports/webassembly/build-wedgie
# spill-pointers LAST: an optimizer pass after it sees the spills as stores nobody reads and drops them
# (the GC then missed live objects: "Cannot read properties of undefined (reading 'call')")
F="--enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext"
../emsdk/upstream/bin/wasm-opt "$B/micropython.wasm" -Os -g -o "$B/os.wasm" $F     # -g: keep the names spill-pointers needs
../emsdk/upstream/bin/wasm-opt "$B/os.wasm" --spill-pointers --strip-debug --strip-producers -o "$B/opt.wasm" $F
mkdir -p "$OUT"
cp "$B/micropython.mjs" "$OUT/micropython.mjs"
cp "$B/opt.wasm" "$OUT/micropython.wasm"
ls -la "$OUT"
