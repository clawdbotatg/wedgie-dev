# One physical approval for a signed firmware and app pair

Core 0.3.91 asks separately for **Update firmware** and **Install app**. The
checked installer verifies hashes before writing live files. It then replaces
the files individually and reboots. A reset between replacements can leave a
mixed set. The one-approval reference stages both components and models
recovery before the app starts.

`tools/paired_update.py` stages a directory-backed flash fixture.
`tools/paired_update_boot.py` is the shared resume worker for that fixture and
an isolated MicroPython LittleFS boot. Neither is part of the shipped
firmware or available over USB. The host fixture's confirmation callback
stands for a timely green press on the Wedgie. Test release signatures use
a disposable P-256 identity and the existing release verifier.

## Approval and recovery

- Add one signed `@pair  {"mod":"safe","name":"Safe Signer","v":"77"}` line
  to the existing release text. The same signature already covers the core
  version, release serial, core file hashes, and the hash of the app list.
  The signed module and name select a single app from that list. Only an
  upgrade of the active app is supported.
- Verify the signed version and serial against the installed release, and
  verify every required file. Unchanged files can come from the current
  flash. Keep changed bytes in staging while showing the signed core and app
  versions. Red or expiry discards staging. One green press records approval
  for the SHA-256 digest of this exact release text.
- Write the approval journal only after the staged files are durable. At boot,
  before loading the app, recheck the signature, approved digest, version,
  serial, and the staged or already-installed files. Apply the approved
  changes in order. Update the app record and release serial only after the
  complete payload matches. Clear the journal last. No approval survives
  as a reusable session for another release.
- An interruption before the journal leaves the old app and core intact.
  Once the journal exists, recovery rolls forward with the staged payload.
  A missing or corrupt needed byte requires sealed recovery. The installer
  cannot safely boot a mixed core or guess which release to use.

## Checks

```sh
python3 -B tools/test_paired_update.py
node tools/test_paired_update_boot.mjs
python3 -B tools/test_job.py
SPLIT=1 python3 -B tools/test_job.py
```

The optional exact-payload test takes `WEDGIE_PAIRED_V77_FIXTURE` pointing to
a local directory with `test-only-v77/fw` and `emulator-old-v70/fw`. It covers
the 31 on-device core files and 16 app files from the reviewed v77 payload.
It adds the pair line and signs the test envelope afresh. Either paired test
uses the exact payload when the directory is supplied. The MicroPython test
uses the repo's Pico UF2, RP2040 simulator, and LittleFS image toolchain. It
tests a watchdog reset after a file replacement and a corrupt stage that
holds boot before a test app could run. The v77 payload files do not act as
the bootstrap or start the app under this test. This exact fixture stages
303,412 bytes and reports 405,504 bytes of free flash before recovery starts.
Those measurements apply to the fixture's synthetic saves and boot code.

## Porting to the device

Install a signed core with a stable early-boot recovery path before offering
paired updates. The existing core has no command for this. The recovery code
and the release verifier it depends on must stay outside the files it
replaces, with a separate migration path for changing those modules.
Retain the installed-key policy, approved app namespace, and reserved-module
checks in `job.check`. Reserve staging and journal space before the question.

Keep USB in checked-update mode and keep physical approval in `ui.ask`.
Treat an incomplete or untrusted journal as a sealed boot recovery condition.
Validate the RP2040 heap, littlefs durability, signed boot migration,
brownouts at each mutation, USB re-enumeration, and final app state on a
disposable board before proposing the feature for a wallet-bearing device.
The POSIX and virtual LittleFS tests do not establish those physical-device
properties.

## Staged bridge bench

`firmware/boot.py` keeps `PAIRED_UPDATE_BENCH` off. A test-image builder turns
it on only in a disposable LittleFS image and provisions the recovery
modules and release verifier with a disposable public key. The ordinary
firmware contains no modules that enable this path.

In the bench image, the sealed slot accepts `paired_update` with only `id`
and `type`. That command reads the staged signed pair and starts review. It
requires the installed app, firmware version,
release serial, and keys to match the provisioned policy, checks the staged
hashes, and reserves metadata space. It shows the signed core and app
versions using stock `ui.ask`. The physical green press is the only event
that can write the approval journal. The fixture pins `boot.py`, `main.py`,
`wedgie.mpy`, and `slot.mpy`, and excludes the recovery modules from the
paired payload. It advances the release serial and can replace unpinned
core files. The pinned version module keeps the numeric core version fixed.

```sh
python3 -B tools/test_paired_staging.py
node tools/test_paired_staged_bridge.mjs
```

The test uses the ordinary boot and slot, the original hardware button pins,
and an isolated app. It tests physical red, a USB button request during
review, disabled dispatch, tampered staging, insufficient flash, and a
watchdog cut between a core-file write and app replacement. The emulator
counts both the deliberate restart after green and the watchdog reset.
After recovery the stock slot starts the new app sealed.

### Sealed USB staging

The uploader adds a signed `@sizes` line to the release whose value is the
SHA-256 of a separate UTF-8 file. This file has one `decimal_length  filename`
line per signed core and selected app file, ending with a newline. The
device checks exact name coverage against the signed hashes. Older fixture
envelopes remain usable as preloaded offers.

Every request is a stock USB JSON line with an integer `id` and a `type`.

| Request | Fields | Result |
| --- | --- | --- |
| `paired_stage_begin` | `release_size`, `shelf_size`, `sizes_size`, `sig` | `paired_stage_meta` with `offset: 0`. A second begin preserves the existing upload. |
| `paired_stage_meta` | `offset`, `data` | A `paired_stage_meta` next offset, a `paired_stage_put` cursor, or `paired_staged` with no uploads needed. |
| `paired_stage_put` | `name`, `offset`, `data` | The next `paired_stage_put` cursor or terminal `paired_staged`. |
| `paired_stage_abort` | None | `paired_stage_aborted` for an unapproved update. |

Metadata is the concatenation of raw release, app shelf and size-map bytes
in that order, capped at 8,192 bytes. Both transfers use canonical Base64
with at most 1,024 decoded bytes per chunk. `paired_stage_put` cursors give
the exact `name`, `offset`, `size`, and SHA-256 `digest` of the requested
file. Only changed files are sent. Zero-length files need no upload. The
terminal `paired_staged.digest` identifies the release, not a file hash.
Staging does not create an approval journal. Review starts when the host
sends `paired_update`, and the physical button remains the only approval.

The device verifies metadata, installed policy, and the flash reserve
before it accepts any update file. A payload failure, abort, idle timeout,
or reboot cleans up incomplete staging. A durable staged offer survives a
reboot and must be reviewed again. A USB command cannot abort an approved
recovery. The temporary metadata input is bounded and never executed.

A signed migration with a permanent boot policy, integration with apps that
own the USB stream, production flash-wear limits and signer heap tests, and
physical brownout and flash tests remain before shipping.

### Numeric core transition bench

The versioned test policy adds a signed, executable top-level `pair_core.py`
file. Its first line must declare the same version as the release. The
uploader checks that line as data after hashing the staged bytes. A mismatch
cannot create an offer for review. The version policy is available only in
the isolated bench image. The standard image disables its boot and USB hooks.

The boot worker verifies the paired files before applying them. It checks the
installed runtime module's hash again before importing it and requires its
runtime `VERSION` to equal the signed release version. The pinned boot, main,
slot, Wedgie identity module, verifier, and release keys stay in place. The
worker archives the signed receipt before consuming the approval journal.
On a later boot it rechecks the active receipt against the installed serial,
app record, and file hashes before reporting the version or loading the app.
An absent receipt is accepted only for the original provisioned state, with
the exact core, app, serial, and baseline payload hashes checked against the
stable policy. An upgrade retaining the same numeric core still needs its own
receipt. Inconsistency leaves the boot sealed. The versioned bench supports only paired
activation after migration. Changing the app or firmware through another
installer has no coordinated receipt and is outside this bench.

```sh
node tools/test_paired_staged_bridge.mjs upload-core upload-core-mismatch upload-same-core-receipt-lost
```

The fixture updates core 0.3.91 to 0.3.92, exercises the changed core
function in the app, compares pinned files and the local and devnet sample
profiles, and checks persistence after another reset. It also supplies a
validly signed pair whose module declares 0.3.93 and whose release declares
0.3.92. The same-core test boots the new app after physical approval, then
simulates receipt loss and checks that the next boot stays sealed. This
prototype requires a small explicit source version module.
It does not qualify a general firmware ABI migration or production recovery
procedure.
