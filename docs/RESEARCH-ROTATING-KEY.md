# Research: a Safe signer that changes its chip key every transaction

Status 2026-10-07. Research only. Nothing here is built yet.

## Credit

The idea comes from Nick Dodson ([@IAmNickDodson](https://x.com/IAmNickDodson)):
[his tweet](https://x.com/iamnickdodson/status/2107988457297514883) and his proof of concept,
[SilentCicero/bunker-wallet](https://github.com/SilentCicero/bunker-wallet). He wrote it in reply to
Justin Drake's ["bunker mode"](https://x.com/drakefjustin) post: move funds to addresses whose public
keys have never been shown.

Nick's version: a Safe whose owner is a plain EOA from a seed phrase. Each transaction does its action,
funds the next EOA from the seed, and swaps the owner to that EOA. This doc does the same thing with
the key in a wedgie's Trust M chip.

## The problem it solves

- An address is a hash of a public key. Nobody sees the public key until that key signs.
- A quantum computer could work out a private key from its public key (P-256 and secp256k1 both).
- So every key that has ever signed is a future risk, and today's wedgie key signs again and again.

## What it doesn't solve

- **It's still ECDSA (P-256).** Every signature can be cracked by a strong enough quantum computer.
- **There's a short window.** While a transaction is pending, its signature and public key are public.
  An attacker who can crack the key in that time can send a competing transaction.
- So this isn't post-quantum. It means each key is used once, and an exposed key controls nothing
  after its transaction lands. It's Bitcoin's "don't reuse addresses" rule, run by a Safe.

## How it works today (wedgie-safe)

- The chip makes a P-256 key in `KEY2`. The key never leaves the chip.
- Safe's passkey factory (`SafeWebAuthnSignerFactory`, safe-modules passkey v0.2.1) makes a small
  signer contract from `(x, y)`. That contract is an owner of the Safe.
- The wedgie signs the Safe tx hash (wrapped as a WebAuthn message), after an A press.

## How rotation would work

Every Safe transaction the wedgie signs becomes a batch (MultiSend, delegatecall):

1. The action the user wanted.
2. `swapOwner(prev, signerAddr(A), signerAddr(B))`. A is the key signing now. B is a new key.

`signerAddr(B)` is the factory's CREATE2 address for B's `(x, y)`. It's a hash, so it doesn't reveal B.
B's signer contract is **not** deployed yet: its code would hold `(x, y)` in public.

When B signs later, one transaction (Multicall3, as /safe already does) does both:

1. `factory.createSigner(xB, yB, verifiers)`: deploy B's signer contract (anyone can, same address).
2. `safe.execTransaction(...)`, signed by B, whose batch swaps B for C.

B's public key appears on chain only in the transaction where B signs. That's as good as Nick's EOAs.

The order of keys over time:

| Transaction | Signed by | Owner after | Public keys on chain |
|---|---|---|---|
| setup | the user's wallet | A | A (old, already exposed) |
| 1 | A | B (address only) | A |
| 2 | B | C (address only) | A, B |
| 3 | C | D (address only) | A, B, C |

The owner is always a key whose public key nobody has seen.

## The chip side: two slots

The Trust M has three spare ECC slots (`KEY2`, `KEY3`, `KEY4`). Two take turns:

- The owner key sits in one slot. The other slot is free.
- To sign: `genkey` into the free slot (B, 157 ms), sign with the owner slot (A, 140 ms).
- After the transaction lands, A's slot is free. The next `genkey` writes over A, so A is gone.
- **Never `genkey` into the slot of the key that owns the Safe now.** If a transaction never lands,
  A still owns it and B is just thrown away next time. The wedgie checks the chain owner before it
  overwrites a slot (the host tells it, and it checks the address itself from the slot's public key).

`/saves/safe/` keeps both slots' public keys and which one owns the Safe. The chip keeps the keys.
A `genkey` destroys the old key with no undo (`trustm.md`). That's what we want here.

## What the wedgie checks before it signs

The swap must not be something the host made up. The wedgie:

- builds the swap itself: it computes `signerAddr(B)` from B's public key (keccak in
  `safe_keccak.py`, the factory address and the init code hash as constants);
- checks the batch has the swap with A out and that exact B in;
- shows the action as it does now, plus one line: "new key after this".

A host that changes B to its own address makes a batch the wedgie won't sign.

## Gas

Nick's version sends ETH to each new EOA so it can pay gas. We don't need that: the signer contracts
never pay gas. Whoever sends the transaction pays (the site's browser wallet, or a relayer). That
wallet's own key gets exposed, but it only holds gas money.

## Backup

Keys can't leave the chip. If the wedgie breaks, its keys are gone. Options:

1. **A cold backup owner** (recommended to start). A seed-phrase EOA, written down, never used. It has
   never signed, so its public key is hidden too. Safe threshold 1 of 2. Weak spot: anyone with the
   phrase can move funds alone.
2. **A second wedgie** that rotates the same way, as a 2 of 2 or 1 of 2 owner.
3. **A recovery module with a delay** (the backup can only take over after, say, 7 days, and the
   wedgie can cancel). Safer, more contract work.

## Making the window smaller

- Send through a private mempool (Flashbots Protect on Ethereum; on Base, Optimism and Arbitrum the
  sequencer's mempool isn't public). The key is then public only after the block lands, and by
  then it's already rotated out.
- Same-nonce attack: someone who cracks A in time signs their own swap with the same Safe nonce. A
  private mempool is the main defense. A guard that delays owner changes not made by the rotation
  would be the next one.

## The plan

1. **Fork test** (`tools/safefork.mjs` style, Base fork): a Safe with a P-256 owner. Run three
   transactions that each swap to an undeployed signer address, deploying it in the same Multicall3
   transaction as its first use. Check the owner, that no public key is on chain before its key signs,
   and gas per transaction.
2. **wedgie-safe app**: two-slot state in `/saves/safe/`, `genkey` before each signature, build and
   check the swap on the wedgie, the "new key after this" line. A new USB field for the next key's
   `(x, y)`, so the host can deploy its signer when it's used.
3. **/safe on the site**: wrap each transaction in the batch, Multicall3 deploy + exec, read the
   current owner from the Safe, a "turn on rotation" switch for an existing Safe.
4. **Backup**: add the cold backup owner flow (option 1). Later the delay module.
5. **Real board**: run it on a real wedgie on Base with a few dollars. Measure the time per signature
   (about 0.3 s more for `genkey`) and check the security event counter stays low.
6. **Private send**: send through a private RPC by default.

## Open questions

- Does Safe's `checkSignatures` accept a contract owner that's deployed earlier in the same
  transaction? (It should: the Multicall3 call runs `createSigner` first. The fork test proves it.)
- Does the batch read clearly on the wedgie's small screen?
- Chip flash wear: one `genkey` per transaction. The ~2 million writes limit is far away.
- Does it work with a Safe that has other owners and a threshold above 1? Each wedgie rotates only
  its own owner slot, so it should, but the queue has to handle a swap signed by several owners.
- Should the setup key (A) be a fresh key that has never signed?

## Sources

- Nick Dodson's tweet: https://x.com/iamnickdodson/status/2107988457297514883
- bunker-wallet: https://github.com/SilentCicero/bunker-wallet
- wedgie-safe app: https://github.com/clawdbotatg/wedgie-safe
- Trust M on a wedgie: `public/trustm.md`
- Safe passkey signer: https://github.com/safe-global/safe-modules (modules/passkey)
