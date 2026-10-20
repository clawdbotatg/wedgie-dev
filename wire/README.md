# wire: clear signing groundwork

`wire.py` reads the **ERC-7730 wire format**: the small signed messages that tell a hardware wallet what a
transaction does ("Swap 1 ETH for 2,400 USDC"), so it can show that instead of raw bytes.

The format is Nicolas Bacca's (btchip), part of his **universal signer**. Spec:
https://github.com/ZKNoxHQ/eth-universal-signer/blob/7730-wire-format-implementations/specs/7730_wire_format.md
(v 29.09.26-1). His code is Rust (`ethereum/ethereum-app`); a wedgie runs MicroPython, so this is our own.

## Status

- **Not used yet.** Not in `firmware/`, not on any wedgie. One file plus tests.
- When Safe Signer gets clear signing, it goes into that app (as `safe_wire.py`), or into the firmware if
  several apps need it.
- Built only the parts of the spec that shouldn't change. The rest waits for the spec to settle.

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
