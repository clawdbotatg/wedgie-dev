# Plan: 🤖 checked descriptors on the wedgie

Status 2026-10-24: plan only. The review and signing live in
[clawdbotatg/clear-review](https://github.com/clawdbotatg/clear-review). This is the wedgie side.

## Today

`wire/release.py` builds `public/clear/<tag>/` from the registry. Two Merkle roots, built into Safe Signer
(`safe_roots.py`): **a** = Cyfrin-audited, **b** = the rest. New data = new app.

## Add

1. **Build.** `release.py` reads clear-review's latest round. Each passed descriptor gets a proof to its root
   (root **c**). The signed round goes in `public/clear/<tag>/review.json`.
2. **Page.** `src/safe/clear.ts` sends the round with the bundle.
3. **Safe Signer.** Pin clear-review's public key. First tx: check the round's signature once (bar while it
   runs), keep root c and the round number (refuse a lower one). Then proofs as for a and b.
   Check whether apps can use the Trust M's hardware verify; if not, pure-Python P-256 (~2.2 s) once.
4. **Screen.** audited / 🤖 checked / not checked (red, as today). Never refuse (warn, don't block).
5. **Tests.** `test_clear.py` covers root c; a tampered round or an older round is refused;
   `safechip.mjs` signs one 🤖 tx; then a real board.

Root c isn't built into the app, so new rounds ship without an app update.
