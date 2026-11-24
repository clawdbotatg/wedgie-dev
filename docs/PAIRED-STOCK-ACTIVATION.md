# Enter paired-update mode through checked stock installs

This is a disposable test migration built from the local paired-update
candidate. The ordinary firmware still disables paired updates by default.

The first separately approved stock core job adds the six inert worker
modules in `DORMANT_WORKERS`. It preserves the existing boot, main, slot,
trust wrapper, and active cart. There is no `apps` or `delete` instruction
in the job.

The second separately approved stock core job installs the activation boot
gate and paired slot code. The gate pins the hashes of the six worker files,
main, slot, and the existing trust wrapper before loading any of them. If
boot sees the exact dormant serial with no previous paired state, the stock
installer remains active. A torn or lower serial, a shadow module, or a
missing or mismatched file at the committed activation serial holds boot
sealed.

After verification, the worker checks the approved baseline app, serial,
and baseline file hashes. It creates the paired state with a durable temp
file and atomic rename. If that rename is interrupted, the verified baseline
can seed state again. After a paired update has a journal or active receipt,
the worker requires its existing state and lets the paired recovery engine
resume it.

```sh
python3 -B tools/test_paired_bootstrap_gate.py
```

Production must resolve the stock installer's non-atomic serial write during
the dormant phase, provision the exact already-enrolled release roots and
trusted imports, and verify the resulting signed migration on a spare
physical board. The local gate does not provide a hardware anti-rollback
anchor for rollback of the entire flash and does not introduce a recovery
writer.

For cold-boot fault checks, pass a disposable signed stock migration fixture
and its matching `.host.json` to the test. This creates three new emulator
images in the output directory and checks committed and interrupted states.

```sh
uv run --offline --with littlefs-python python3 -B \
  tools/test_paired_stock_cold_images.py DISPOSABLE_STOCK_IMAGE OUTPUT_DIR
node tools/test_paired_stock_cold_gate.mjs OUTPUT_DIR
```

The reviewed Safe v77/v78 fixture can start from the committed stock
activation snapshot with `build_signer_upload_image.py --versioned-core
--stock-activation`. It deliberately starts without an installed paired
state. The boot gate must initialize that state before the existing
emulator test can stage the new core and v78, make one virtual physical
approval, recover from the fixture cut, and read the signer and profiles
again. The snapshot exercises the handoff to the actual app binaries. The
stock wire rehearsal separately exercises both signed installs on a
disposable board image.

## Diagnostic variant

The diagnostic fixture installs the audited diagnostic `main.py` in the
dormant stock job alongside the workers. Without an activation fault
sentinel it follows the ordinary main path. The second job independently
pins this exact main along with the activation files. After an activation
integrity failure, only the exact pinned main may enter the recovery loop.
It uses built-in CDC, skips the ordinary boot addons and drive, and exposes
sealed status. A mismatched diagnostic main holds boot sealed before CDC.
The normal stock image and the activation renderer's default stay unchanged.

The test covers imported worker verification, the dormant stock path, a
missing worker, forged diagnostic main, startup control bytes, and
byte-for-byte flash comparison after diagnostic requests. The two-job
wire test uses a disposable signing root and synthetic app. It exercises
the separately approved stock installs and an interrupted activation retry.

```sh
uv run --offline --with littlefs-python --with mpy-cross==1.29.0.post2 \
  python3 -B tools/build_activation_recovery_images.py OUTPUT_DIR
node tools/test_activation_recovery_rp2040.mjs "$PWD" OUTPUT_DIR

uv run --offline --with littlefs-python --with mpy-cross==1.29.0.post2 \
  python3 -B tools/build_paired_diagnostic_stock_migration.py OUTPUT_DIR/wire.img
node tools/test_paired_diagnostic_stock_migration.mjs \
  OUTPUT_DIR/wire.img OUTPUT_DIR/wire.json --faults
```

This candidate reports recovery status. A separately authenticated repair
transport and physical board qualification are still open.

Pass `--same-serial-dormant` to the disposable wire-image builder to
exercise the alternative dormant policy. It reuses the initial serial for
the dormant job and still advances the activation serial. Adopting it for
an owner release needs review of both distinct envelopes at the shared
serial.

### Reviewed signer through the stock wire and the paired wire

The diagnostic wire fixture also accepts the reviewed Safe v77 and v78 folders.
It starts with the exact v77 app bytes, stock boot and slot, and disposable
Trust M profiles. The two stock jobs preserve the running v77 app and saves.
The following paired job installs the exact v78 app bytes and the signed test
core 0.3.92 with one simulated GPIO approval. The test interrupts the paired
commit, verifies sealed state, identities and mainnet refusal, then checks the
restored state again after a simulated power cycle.

```sh
uv run --offline --with littlefs-python --with mpy-cross==1.29.0.post2 \
  python3 -B tools/build_paired_diagnostic_stock_migration.py OUTPUT_DIR/reviewed.img \
  --reviewed-v77 REVIEWED_V77_FOLDER --reviewed-v78 REVIEWED_V78_FOLDER
node tools/test_paired_diagnostic_stock_migration.mjs \
  OUTPUT_DIR/reviewed.img OUTPUT_DIR/reviewed.json
```

## Rehearse from installed v78

Use `--retain-v78 --reviewed-v78 PATH` to start the disposable
stock bootstrap from the reviewed v78 app at serial 102. The two stock
jobs match the proposed dormant and activation serials. The final paired
test updates a signed core fixture while keeping the exact v78 cartridge
bytes. Add `--same-serial-dormant` to keep the first serial at 102, or
omit it to exercise 103. Both paths activate at 104 and test paired
recovery at serial 105.

The fixture uses disposable trust roots, wallets, and saves. It applies
two signed stock jobs through the simulated hardware buttons, performs
one paired approval, injects the existing watchdog cut, and checks the
core, cartridge, identities, and saves again after a cold boot. The
readback matches the final tested fixture. The unsigned owner plans
still need separate policy approval, signing, and spare-board testing.
