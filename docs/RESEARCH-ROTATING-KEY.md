# Research: a Safe signer that changes its chip key every transaction

Status 2026-10-08. Research only. Nothing here is built yet. Two parts: P-256 key rotation (a stopgap),
then hash signatures (the quantum-safe fix).

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

## The real fix: hash signatures (quantum-safe)

Everything above still uses P-256, so it only narrows the window. To close it, drop P-256 for Safe
signing and use hash-based one-time signatures. A quantum computer can't break a hash. P-256 stays
for things like games proving someone holds the hardware.

### How a hash signature works

**Lamport, the simplest one.**

- Make 512 random secrets, two for each bit of the 256-bit message hash.
- The public key is the hash of each secret.
- To sign, for each bit reveal the first secret if the bit is 0, the second if it's 1.
- To check, hash each revealed secret and compare it with the public key.
- Forging means finding a secret from its hash, which is impossible, even for a quantum computer.
- **Use a key once.** A second signature reveals the other half of some pairs.

**WOTS (Winternitz), the one to use.** Same idea, smaller.

- Split the message hash into 64 digits of 4 bits (0-15), plus 3 checksum digits: 67 in all.
- Each digit gets a secret, hashed 15 times in a row (a chain). The chain's end is public.
- To sign digit `d`, reveal the secret after `d` hashes.
- To check, hash it `15 - d` more times. It must land on the chain's end.
- The checksum stops a forger from hashing a revealed value forward to raise a digit.
- A signature is 67 x 32 bytes, about 2.1 KB. Checking costs about 500 hashes, cheap in a contract.
- One-time, like Lamport.

### On a wedgie with a Trust M (works on V1)

1. **Seed.** The chip makes a random seed and keeps it in a data slot set to "pre-shared secret"
   with read rule "never" (one permanent metadata write on that one slot). Nothing can read it.
2. **One key per number.** For key number `n`, the chip runs `derive(seed, "wots" + n)` (TLS PRF,
   V1 and V3). Out come 32 bytes. The RP2040 expands them into the 67 chain secrets with SHA-256.
3. **Never reuse a number.** `n` comes from one of the chip's counters that only go up. A key
   number is spent before it signs, even if the power goes out.
4. **Public key.** The RP2040 hashes each chain to its end and hashes the 67 ends into one 32-byte
   value, `pk(n)`.

### On chain: the signer contract

The Safe owner is a small contract that stores one value: the hash of the next public key.

- **Setup.** The wedgie gives `pk(0)`. The contract stores it.
- **Sign.** The wedgie signs `safeTxHash + pk(n+1)` with key `n`. That's what makes it rotate.
- **Check** (`isValidSignature`, Safe's contract signatures). The contract rebuilds the 67 chain ends
  from the signature, hashes them, and checks the result equals the stored `pk(n)`.
- **Rotate.** `isValidSignature` can't write. So the Safe batch ends with `signer.advance(pk(n+1))`,
  callable only by the Safe, and only for the `pk(n+1)` that was signed. Key `n` is then dead.
- Simpler, but only for a Safe this wedgie runs alone: make the contract a Safe module instead. It
  checks the signature, rotates, and calls `execTransactionFromModule` in one step.

### What's still not quantum-safe

- The account that sends the transaction and pays gas is a normal ECDSA account. It only holds
  gas money, and a relayer can send instead.
- Other Safe owners that are plain keys or P-256 keys. Every owner needs this for the Safe to be safe.
- The firmware hole in `PLAN-TRUST.md`: fake firmware can still ask the chip to sign.
- The one-time key's 32 bytes sit in RP2040 RAM while it signs.

### Plan for this part

1. A WOTS signer contract + Foundry tests (good signature, wrong key, reused key, wrong next key).
2. WOTS in MicroPython on the RP2040, checked against the contract. Measure sign time.
3. The seed slot on a spare Trust M, carefully: the metadata write is permanent.
4. Wire it into wedgie-safe and /safe.
5. An audit before real money.

## The plan (P-256 rotation)

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
