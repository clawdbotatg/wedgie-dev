# Plan: 🤖 robot review of clear-signing descriptors

Status 2026-10-24: plan only.

Goal: we sync the whole ERC-7730 registry (as today), a model reviews descriptors one by one, and the ones it
passes get signed by our own key. The wedgie shows those as "🤖 checked", between "audited" and "not audited".

## Today (for reference)

- `wire/release.py` builds `public/clear/<tag>/` from the registry. Two Merkle roots, built into Safe Signer
  (`safe_roots.py`): **a** = Cyfrin-audited, **b** = the rest.
- No signatures on descriptors. Trust = the signed app carries the roots. New data = new app.

## The idea: sign a root, not each descriptor

A signature per descriptor costs ~2.2 s each on the wedgie (pure-Python P-256, `firmware/wedgie.py`).
So we sign **one root per review round** instead:

1. All passed descriptors go in a third tree, root **c**.
2. Our review key signs `(c, tag, round number)`. One signature.
3. The page sends the signed root + each descriptor's Merkle proof, same as a and b today.
4. The wedgie checks the signature once, keeps root c, then checks proofs (hashes only, fast).

Bonus: root c is **not** built into the app, so new reviews ship without an app update.
Round number only goes up, so an old round can't be replayed.

This sits beside the wire format, not in it (the spec doesn't allow P-256 yet), so the spec path stays clean.

## Steps

1. **Review key.** New P-256 key, only for this. Not a release key. Held in the Mac's Secure Enclave
   (`tools/sekey.swift`): one Touch ID per round. Public half pinned in Safe Signer.
2. **Review tool** (`tools/review.py`). Per descriptor:
   - inputs: the descriptor (merged `includes`), the contract's verified source and ABI (Sourcify), the
     registry's test txs, and what the wedgie actually shows for them (`test_clear.py`'s reader).
   - asks: do the labels match what the code does? Is anything that moves money hidden or mislabeled?
     Wrong token, amount or recipient path?
   - output: `review/<descriptor hash>.json` (pass/fail + reasons), committed, public.
   - keyed by hash: a descriptor that changes in the registry is unreviewed again automatically.
3. **Build.** `release.py` adds tree c from the passes. `tools/review_sign` signs the root →
   `public/clear/<tag>/review.json`.
4. **Wedgie (Safe Signer).** Pinned review key. First tx: check the signature (bar while it runs), keep root c.
   Then a, b, c proofs as today. Check whether apps can use the Trust M's hardware verify (fast); if not, the
   2.2 s pure-Python check runs once.
5. **Screen.** Three marks: audited (Cyfrin) / 🤖 checked / not checked (red, as today). Never refuse
   (warn, don't block).
6. **Tests.** `test_clear.py` covers root c; a tampered root or old round is refused; `safechip.mjs` signs one
   🤖 tx; then a real board.
7. **Give back.** Failures with reasons become registry issues or PRs.

## Open questions for Austin

- Review everything in b (~6,000 deployments, ~530 files), or start with the busiest contracts?
- Also review Cyfrin's set (a second opinion), or skip it?
- Which model, and is one pass enough, or two that must agree?
