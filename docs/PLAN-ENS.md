# Plan: names under wedgie.eth (`alice.wedgie.eth`)

Goal: a Safe gets a name like `alice.wedgie.eth` for cents, from /safe, signed on the wedgie. The name
shows wherever the Safe's address shows.

## How it works

- Names live in a contract on Base (Durin's L2Registry, by NameStone). Making one costs cents.
- wedgie.eth on Ethereum points at Durin's L1Resolver. When an app looks up `alice.wedgie.eth`, that
  resolver sends it to a gateway server, which reads the Base contract and signs the answer.
- A Safe gets two things in one transaction:
  1. the name (`alice.wedgie.eth` → the Safe's address, on Ethereum and on Base)
  2. its own name (the Safe's address → `alice.wedgie.eth`), set on Base's reverse registrar. Without
     this, apps show the address, not the name. A Safe can set it because it calls the reverse
     registrar itself.

## Costs

| What | Who pays | About |
|---|---|---|
| Deploy the registry on Base | Austin's wallet | cents |
| Deploy our registrar on Base | Austin's wallet | cents |
| Point wedgie.eth at Durin (2 txs on Ethereum) | Austin's wallet | a few dollars, once |
| Each name | the Safe (or the wallet that executes) | cents |

## Steps

**0. Check wedgie.eth** (needs `ALCHEMY_API_KEY` in `.env`)
Owner, wrapped in the Name Wrapper or not, expiry, current resolver and records. Before step 3,
wedgie.eth's own records (its address, avatar) must be copied into the Base registry, or they disappear
when the resolver changes.

**1. Read names right** (ship on its own, fixes `*.base.eth` today)
`src/safe/address.ts` reads ENS the old way (registry + resolver on Ethereum). It can't follow a
gateway (CCIP-read) or read Base names. Switch it to viem's ENS functions (Universal Resolver, CCIP-read,
per-chain names). Look up a Safe's name for its own chain (Base), then fall back to the default name.

**2. Contracts, on Base Sepolia first**
- Registry: deploy from durin.dev. Austin's wallet owns it.
- Registrar: ours, from Durin's template (MIT). Rules:
  - an address names only itself (`register(label)` sets the name to `msg.sender`), one name per address
  - 3+ characters, `a-z 0-9 -`, first come
  - free (the Safe pays gas only). Price or limits can be added later.
  - sets the address for Ethereum and for Base (Base's own name check needs the Base one)
- Test: register a test name on Sepolia ENS, point it at the Base Sepolia registry, run the whole flow
  (`tools/safelive.mjs` style). Add the registrar to `tools/safefork.mjs` for the fork tests.

**3. Turn it on for wedgie.eth** (Austin, from his wallet, on durin.dev or app.ens.domains)
1. Set wedgie.eth's resolver to Durin's L1Resolver (`0x8A968aB9eb8C084FBC44c531058Fc9ef945c3D61`).
2. Call `setL2Registry` with the Base registry's address.
3. Add our registrar to the registry (`addRegistrar`).

**4. "Name this Safe" on /safe**
- On a Safe's page: a box `[ alice ].wedgie.eth`, shows taken / free as you type.
- One Safe transaction (a MultiSend batch): `register("alice")` + set its own name on Base's reverse
  registrar. Signed on the wedgie (or the wallet), executed like any other.
- After: the Safe's address shows `alice.wedgie.eth` everywhere on the page, and in any app that reads
  ENS the new way.
- Base only at first. A Safe on another chain can still have the name, but its own name (step 2 of
  "How it works") needs that chain's reverse registrar.

**5. The wedgie shows it in plain words** (wedgie-safe app)
Today the wedgie would show this as a red unknown contract call. Teach `describe()` the registrar's
`register` and the reverse registrar's `setName`: "Name this Safe: alice.wedgie.eth". App update →
shelf → signed release, like every app change.

**6. Later: wedgie.dev/ens**
The same box for any wallet: connect, pick a name, the wallet signs. A wedgie's own address can get
a name too (it points at the wedgie), but it can't show the name back: only the Safe can set its own name.

## Risks

- **The gateway is trusted.** Durin's L1Resolver accepts answers signed by NameStone's gateway. If it's
  down, names stop resolving. If it lied, names would point wrong. Fix later: run Durin's gateway
  ourselves (it's in their repo), or a proof-checked gateway (Unruggable) so no one has to be trusted.
- Durin calls itself experimental.
- Apps that read ENS the old way won't see these names. Most big ones (and viem, ethers 6) read the new
  way.
- Changing wedgie.eth's resolver drops its current records unless they're copied first (step 0).

## Decisions for Austin

1. Free names, or a price?
2. One name per Safe, or many?
3. Can a name be taken back? (Default: no, the address that registered it owns it.)
4. Our own gateway from day one, or NameStone's to start?
