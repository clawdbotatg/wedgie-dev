# Plan: a Safe that signs for a Safe (wedgie.dev/safe)

Goal: on wedgie.dev/safe, when one of a Safe's owners is itself a Safe (an Instant Wallet, or another Safe the
wedgie owns), that owner can sign, and the transaction can run.

Today: wedgie.dev signs only with a wedgie or a browser wallet. A Safe owner shows as a plain address and can't
sign. Instant Wallet can already sign for another 1.5 Safe it owns (instant-wallet `TxPage.tsx`, `signMine`).

## What we know (tested on a Base fork, 10-30)

wedgie.dev's Safes are **1.4.1**. Instant Wallets are **1.5.0**. An off-chain signature from an owner Safe
(ERC-1271, free) works only in some cases:

| Owner Safe | Safe it signs for | Off-chain signature |
|---|---|---|
| 1.5.0 (Instant Wallet) | 1.5.0 | works, over the tx hash |
| 1.4.1 | 1.4.1 | works, over the tx **bytes** (`encodeTransactionData`) |
| 1.4.1 | 1.5.0 | works, over the tx hash |
| 1.5.0 (Instant Wallet) | 1.4.1 (wedgie.dev) | **fails both ways** |

The way that always works, any versions: the owner Safe sends `approveHash(safeTxHash)` to the other Safe, on
chain. Then the signature is `r = owner, s = 0, v = 1` (65 bytes). This costs gas (one tx from the owner Safe).

The wedgie can't sign a SafeMessage (typed data) today, so for a wedgie-owned owner Safe, `approveHash` is the
only path without firmware work. It's a normal Safe tx on the owner Safe: the wedgie already signs those.

**Use `approveHash` everywhere first.** Off-chain signatures are a later step.

## Status (10-30)

Steps 1–4 are built. Next: 5 and 6.

## Found in review (10-30)

- An on-chain approval must carry its v=1 signature, or `readyRun` (Execute all) skips the tx. `addApprovals` does.
- No `approveHash` descriptor exists (clear-descriptors or the EF registry). Step 5 needs one, for 1.4.1 and 1.5.0.
- Instant Wallet's `TxPage.tsx:79` ignores `?h=` when opened inside the app. Test step 6's link there.
- Instant Wallet = a 1.5 Safe with one of Instant Wallet's recovery modules (`RECOVERY_DAYS` in `safe.ts`).

## Steps

1. **eth.ts:** `approveHashData(hash)` (calldata), `approvedHashes(owner, hash)` read (via `/api/rpc`), and the
   v=1 signature. `packSignatures` already takes v=1 heads. `execute` already builds one for a confirmation
   with no signature (`safe.ts` ~1911).
2. **Find owner Safes:** in `load`, read each owner's code. An owner with code that answers `VERSION()` and
   `getOwners()` is a Safe. Keep the list per Safe page, like the owners list.
3. **Show it:** the owner row says "Safe" with its blockie (`face()`). If it's an Instant Wallet (1.5.0 with
   the Instant Wallet setup), say "Instant Wallet". Never "Browser wallet".
4. **Count on-chain approvals:** for each waiting tx and each owner Safe, read `approvedHashes(owner, hash)`.
   If set, add it as a confirmation (v=1) so the dots, `readyRun` and Execute count it.
5. **Sign as an owner Safe the wedgie owns** (Safe A owns Safe B, the wedgie owns A): on B's waiting tx, the
   button "Sign with wedgie (through Safe A)" proposes a tx on A: `B.approveHash(hash)`. That's a normal A tx:
   the wedgie signs it, it goes in A's Waiting. Once A has enough signatures, execute it (browser wallet pays).
   Then step 4 picks it up on B. If A needs only the wedgie, sign and execute in one go.
   - The wedgie must show this clearly: "Approve tx #n on Safe B (0x12…ab)". Check the Safe Signer shows
     `approveHash` in words. If not, add a descriptor in clear-descriptors (see `wire/README.md`), never here.
6. **Sign as an Instant Wallet:** wedgie.dev can't use its passkey (different site). The row gets "Sign in
   Instant Wallet ↗", linking to `https://instantwallet.io/tx/<chain>/<safe>?h=<safeTxHash>` (it finds the tx in
   Safe's queue).
   - **instant-wallet repo, same change:** in `TxPage.tsx` `signMine`, for a Safe that isn't 1.5 (today it
     says "can't sign for it yet"), send `approveHash(hash)` from the wallet through its normal send (relay,
     fee, Touch ID). Show "Approved on chain" when `approvedHashes` is set.
7. **Execute:** unchanged, except approvals from step 4 count.

## Tests

- `tools/safefork.mjs`: add cases. 1.4.1 Safe B owned by Safe A (owned by the fake wedgie): approveHash path,
  then execute B's tx. Also a 1.5.0 owner Safe (Instant Wallet layout) approving a 1.4.1 Safe.
- `tools/safeprobe.mjs`: the owner row, the "through Safe A" button, the count after approval.
- `tools/safechip.mjs`: the wedgie signs A's `approveHash` tx and shows it in words.
- One real run on Base with small amounts: an Instant Wallet as an owner of a wedgie.dev Safe.

## Later

- Off-chain (free) when it works (table above): a 1.4.1 owner Safe signs a SafeMessage. Needs the Safe Signer
  to sign typed SafeMessages (firmware), so the wedgie shows "Sign for Safe B: tx #n" instead of a hash.
