# The wedgie's Safe owner address. Safe's passkey signer factory (safe-modules passkey 0.2.1,
# SafeWebAuthnSignerFactory) CREATE2s a small proxy from the chip key (x, y) and the verifiers (the chain's
# P-256 precompile, no fallback), so the address is the same on every chain and needs no RPC. wedgie.dev/safe
# works out the same one (src/safe/eth.ts signerAddress): the home screen shows it so the two can be compared.
# Imported only when it has to be worked out (once per key: safe.py saves it).
import binascii
from safe_keccak import keccak256 as k

FACTORY = binascii.unhexlify("1d31f259ee307358a26dfb23eb365939e8641195")
SINGLETON = binascii.unhexlify("4e27b51350e6c2083ee19011120f50dafec5ca50")
VERIFIERS = (0x100 << 160).to_bytes(32, "big")
# SafeWebAuthnSignerProxy's creation code, from the factory's bytecode (437 bytes)
PROXY_CODE = binascii.unhexlify(
    b"610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b257808492"
    b"6080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090"
    b"920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c9823960805181"
    b"6082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b6000526041"
    b"60045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f"
    b"000000000000000000000000000000000000000000000000000000000000000060a03601527f00000000000000000000"
    b"0000000000000000000000000000000000000000000036608001523660006080376000806056360160807f0000000000"
    b"0000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fe"
    b"a26469706673582212201660515548d15702d720bbc046b457ca85e941a4559ab9f9518488e4c82e5ee964736f6c6343"
    b"00081a0033")


def checksum(a):
    """EIP-55: the mixed-case spelling every wallet and Safe{Wallet} shows."""
    h = binascii.hexlify(a).decode()
    kh = binascii.hexlify(k(h.encode())).decode()
    return "0x" + "".join(c.upper() if int(kh[i], 16) >= 8 else c for i, c in enumerate(h))


def address(x, y):
    """x, y: the key's 32-byte halves. The signer contract's address, checksummed."""
    init = k(PROXY_CODE + bytes(12) + SINGLETON + x + y + VERIFIERS)
    return checksum(k(b"\xff" + FACTORY + bytes(32) + init)[12:])
