# wire: clear signing groundwork

`wire.py` reads the **ERC-7730 wire format**: the small signed messages that tell a hardware wallet what a
transaction does ("Swap 1 ETH for 2,400 USDC"), so it can show that instead of raw bytes.

The format is Nicolas Bacca's (btchip), part of his **universal signer**. Spec:
https://github.com/ZKNoxHQ/eth-universal-signer/blob/7730-wire-format-implementations/specs/7730_wire_format.md
(v 29.09.26-1). His code is Rust (`ethereum/ethereum-app`); a wedgie runs MicroPython, so this is our own.

## Status

- **Used by Safe Signer safe-24** (clawdbotatg/wedgie-safe): `safe_wire.py` is a copy of `wire.py` (keep them the
  same), `safe_7730.py` turns a descriptor into the screen. **Not on the shelf yet** (10-22): the gate's "install
  over Buttons" check fails with it, on an old firmware race the bigger shelf entry exposes in the simulator:
  `slot._to_job` (USB timer) runs `power.stop()`, which sets `lcd._on_frame = None` while `lcd._push` is between
  `if _on_frame:` and the call (TypeError; the install still finishes). Fix in firmware: read `_on_frame` (and
  `_on_show`) into a local once. Until then, install safe-24 from GitHub by hand (its page) or `wedgie.py install`.
- **The data** wedgie.dev serves: `release.py` builds `public/clear/<tag>/` from the registry and a token list,
  every structure with a Merkle proof (algorithm 4) to two roots built into the app (`safe_roots.py`). See below.
- **Tests:** `tools/test_clear.py` runs the app's reader on the registry's own test transactions (1,510 on chains
  the app does: 1,367 show exactly what the registry expects, 125 differ on purpose, 18 explained in the test);
  `tools/safechip.mjs` signs four of them on a virtual RP2040.

## Make a release (new registry data)

```
git clone --depth 1 https://github.com/ethereum/clear-signing-erc7730-registry /tmp/reg
uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome --with cryptography \
    python3 wire/release.py /tmp/reg public/clear ../wedgie-safe/safe_roots.py
uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome --with cryptography \
    python3 tools/test_clear.py /tmp/reg ../wedgie-safe
```

Then commit `safe_roots.py` in wedgie-safe (a new app version: the roots changed), re-pin it here
(`community.mjs add`), sign, commit `public/clear/<new tag>` with it. Keep the old tag's folder until wedgies have
updated: an app only reads its own tag's data. Descriptors are compiled from clearsig's merge of a file's
`includes`, the same JSON an auditor hashes; an attestation counts only if its EAS signature recovers to an auditor
in `AUDITORS` and its data is that hash.

## What building it taught us (for Bacca and the WG)

1. **P-256 isn't an allowed algorithm**, and secp256k1 in pure Python is ~2 s a check. Algorithm 4 (a Merkle root
   in the signer, as PQ1) needs no curve at all, and the root rides in the signed app. The catch: new data = new app.
2. **Merging `includes`:** our first converter replaced arrays; the spec merges `fields` by path. What an auditor
   hashes (ERC-8176) is the merged JSON, so the spec should define the merge for converters too.
3. **Literal constants have no type.** A `"value": "USDC"` field arrived as BYTES and showed as hex.
4. **Visibility on BYTES:** LI.FI's `ifNotIn: [0]` on a `bytes` field. The spec says "exact bytes"; the registry's
   runners treat empty as 0. We follow the runners (zero matches zero), only for hiding and mustMatch.
5. **`amount` has no threshold** in the wire format; ERC-7730 v2's `amount` does.
6. **Unknown enum values:** the wire spec says the field MUST fail; two registry tests expect the raw number.
7. **No names to show:** no source for NFT collection names or address names, so "#1001 of 0x.." and addresses.
8. **Audit coverage is thin:** 760 of 6,736 descriptor deployments on our chains are attested (Cyfrin only; 11 of
   its attestations were dropped for re-review, Aave v3 among them).

## What it does

- Reads and writes CBOR (deterministic only, anything else is refused).
- Reads a descriptor **in place, one field at a time**. Decoded whole, a 4 KB descriptor ran a virtual
  RP2040 out of memory. In place it leaves 101 KB free.
- Finds the bytes a signature covers (`signed_message`).
- Runs slot programs: finds a value in the transaction data without knowing the contract's layout.

## Test messages from the real registry

`from7730.py` (runs on the computer, never on a wedgie) turns the public ERC-7730 registry's calldata
descriptors into wire-format messages, signed with a public test key (secp256k1, the spec's algorithm 1):

```
python3 wire/from7730.py <registry>/registry <out dir>     # one .cbor per (chain, contract, selector)
```

Registry 7ced22e (2026-10-19): 8,774 messages from 543 files, the biggest 1,144 bytes. 3 files skipped (see
below). Its 1,543 test transactions all find their message, the signature checks, every value reads out of
the real calldata in place, and the labels a wallet must show are all there in order. Not yet checked:
that the values are the right ones. That comes with step 2, against the registry's expected screens.

## Tests

```
uv run -q --with cbor2 --with eth-abi --with cryptography python3 tools/test_wire.py   # 70 checks
uv run -q --with pycryptodome --with cryptography python3 tools/test_from7730.py       # the whole registry
node tools/wirechip.mjs                                                                  # virtual RP2040
```

A 56-field descriptor takes ~5 s on the virtual chip. A normal 3-5 field one should be well under 1 s.
Not yet run on a real wedgie.

## Next steps

Done: test messages from the real registry (`from7730.py`).

1. **Bacca's answers** (Telegram DM, 10-20):
   - **Empty field list** (`pause()`): signers should accept it; `[+ field]` should allow empty. We send `[]`.
   - **Extra bytes after the ABI part** (1inch): fine if a neutral tracker or note (the descriptor should
     ideally flag it), not fine if it changes the tx (then the descriptor needs fixing). A signer can't tell
     which, so `path()` still reads and `extra_bytes()` says how many: not 0 = warn on screen, A still signs.
     A trailer of whole slots can't be seen (the wire format has no parameter types).
   - **Signed data from the internet** (the price demo): "absolutely not a non starter". Commercial wallets
     use a server that signs it. A middle step: the device runs the TLS connection, the host only passes bytes.
   - **His code:** decoding and screen text will live in `ethereum/ethereum-app/common-eth-signer` (Rust).
     He suggested it "if that's not redundant"; he hadn't read ours. A wedgie can't run Rust.
   - **Asked 10-20, waiting:** would he add P-256 as an allowed signature type? It's all a wedgie can check
     fast (step 2).
   - Not asked, low value: his example messages (none published; we have 8,774 of our own), the `[1, null]`
     array step (we refuse it), Safe-only signing.
   - On 10-17 he said he has to compare the wedgie with Leek, which does something very similar.
2. **Check signatures.** The spec's signatures are secp256k1 or Ed25519. We only have P-256 (`firmware/p256.py`).
   secp256k1 in pure Python is ~2 s per check. Asked Bacca to allow P-256 (10-20).
3. **Trusted sources.** Which keys the wedgie accepts and how many must agree, changed only with an A press.
   Local mode: only your own node, and the screen says "local mode". Same plan as the signed price demo
   (`api/price.ts`, `clawdbotatg/wedgie-price`).
4. **Fresh answers.** Messages carry a date, but a wedgie has no clock. Use our nonce (as the price demo does,
   and as Ledger does for proxies) so an old answer can't be replayed.
5. **Proxies.** Use `proxy-information` to match an upgradeable contract's current code, and warn if it changed.
6. **Show it.** Match the descriptor to the Safe transaction's inner call, draw the fields in Safe Signer.
   If anything can't be read, refuse or ask to blind sign. Never show half.
7. **Speed and size.** Ship it compiled (`.mpy`), measure on a real wedgie.
8. **Watch the spec.** EIP-712 isn't in it yet. Next sync call: 2026-10-21.
