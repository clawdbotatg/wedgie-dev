# Plan: a wedgie address that can hold money, and keys that can change

Status 2026-10-08. Plan only, on hold (Austin: "we won't do anything yet"). Decisions below are open.

## The problem

The wedgie's address today is Safe's passkey signer contract (safe-modules passkey 0.2.1,
`SafeWebAuthnSignerProxy`). It only answers "did this key sign this?" for Safes.

- Money sent to it is lost forever: it has no way to send anything out, and its code can never change
  (the address is a hash of the code and the key).
- Its key can never change. Rotating keys (`RESEARCH-ROTATING-KEY.md`) or moving to quantum-safe hash
  signatures (`clawdbotatg/wedgie-pq`) means a new address in every Safe, every time.

## What we want

One address per wedgie that:

1. stays the same while its keys change (P-256 now, rotated keys next, WOTS hash keys later),
2. signs for Safes (ERC-1271, like today),
3. can send out money that lands on it (a sweep), signed on the wedgie,
4. can never be taken over by anyone but the wedgie: no admin key, no upgrade key.

## Audited contracts we could use instead

| Contract | Audited | Holds money | Key can change | Quantum path |
|---|---|---|---|---|
| Safe passkey signer (today) | yes | no | no | no |
| Safe passkey **shared** signer (same audit) | yes | no (the key lives in each Safe, no wedgie address at all) | per Safe | no |
| A 1-of-1 Safe owned by today's signer | yes | yes | yes (swap its owner) | swap to a WOTS owner later |
| Coinbase Smart Wallet (P-256 passkey owners) | yes | yes | yes (add/remove owner keys) | no |

The best audited fit is **a 1-of-1 Safe** as the wedgie's address: it holds money, signs for other
Safes as an owner (Safe supports a Safe as owner), and its owner can be swapped to a new key or a
quantum-safe signer later without its address changing. The cost: a Safe signing for a Safe is two
layers, harder to build, and Safe{Wallet} handles it less smoothly.

None of these is quantum-safe. That part is new code either way.

## Our own contract: WedgieSigner

One small contract per wedgie, made by CREATE2 from a factory (salt = hash of its first public key), so
anyone can work out its address before it's deployed, the same on every chain.

**State:** the current key (`scheme` + data: P-256 `(x, y)` now, a WOTS key hash later) and a nonce.

**Functions:**

- `isValidSignature(hash, sig)`: for Safes. Same check as Safe's passkey signer (WebAuthn wrapping,
  the P-256 precompile at `0x100`, same `clientDataFields`), so the wedgie app signs the same way.
- `execute(to, value, data, sig)`: send money or call anything. Signed by the current key over its own
  message: `keccak("WedgieSigner execute", chainId, this, nonce, to, value, data)`. The nonce goes up.
  This is the sweep. Anyone can submit it and pay gas.
- `rotate(newKey, sig)`: the current key signs the next one (same message style). All Safes keep
  working: they point at the address, not the key.

**Rules that keep it safe:**

- No owner, no admin, no upgrade, no `selfdestruct`, no `delegatecall`.
- A Safe signature can never pass as `execute` or `rotate`: different message, chain id, contract
  address and nonce inside it.
- `isValidSignature` never changes state (Safe calls it with `staticcall`).
- The P-256 check copies safe-modules' code (MIT) as-is. The new parts are `execute`, `rotate`, the nonce.

**On the wedgie (wedgie-safe app):**

- New screens: "Send 0.1 ETH to 0x… from your wedgie's address" for `execute`, "Change your wedgie's
  key" for `rotate`. The wedgie builds the message hash itself from the fields, like Safe txs.
- `safe_addr.py` works out the new address (new factory, new init code).

**On the site (/safe):**

- The header shows the new address, with its balance, and a Send button (an `execute`).
- A "Move to your new wedgie address" button per Safe: one Safe tx, `swapOwner(old signer, new)`.
- The old signer address gets a "never send money here" warning.

## Steps

1. **Contract + tests** (Foundry): WedgieSigner and its factory. Tests: a Safe accepts its signature,
   a Safe signature fails as `execute`, replay fails (nonce, chain, address), `rotate` then old key
   fails, sweep of ETH and an ERC-20.
2. **Fork test** (`tools/safefork.mjs` style): a Safe with a WedgieSigner owner, sign through the real
   wedgie app on the virtual RP2040 (`tools/safechip.mjs`), rotate, keep signing.
3. **wedgie-safe app**: `execute` and `rotate` screens, the new address. Memory check on chipprobe.
4. **/safe**: new address in the header, balance + Send, "move to your new address", the warning.
5. **Review.** New contract code that holds money: get it reviewed before real money.
6. **Base Sepolia, then Base** with a few dollars, on a real wedgie.
7. **Rotation** (`RESEARCH-ROTATING-KEY.md`): becomes `rotate` inside the same Safe batch, not
   `swapOwner` in every Safe.
8. **Quantum-safe** (`wedgie-pq`): add the WOTS scheme to `rotate`/`isValidSignature`. Since the code
   can't change, this is a new WedgieSigner version, then one more `swapOwner` per Safe (or one
   `rotate`, if v1 ships with a slot for a verifier contract, see below).

## Decide before step 1

1. **A 1-of-1 Safe (audited, no new contract) or WedgieSigner (new code, simpler, rotation built in)?**
   My pick: WedgieSigner, since the quantum work needs new code anyway.
2. **Pluggable verifier?** v1 could take the signature check from a separate contract chosen at
   `rotate` time, so WOTS later is a `rotate`, not a new address. More flexible, slightly more risk.
3. **Who reviews it**, and when.
