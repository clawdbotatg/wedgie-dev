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

1. **Ask Bacca** (Austin; btchip on Telegram, group "7730 Wire Format - Clear Signing Side Quest"):
   - real example messages to test against. As of 2026-10-19 none are published: the spec branch's last
     commit is 09-29, `ethereum/ethereum-app` has no 7730 code yet, and on 10-09 he said he's testing his own
     parsers before Devcon.
   - the CDDL says an array step `[1, null]` means "iterate the whole array", but gives no element size.
     Weight 1? We refuse it until he says.
   - a wedgie signs only Safe transactions (its chips can't do Ethereum's usual curve). Does that fit the
     universal signer?
   - what the registry turned up (checked 10-19 against the spec, his GitHub, the registry's issues and
     the Telegram group; none of it is raised anywhere yet):
     - **likely new:** functions with nothing to show (`pause()`) need an empty field list; the CDDL says
       `[+ field]`. We send `[]`.
     - **likely new:** 1inch calldata has extra bytes after the ABI part, so it isn't whole slots. The spec
       doesn't say if that's allowed. We allow it.
     - **he knows, worth a mention:** constants are capped at 32 bytes (Ledger's limit, in the spec), but
       Celo's descriptors use longer fixed sentences. Skipped.
     - **he knows, by design:** `addressName` sources are "vendor specific" uints in the wire format,
       strings in ERC-7730. Ledger has a list (0 local address book, 2 ENS, ...). We send `[]` (any).
   - On 10-17 he said he has to compare the wedgie with Leek, which does something very similar.
2. **Check signatures.** The spec's signatures are secp256k1 or Ed25519. We only have P-256 (`firmware/p256.py`).
   secp256k1 in pure Python is ~2 s per check.
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
