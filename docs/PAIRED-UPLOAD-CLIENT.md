# Offline signed-pair client

The client checks the selected board UID and sealed state. It pins the reviewed
release hash, verifies all bundle files locally, and follows the device's bounded
metadata and payload cursors. The firmware authenticates the signature using
its installed trust roots.

`paired_bundle.py` prepares a new unsigned folder from the reviewed stock
release and shelf. The pair keeps the stock cart fingerprint, recomputed from
the exact ordered app bytes. The tool copies only signed files and emits the
new release hash for review. Release signing is a separate step.

```sh
python3 -B tools/paired_bundle.py --source REVIEWED_FW --destination NEW_PAIR \
  --reviewed-sha256 STOCK_RELEASE_SHA256 --app safe

uv run --offline --with pyserial python3 -B tools/paired_upload.py \
  --bundle SIGNED_PAIR --release-sha256 PAIRED_RELEASE_SHA256 \
  --port SELECTED_PORT --uid SELECTED_UID
```

The upload defaults to staging. Use `--offer` to stage and request one
physical confirmation, or `--offer-staged` to review the exact bundle
already on the device. The client checks the exact digest and cart identity
before cueing the physical button. It waits for the approved app to run on
the same sealed board, then verifies every signed file and the release
serial. For Safe Signer, it also checks that the existing Ethereum signer
and readable Solana profiles match the state before the update. The client
makes no button request.

The provided firmware transport is an opt-in bench path. Its bootstrap stays
pinned. The numeric-version fixture uses an authenticated replacement core
module and the separate versioned bench policy. For release, qualify the
signed bootstrap migration and checked staging on a spare physical device
before enabling it for a wallet-bearing Wedgie.

```sh
python3 -B tools/test_paired_upload.py
```

Run the same host logic over simulated USB with the disposable release-signing
fixture. It invokes the virtual GPIO button, then checks recovery, signed
readback, and the fixture save.

```sh
paired_out=$(mktemp -d)
uv run --offline --with littlefs-python --with mpy-cross==1.29.0.post2 \
  python3 -B tools/test_paired_staged_bridge_image.py upload-recover "$paired_out/stage.img"

python3 -B tools/test_paired_upload_rp2040.py --firmware "$PWD" \
  --image "$paired_out/stage.img" --report "$paired_out/review.json"
```

`build_signer_upload_image.py` can replace the synthetic app with reviewed
v77 and v78 app folders. Use `--versioned-core` to combine that upgrade with
the authenticated 0.3.91 to 0.3.92 transition. The reviewed application files
are used byte for byte. Fixtures have disposable Trust M keys and test saves.

```sh
uv run --offline --with littlefs-python --with mpy-cross==1.29.0.post2 \
  python3 -B tools/build_signer_upload_image.py --versioned-core \
  "$reviewed_v77" "$reviewed_v78" "$paired_out/actual-signer-core.img"

python3 -B tools/test_paired_upload_rp2040.py --firmware "$PWD" \
  --image "$paired_out/actual-signer-core.img" --report "$paired_out/signer-core.json"
```

The combined test checks one virtual GPIO approval, a watchdog cut during
commit, sealed boot of v78, changed executable core behavior, exact pinned
and cartridge hashes, unchanged fixture saves and key identities, and
mainnet refusal. It then applies a simulated power cycle to recheck the
authenticated core and app from retained flash and chip state.
