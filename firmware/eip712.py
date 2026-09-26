# Rebuild the ChipAccount Transfer digest on the device. If this does not match the digest the
# app sent, the app is lying about what it wants signed, and the device refuses.
from keccak import keccak256

DOMAIN_TYPEHASH = keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
TRANSFER_TYPEHASH = keccak256(b"Transfer(address token,address to,uint256 amount,uint256 nonce,uint256 deadline)")
SET_NAME_TYPEHASH = keccak256(b"SetName(string name,uint256 nonce,uint256 deadline)")
EXECUTE_TYPEHASH = keccak256(b"Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)")
CANCEL_RECOVERY_TYPEHASH = keccak256(b"CancelRecovery(uint256 nonce,uint256 deadline)")
NAME_HASH = keccak256(b"ChipAccount")
VERSION_HASH = keccak256(b"1")

_domain_cache = {}


def _addr(a):
    a = a[2:] if a.startswith("0x") else a
    return bytes(12) + bytes.fromhex(a)


def _u256(n):
    return int(n).to_bytes(32, "big")


def domain_separator(chain_id, account):
    key = (chain_id, account.lower())
    if key not in _domain_cache:
        _domain_cache[key] = keccak256(DOMAIN_TYPEHASH + NAME_HASH + VERSION_HASH + _u256(chain_id) + _addr(account))
    return _domain_cache[key]


def transfer_digest(chain_id, account, token, to, amount, nonce, deadline):
    struct = keccak256(TRANSFER_TYPEHASH + _addr(token) + _addr(to) + _u256(amount) + _u256(nonce) + _u256(deadline))
    return keccak256(b"\x19\x01" + domain_separator(chain_id, account) + struct)


def set_name_digest(chain_id, account, name, nonce, deadline):
    struct = keccak256(SET_NAME_TYPEHASH + keccak256(name.encode()) + _u256(nonce) + _u256(deadline))
    return keccak256(b"\x19\x01" + domain_separator(chain_id, account) + struct)


def execute_digest(chain_id, account, target, value, data, nonce, deadline):
    struct = keccak256(EXECUTE_TYPEHASH + _addr(target) + _u256(value) + keccak256(data) + _u256(nonce) + _u256(deadline))
    return keccak256(b"\x19\x01" + domain_separator(chain_id, account) + struct)


def cancel_recovery_digest(chain_id, account, nonce, deadline):
    struct = keccak256(CANCEL_RECOVERY_TYPEHASH + _u256(nonce) + _u256(deadline))
    return keccak256(b"\x19\x01" + domain_separator(chain_id, account) + struct)


def data_hash(data):
    return keccak256(data)
