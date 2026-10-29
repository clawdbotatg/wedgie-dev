# wire: clear signing groundwork

`wire.py` reads the **ERC-7730 wire format**: the small signed messages that tell a hardware wallet what a
transaction does ("Swap 1 ETH for 2,400 USDC"), so it can show that instead of raw bytes.

The format is Nicolas Bacca's (btchip), part of his **universal signer**. Spec:
https://github.com/ZKNoxHQ/eth-universal-signer/blob/7730-wire-format-implementations/specs/7730_wire_format.md
(v 29.09.26-1). His code is Rust (`ethereum/ethereum-app`); a wedgie runs MicroPython, so this is our own.

## Status

What shipped and what a human must still see on a real wedgie: `docs/CLEAR-SIGNING-CHECK.md`.


- **Used by Safe Signer safe-24** (clawdbotatg/wedgie-safe): `safe_wire.py` is a copy of `wire.py` (keep them the
  same), `safe_7730.py` turns a descriptor into the screen. On the shelf since 10-22 (firmware 0.3.58).
  Uniswap's Universal Router is read from our ERC-8362 descriptor since safe-30 (`safe_ur.py` is gone).
- **ERC-8362 draft** (customEncoding, sequence, object, switch, mask, `$index`, calldata `operation`): compiled by
  `from7730.py` into our own wire binding (params 13 and 14, value source 3, written down there), read by
  `safe_8362.py` (safe-30+). Not yet: `interaction`, `$fallback`, `@.data`, display fields that address an entry.
- **Our descriptors** ([clawdbotatg/clear-descriptors](https://github.com/clawdbotatg/clear-descriptors), a checkout beside this repo or `$CLEAR_DESCRIPTORS`; the files its `show.json` adds): on top of the registry, root a. First: Uniswap's Universal Router.
- **The data** wedgie.dev serves: `release.py` builds `public/clear/<tag>/` from the registry, ours and token lists
  (Uniswap's, then CoinGecko's top 1,000 coins, minus any ticker another address has on that chain; safe-30: tag
  f4f3fe64, registry 171b6b5), every structure with a Merkle proof (algorithm 4) to two roots built into the app (`safe_roots.py`). See below.
- **Tests:** `tools/test_clear.py` runs the app's reader on the registry's own test transactions (1,510 on chains
  the app does: 1,367 show exactly what the registry expects, 125 differ on purpose, 18 explained in the test);
  `tools/safechip.mjs` signs four of them on a virtual RP2040.

## See a dapp's screens

Every page of a registry test file's real transactions, on a virtual RP2040. No assets, no fork: a wedgie signs
what it's sent and never executes it. For data newer than our release, make a test release first (nothing ships):

```
python3 tools/clear_txs.py /tmp/reg/registry/uniswap/testsv2/calldata-UniswapV2Router02.tests.json > /tmp/v2.json
cp -r ../wedgie-safe /tmp/app && uv run ... python3 wire/release.py /tmp/reg /tmp/clear /tmp/app/safe_roots.py
node tools/safechip.mjs --app /tmp/app --clear /tmp/clear --txs /tmp/v2.json --shots /tmp/v2   # <case>-<page>.png
```

Put them on wedgie.dev/clear: `python3 tools/clear_page.py uniswap-v2 "Uniswap V2" /tmp/v2.json /tmp/v2 "<note>"`.

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

## Standard only (Austin, 10-27: "we should not be inventing anything")

Our descriptors use ERC-7730 v2 and the ERC-8362 draft (ethereum/ERCs#1925, Alex Forshtat's, not ours) as written.
Where they can't say something, the screen says less, and the gap goes to the registry as an issue.

- **Uniswap v4's 0** (`OPEN_DELTA`: "all of it"). A real wedgie said "Take out: 0 USDC" (10-27). ERC-7730 has no
  words for one exact value, so the amount is hidden at 0 (`visible: {"ifNotIn": ["0"]}`) and the intent says it:
  TAKE is "Take out what the swap gives", SETTLE "Pay in what the swap costs"; a swap's 0 in or out is just left
  out. Approve 0 still reads "0 USDC". (safe-38 had our own `params.specialValues`; gone.)
- **A one-pool swap's tokens** (`currency1` if `zeroForOne`, else `currency0`): an ERC-8362 `switch` on
  `p.zeroForOne` whose cases are `{"format": "tokenAmount", "params": {...}}`. That case shape is in ERC-8362's
  schema (`switchCaseValue`, since 08-07), though its text only shows `customEncoding` cases. Wire: case
  `[2, param]`, param's value null (the switch's). `visible` on such a field is read on the switch's own value.
  `MAX_DEPTH` is 28 (was 24): a switch on a flag inside a v4 action inside a command.
- **Still ours, to ask about:** `tokenTicker` with `nativeCurrencyAddress` (the spec gives that param to
  `tokenAmount` only; v4 names ETH as 0x0), and `senderAddress: "@.from"` (LI.FI, below).

**`senderAddress: "@.from"`** (`addressName`, LI.FI). ERC-7730 lists stand-in addresses only (Uniswap's 0x..01).
LI.FI has none: its `_receiver` is just who gets paid, and should be the Safe. With `"@.from"` the wallet shows
"this Safe" when it is, and red "not this Safe!" when it isn't. Wire: an empty byte string in the senderAddress list
(it matches no address). In clear-descriptors `registry/lifi/calldata-LIFIDiamond-swaps.json`.

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

Done: test messages from the real registry (`from7730.py`); showing it in Safe Signer (safe-24, 10-22); trust
through Merkle roots built into the app (algorithm 4) instead of checking signatures.

1. **Bacca's answers** (Telegram DM, 10-20):
   - **Empty field list** (`pause()`): signers should accept it; `[+ field]` should allow empty. We send `[]`.
   - **Extra bytes after the ABI part** (1inch): fine if a neutral tracker or note (the descriptor should
     ideally flag it), not fine if it changes the tx (then the descriptor needs fixing). A signer can't tell
     which, so `path()` still reads and `extra_bytes()` says how many: not 0 = warn on screen, A still signs.
     A trailer of whole slots can't be seen (the wire format has no parameter types).
   - **Signed data from the internet** (the price demo): "absolutely not a non starter". Commercial wallets
     use a server that signs it. A middle step: the device runs the TLS connection, the host only passes bytes.
     Built (10-25): clear-sim (github.com/clawdbotatg/clear-sim, live at sim.wedgie.dev) runs a tx and signs what
     moves in and out of the sender (tokens named, in dollars). Not TLS: the RP2040 MicroPython build has none.
     Plan: `docs/PLAN-SIMULATE.md`.
   - **His code:** decoding and screen text will live in `ethereum/ethereum-app/common-eth-signer` (Rust).
     He suggested it "if that's not redundant"; he hadn't read ours. A wedgie can't run Rust.
   - **Asked 10-20, waiting:** would he add P-256 as an allowed signature type? It's all a wedgie can check
     fast (step 2).
   - Not asked, low value: his example messages (none published; we have 8,774 of our own), the `[1, null]`
     array step (we refuse it), Safe-only signing.
   - On 10-17 he said he has to compare the wedgie with Leek, which does something very similar.
2. **Signatures (if roots aren't enough).** The spec's are secp256k1 or Ed25519; a wedgie checks P-256 fast. Asked
   Bacca to allow P-256 (10-20).
3. **Trusted sources.** Which keys the wedgie accepts and how many must agree, changed only with an A press.
   Local mode: only your own node, and the screen says "local mode". Same plan as the signed price demo
   (`api/price.ts`, `clawdbotatg/wedgie-price`).
4. **Fresh answers.** Messages carry a date, but a wedgie has no clock. Use our nonce (as the price demo does,
   and as Ledger does for proxies) so an old answer can't be replayed.
5. **Proxies.** Use `proxy-information` to match an upgradeable contract's current code, and warn if it changed.
6. **Unreadable calls.** A big red page; A still signs (never refuse). Never show half.
7. **Speed and size.** Ship it compiled (`.mpy`), measure on a real wedgie.
8. **Watch the spec.** EIP-712 isn't in it yet.
