# Plan: 🤖 checked descriptors on the wedgie

Status 2026-10-24: plan only. The review and signing live in
[clawdbotatg/clear-review](https://github.com/clawdbotatg/clear-review). This is the wedgie side.

## Today

`wire/release.py` builds `public/clear/<tag>/` from the registry. Two Merkle roots, built into Safe Signer
(`safe_roots.py`): **a** = Cyfrin-audited, **b** = the rest. New data = new app.

## Add

1. **Build.** `release.py` reads clear-review's latest round and its adds (`adds/<round>-<k>.json`). Each passed
   descriptor gets a proof to its root (root **c**, or an add's root). The signed round and adds go in
   `public/clear/<tag>/review.json`. Formats and rules: clear-review
   [`docs/SIGNING.md`](https://github.com/clawdbotatg/clear-review/blob/main/docs/SIGNING.md).
2. **Page.** `src/safe/clear.ts` sends the round with the bundle.
3. **Safe Signer.** Pin clear-review's public key. Check each signature once (bar while it runs) and save it:
   - round: keep root c and the round number; refuse a lower one.
   - add: take it only if its round equals the saved round, keep its root. A newer round drops all adds.
   - then proofs as for a and b: hashes only.
   Verify with `optiga.verify` on a Trust M (hardware, ms), else pure-Python `p256.verify` (~2.2 s), once.
   Time both: clear-review `tools/timeprobe.py` (read only).
4. **Screen.** audited / 🤖 checked / not checked (red, as today). Never refuse (warn, don't block).
5. **Tests.** `test_clear.py` covers root c; a tampered round or an older round is refused;
   `safechip.mjs` signs one 🤖 tx; then a real board.

Root c and adds aren't built into the app. After the one update that pins the key, new descriptors ship
with just a signature: a new round, or an add for a few between rounds.
