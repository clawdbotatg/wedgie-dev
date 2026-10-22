# Plan: clear signing with ERC-7730 descriptors

Goal: the Safe Signer shows any contract call in plain words without new code per app. It does this by
reading the ERC-7730 descriptors in [ethereum/clear-signing-erc7730-registry](https://github.com/ethereum/clear-signing-erc7730-registry).
Adding a protocol should mean adding a descriptor, not an app update.

Why: safe-22 added Uniswap's Universal Router as hand-written code (`safe_ur.py`, 14 KB, 1/6 of the app).
That doesn't scale to 30 more protocols.

## What's there (checked 2026-10-21)

- 531 descriptors (calldata + EIP-712) across 66 projects: Aave, 1inch, Lido, Morpho, Circle, Uniswap, ...
- 170 have an auditor attestation in `sigs/`. All are by Cyfrin (Patrick Collins,
  `0x3846c3A30E62075Fa916216b35EF04B8F53931f6`), as offchain EAS attestations (secp256k1, EIP-712).
- The registry's README says a wallet should trust a descriptor only if an auditor it chose has signed it.
  Otherwise the wallet falls back to "can't read".
- Uniswap has only `UniswapV3Router02` and Permit2. There's none for the Universal Router, and there can't be
  one: ERC-7730 can't follow money through a command plan. `safe_ur.py` stays.
- Each descriptor comes with test fixtures (`tests/`, `testsv2/`): a raw tx plus the expected fields. These
  are our test suite for free.

## How it works

```
wedgie.dev/safe                                   wedgie
---------------                                   ------
find the descriptor for (chain, to, selector)
check its Cyfrin EAS signature (if we require it)
trim it to that one function, resolve $refs,
  add token info (symbol, decimals) it needs
sign the trimmed blob with the descriptor key  -->  check the signature (P-256)
send it with safe_sign                             decode the calldata with it, show the fields
                                                   no blob, bad sig, unknown format: red, as today
```

### 1. The trust: a descriptor key

- A new P-256 key, separate from the firmware key. It's less protected, so it can sign often and from a
  server. The firmware key stays for firmware.
- The wedgie has its public key built in. Changing the key needs an app update.
- What it signs: chain id + contract address + selector + the trimmed blob + an expiry. A blob for one
  contract can't be reused on another.
- What it signs is up to us:
  - **Start:** only descriptors Cyfrin attested (170). The host checks the EAS signature before signing.
  - **Later:** descriptors we've reviewed ourselves, and other auditors as they show up.
  - **When ERC-8283 is live:** read attestations from the on-chain registry instead of the git repo.
- P-256 because the wedgie can already check it (`p256.verify` in firmware, `optiga.verify` on a
  Trust M). secp256k1 (Cyfrin's signature) would mean new curve code on the wedgie, so the host checks
  that one.

### 2. The blob (host → wedgie)

- Just the one function's format: intent, fields (path, label, format, params). It drops `metadata` and
  any unused formats and fills in `$ref`s.
- Token info for every `tokenPath` the fields use: symbol and decimals. The descriptor key signs it, so a
  host can't call a scam token "USDC".
- Target size: under 1 KB. Measure this in step 1.
- Plain JSON with short keys should be enough. Measure what `json.loads` costs on the RP2040 in step 5.

### 3. The reader (on the wedgie)

- New file `safe_7730.py`, loaded only when a blob comes with the tx. Same pattern as `safe_ur.py`.
- **ABI decoding by path:** static types, `address`, `uint`/`int`, `bool`, `bytes`, `bytes32`, dynamic
  arrays, tuples, nested paths (`params.amountIn`, `path.[-1]`).
- **Formats, first pass:** `raw`, `amount` (the chain's coin), `tokenAmount` (with `threshold` → "All"),
  `addressName` (full address + blockie; "this Safe" when it is), `date`, `duration`, `enum`, `unit`.
- **Later:** `calldata` (a call inside a call, such as multicall or Safe's own `execTransaction`) and
  `nftName`.
- **Anything it doesn't know** (a format, a path it can't follow, a type): that field shows red "can't read
  it". It never skips a field silently.
- `visible: "never"` fields stay hidden, as the spec says. A field with a value it can't read is always shown.
- Same page rules as today: few words, amounts big, every address in full with its blockie, at most one page
  per action, a big red line makes a red title.

### 4. What stays as code

- Safe's own calls: owners, threshold, modules.
- The daily limit (Zodiac Roles) and the recovery modules: Instant Wallet's own setup, checked against this
  Safe's addresses.
- MultiSend batches: the wedgie reads each action. Each action can bring its own blob.
- Uniswap's Universal Router (`safe_ur.py`).
- Plain ETH and ERC-20 sends and approvals. The registry's `ercs/calldata-erc20-tokens.json` could replace
  these later.

## Memory

RAM is the limit, not flash. The wedgie compiles each `.py` when it loads it, and the decoder plus the
reader in one file didn't fit (see safe-22). So:

- `safe_7730.py` is its own file, loaded on demand and dropped after.
- The blob counts against the same 8 KB tx-data budget. Check that a 1 KB blob plus an 8 KB tx still fits
  (`tools/safechip.mjs`).
- If the reader gets big, ship it as `.mpy`. Precompiled, it needs no RAM to compile.

## Steps

1. **Host-side resolver** (wedgie.dev/safe): fetch the registry (pinned commit), index by
   (chain, address, selector), check Cyfrin's EAS sigs, and trim. Test: every registry fixture yields a blob.
2. **Reader on desktop:** `safe_7730.py` run under CPython against every `tests`/`testsv2` fixture. Its
   fields should match `expected`. Count which formats fail.
3. **Descriptor key:** make it, build its public key into the app, and have the host sign blobs. Decide
   where it lives (see open questions).
4. **Wire it up:** `safe_sign` takes an optional `"clear"` field. `safe_read.describe` uses it for any call
   it doesn't already read itself.
5. **Virtual RP2040:** `safechip.mjs` signs an Aave repay and a 1inch swap from the fixtures. Check the heap.
6. **Ship:** wedgie-safe safe-23, then the wedgie-dev re-pin.

## Open questions

- Where the descriptor key lives: a server (auto-signs on request), a laptop (batch-signs the whole
  registry once per commit), or a hardware key.
- Pre-sign the whole registry once per registry commit (simple, works offline), or sign per tx (fresher
  token info)?
- Do we show descriptors with no auditor signature in yellow ("unaudited"), or not at all?
- EIP-712 descriptors: these are for messages, not txs. The wedgie signs only Safe txs today. Skip them for now.
- Where token info comes from: the registry's own token files, a token list, or on-chain reads by the host
  (signed with the blob).
