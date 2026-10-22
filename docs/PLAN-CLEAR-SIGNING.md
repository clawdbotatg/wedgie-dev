# Plan: clear signing with ERC-7730 descriptors

**Status 2026-10-22: built and shipped** (Safe Signer safe-24). What was built differs from the plan below in two
ways: it builds on `wire/` (an earlier session's reader and converter, spec v 29.09.26-1), and there's no descriptor
key: every structure carries a Merkle proof (algorithm 4) to roots built into the app. How it works, how to make a
release, and the spec gaps: `wire/README.md`.

Goal: the Safe Signer shows any contract call in plain words without new code per app. It does this by
reading the ERC-7730 descriptors in [ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry).
Adding a protocol should mean adding a descriptor, not an app update.

Why: safe-22 added Uniswap's Universal Router as hand-written code (`safe_ur.py`, 14 KB, 1/6 of the app).
That doesn't scale to 30 more protocols.

Second goal: Austin is helping push the standard (`~/clearsigning-reserach`, GOALS.md). The wedgie should be
a real device that uses the standard's own pieces, as they are, and finds where they break. Each gap we hit
goes back to the working group.

## What's there (checked 2026-10-21)

- **Descriptors:** 531 (calldata + EIP-712) across 66 projects: Aave, 1inch, Lido, Morpho, Circle, Uniswap, ...
- **Attestations:** 170 are attested in `sigs/`. All by Cyfrin (Patrick Collins,
  `0x3846c3A30E62075Fa916216b35EF04B8F53931f6`), as ERC-8176 offchain EAS attestations (secp256k1, EIP-712).
  The registry's README says a wallet should trust a descriptor only if an auditor it chose has signed it.
- **Tests:** each descriptor comes with fixtures (`tests/`, `testsv2/`): a raw tx plus the expected fields.
  That's a test suite we don't have to write.
- **Uniswap:** only `UniswapV3Router02` and Permit2. Nothing for the Universal Router. Plain 7730 can't follow
  a command plan. **ERC-8362 custom encoding** (Alex Forshtat, ERCs #1925) can: its examples include Safe
  MultiSend and the Universal Router. WG order (10/21): custom encoding is the next spec change.
- **Wire format:** Bacca's draft (`ZKNoxHQ/eth-universal-signer/specs/7730_wire_format.md`; a copy is in
  `~/clearsigning-reserach/wire-format/spec/`). It's CBOR inside an ERC-4527 `eth-sign-request`. Every struct is
  signed by a root the device holds. The host compiles each 7730 path into slot moves, so the device needs no ABI.
- **Austin's toy (9/23)**, `~/clearsigning-reserach/wire-format/`: `wire_encode.py` turns registry JSON into
  that CBOR. `wire_decode.py` (11 KB) + `cbor.py` (4 KB) walk the paths, check P-256 signatures and render. It
  ran on the picowallet emulator: a USDS transfer is 560 bytes; a batch of two is 1343 bytes and decodes in 62 ms.
  Primer and the 12 spec gaps it found: `docs/27-wire-format-primer.md`.
- **Bacca's answers to the wedgie's questions (10/21):** zero fields: allow. Extra calldata bytes: OK only if
  they don't change the intent. Signed internet data: fine through a signing oracle. He wants the decoding in
  `ethereum-app/common-eth-signer`.

## How it works

Use the wire format, not a format of our own. The wedgie becomes a second implementation of Bacca's draft.

```
wedgie.dev/safe (untrusted courier)               wedgie
-----------------------------------               ------
find the descriptor for (chain, to, selector)
check its Cyfrin EAS attestation
encode it as wire format: transaction-info for
  that one function + token-information
  (wire_encode.py, ported to TS)
sign each struct with the descriptor key      -->  check each signature against the built-in root (P-256)
send it with safe_sign                             walk the slot paths over the Safe tx's data, show fields
                                                   no struct, bad sig, unknown param: red, as today
```

### 1. The trust: a descriptor key (our root)

- A new P-256 key, separate from the firmware key and less protected. It can sign from a server.
- The wedgie has its public key built in, as the wire format's "root of trust". The spec lets a device take
  more roots, which is the multi-attester demo for goal 1.
- What it signs is up to us:
  - **Start:** only descriptors Cyfrin attested (170). The host checks the EAS signature first.
  - **Later:** descriptors we've reviewed, and other auditors as they show up.
  - **When ERC-8283 is live:** read attestations from the on-chain registry instead of the git repo.
- P-256 because the wedgie can already check it (`p256.verify` in firmware, `optiga.verify` on a Trust M).
  secp256k1 (Cyfrin's signature) would mean new curve code on the wedgie, so the host checks that one.
- **What the wire format leaves open:** which hash, curve and bytes a signature covers (toy: sha256 over the
  elements' CBOR, P-256, `r‖s`). We pick, write down what we picked, and send it to Bacca.

### 2. The payload (host → wedgie)

- Wire-format structs: `transaction-info` (one function: intent, owner, fields with compiled slot paths) and
  `token-information` (decimals, plus a ticker: the spec has none, gap 4). Each one is signed.
- It's keyed by (chain id, contract, selector), so it can't be reused on another contract.
- Size: about 200–600 bytes per call (toy numbers). It rides with `safe_sign`, inside the 8 KB data budget.
- No ERC-4527 envelope for now: the wedgie signs Safe txs (EIP-712 SafeTx), not raw txs, over its own USB
  JSON. The structs are the same; only the envelope differs. A 4527 path can come later.

### 3. The reader (on the wedgie)

- New file `safe_7730.py`, loaded only when structs come with the tx (same pattern as `safe_ur.py`). Start from
  the toy's `wire_decode.py` + `cbor.py`.
- It walks slot paths (TUPLE, REF, ARRAY, LEAF, SLICE) over the Safe tx's `data`. It doesn't need the ABI.
- **Params, first pass:** raw, amount, token amount, datetime, duration, unit, enum, trusted name (full address
  + blockie; "this Safe" when it is).
- **Later:** calldata (a call inside a call), nft, group (arrays).
- Anything it doesn't know (a param type, a path that runs off the data) shows that field red. It never
  skips a field silently. Hidden fields stay hidden, as the spec says.
- Same page rules as today: few words, amounts big, every address in full with its blockie, a big red line
  makes a red title.

### 4. What stays as code

- Safe's own calls (owners, threshold, modules), the daily limit (Zodiac Roles) and the recovery modules.
  They're checked against this Safe's own addresses, which a descriptor can't do.
- MultiSend and the Universal Router (`safe_ur.py`), until ERC-8362 custom encoding is in the wire format.
  Then try them as descriptors and compare against the code we have now. `safe_ur.py` is a ready-made test.
- Plain ETH and ERC-20 sends and approvals. `ercs/calldata-erc20-tokens.json` could replace them later.

## Memory

RAM is the limit, not flash. The wedgie compiles each `.py` when it loads it, and safe-22's decoder didn't fit
in one file with `safe_read.py`. So:

- `safe_7730.py` is its own file, loaded on demand and dropped after.
- The structs count against the 8 KB tx-data budget. Check that they plus a big tx still fit
  (`tools/safechip.mjs`).
- If the reader gets big, ship it as `.mpy`. Precompiled, it needs no RAM to compile.
- P-256 checks in pure Python take seconds on an RP2040. With a Trust M, use `optiga.verify`. Measure both.

## Steps

1. **Encoder on the host:** port `wire_encode.py` to TS in wedgie.dev/safe. Fetch the registry (pinned commit),
   index by (chain, address, selector), check Cyfrin's EAS attestations. Test: every registry fixture encodes.
2. **Decoder on desktop:** `safe_7730.py` from the toy, run under CPython against every `tests`/`testsv2`
   fixture. Its fields should match `expected`. Log every format or path that fails: that's spec feedback.
3. **Descriptor key:** make it, build its public key into the app, sign structs on the host. Decide where it lives.
4. **Wire it up:** `safe_sign` takes an optional `"clear"` field (hex CBOR). `safe_read.describe` uses it for any
   call it doesn't already read itself.
5. **Virtual RP2040:** `safechip.mjs` signs an Aave repay and a 1inch swap from the fixtures. Check heap and time.
6. **Ship:** wedgie-safe safe-23, then the wedgie-dev re-pin.
7. **Report back:** the gaps we hit, written up for Bacca and the WG.

## Open questions

- Where does the descriptor key live: a server (signs on request), a laptop (signs the whole registry once per
  commit), or a hardware key?
- Pre-sign the whole registry per commit (simple, works offline), or sign per tx (fresher token info)?
- Do descriptors with no auditor signature show in yellow ("unaudited"), or not at all?
- EIP-712 descriptors (messages, not txs): skip them. The wedgie signs only Safe txs, and the wire format hasn't
  designed 712 yet (gap 5).
- Where token info comes from: the registry's token files, a token list, or on-chain reads by the host.
- Should our decoder live in Bacca's `ethereum-app/common-eth-signer` instead, so other devices can use it?
