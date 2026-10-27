# Safe Signer: the addresses the wedgie knows itself, by name (ERC-7730's "local" address names). Used by the
# descriptor reader (safe_7730, an addressName) and the hand-written pages (safe_read). Built in, never from the host.
import binascii

# Candide social recovery: a wallet starts on the 7-day one; pairing a wedgie puts the owner's own recovery address
# on the 14-day one and the DAO on the 60-day one (the same Candide code, Instant Wallet deployed it)
RECOVERY = {"0x088f6cfd8bb1ddb1bb069ccb3fc1a98927d233f2": 7, "0x9bacd92f4687db306d7ded5d4513a51ea05df25b": 14,
            "0x6aa9a8ad0582db61a97a6e30eba22ba143d1e960": 60}
MODULES = {m: "%d-day recovery" % d for m, d in RECOVERY.items()}
MODULE_FACTORY = "0x000000000000addb49795b0f9ba5bc298cdda236"   # Zodiac ModuleProxyFactory
ROLES_COPY = "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5"       # Zodiac Roles 2.1.1
# Instant Wallet's relay: it sends the transactions and is paid a fee in the batch
RELAY = "0x4cfab32186e65e2a39ec0e882e11380cbf2f8a2f"
NAMES = {RELAY: "the Instant relay"}
# swap routers: an approval to one names it (the same address on every chain)
ROUTERS = {"0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": "LI.FI",
           "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap",     # SwapRouter02, Base
           "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap"}     # SwapRouter02, Ethereum
# "this Safe" calling itself (owners, threshold, modules) is read with the descriptor at this address
# (wedgie-dev descriptors/safe/calldata-ThisSafe.json): a Safe is a proxy at its own address on every chain
THIS_SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe"

_roles_of = {}          # safe -> its Roles address (the keccaks are slow in plain Python: once each)


def init(safe):
    """Roles.setUp(abi.encode(safe, safe, safe)): how Instant Wallet makes a Safe's own daily limit."""
    from safe import word, aword
    return binascii.unhexlify("a4f9edbf") + word(32) + word(96) + aword(safe) * 3


def roles_of(safe):
    """The address of this Safe's own daily limit (Zodiac Roles, CREATE2 by the ModuleProxyFactory, salt
    keccak(keccak(init), 0)): the limit pages say "Daily limit" only for calls to it."""
    if safe not in _roles_of:
        from safe_keccak import keccak256 as k
        from safe import word, unhex, hx
        code = binascii.unhexlify("602d8060093d393df3363d3d373d3d3d363d73") + unhex(ROLES_COPY) + \
            binascii.unhexlify("5af43d82803e903d91602b57fd5bf3")
        h = k(b"\xff" + unhex(MODULE_FACTORY) + k(k(init(safe)) + word(0)) + k(code))
        _roles_of[safe] = hx(h[12:])
    return _roles_of[safe]


def name(a, safe, own=False):
    """What the wedgie calls address a, or None. own: a call to this Safe itself, where its daily limit may come up
    (worked out only then: two keccaks of plain Python)."""
    import safe as A
    s = getattr(A, "signer", None)
    if s and a == s.lower():
        return "THIS wedgie"
    n = MODULES.get(a) or NAMES.get(a) or ROUTERS.get(a)
    if n:
        return n
    if own and a == roles_of(safe):
        return "Daily limit"
    return None
