"""RP2040 emulator cartridge for a disposable vault derivation test."""
from binascii import hexlify, unhexlify
import optiga
import wedgie

# Both OIDs are volatile. This fixture doesn't use the wallet's long-lived ECC slots.
KEY = optiga.SESSION[2]
AGREEMENT = optiga.SESSION[3]
LABEL = b"wedgie-keepassxc-keyfile-v1\x00"
VAULT = bytes(range(32))
OTHER_VAULT = bytes(range(1, 33))
PEER = unhexlify("__FIXTURE_PEER__")


def derive_key(chip, peer, vault_id):
    if len(peer) != 65 or peer[0] != 4 or len(vault_id) != 32:
        raise ValueError("Bad fixture peer or vault identifier")
    if chip.ecdh(KEY, peer, store=AGREEMENT) is not None:
        raise RuntimeError("The ECDH secret must remain inside the chip")
    key = chip.derive(AGREEMENT, 32, LABEL + vault_id, method="prf256")
    if len(key) != 32:
        raise RuntimeError("Wrong vault fixture key length")
    return key


def run():
    chip = optiga.Chip()
    try:
        public = chip.genkey(KEY, optiga.P256, optiga.KEY_AGREE)
        key = derive_key(chip, PEER, VAULT)
        repeated = derive_key(chip, PEER, VAULT) == key
        wrong_vault = derive_key(chip, PEER, OTHER_VAULT)
    finally:
        chip.close()
    chip = optiga.Chip()
    try:
        erased = False
        try:
            chip.derive(AGREEMENT, 32, LABEL + VAULT, method="prf256")
        except optiga.Error as error:
            erased = error.code == 7
        new_public = chip.genkey(KEY, optiga.P256, optiga.KEY_AGREE)
        wrong_device = derive_key(chip, PEER, VAULT)
    finally:
        chip.close()
    # The emulator harness consumes this frame in memory. No physical app or log sink uses it.
    wedgie.send({"type": "vault-fixture-result", "public": hexlify(public).decode(),
                 "new_public": hexlify(new_public).decode(), "derived": hexlify(key).decode(),
                 "wrong_vault": hexlify(wrong_vault).decode(), "wrong_device": hexlify(wrong_device).decode(),
                 "repeated": repeated, "reset_erased_secret": erased})
