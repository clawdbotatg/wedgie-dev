"""Persistent fixture credentials exercised through the CTAP HID client."""

from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from cryptography.exceptions import InvalidSignature, InvalidTag
from fido2.ctap import CtapError
from fido2.ctap2 import Ctap2
from fido2.hid import CtapHidDevice, HidDescriptor

from bench_ctap2 import BenchAuthenticator
from credential_store import CredentialStore, MockSecureElement
from test_bench_ctap2 import PacketConnection


ALPHA = "alpha.invalid"
BETA = "beta.invalid"
CLIENT_HASH = sha256(b"disposable request hash").digest()
ERR = CtapError.ERR


class InterruptibleElement(MockSecureElement):
    fail_next_commit = False

    def commit(self, expected_generation, digest):
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise OSError("Simulated interruption before trusted commit")
        super().commit(expected_generation, digest)


class SealedCredentialTest(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory(prefix="wedgie-test-fido-")
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.element = InterruptibleElement()
        self.prompts = []
        self.approval = None
        self.open()

    def open(self, element=None):
        store = CredentialStore(self.directory, self.element if element is None else element)
        fixture = BenchAuthenticator(self.presence, store, rp_ids=(ALPHA, BETA))
        hid = HidDescriptor("fake", 0, 0, 64, 64, "Wedgie sealed fixture", None)
        device = CtapHidDevice(hid, PacketConnection(fixture))
        self.addCleanup(device.close)
        self.client = Ctap2(device)

    def presence(self, operation, rp):
        requested = (operation, rp)
        self.prompts.append(requested)
        if self.approval != requested:
            return False
        self.approval = None
        return True

    def make_credential(self, rp):
        return self.client.make_credential(CLIENT_HASH, {"id": rp, "name": rp},
            {"id": ("fixture-user-" + rp).encode()}, [{"type": "public-key", "alg": -7}],
            options={"rk": True}).auth_data.credential_data

    def assert_error(self, expected, method, *args, **kwargs):
        with self.assertRaises(CtapError) as thrown:
            method(*args, **kwargs)
        self.assertEqual(thrown.exception.code, expected)

    def test_restart_preserves_credential_and_counter_and_requires_new_presence(self):
        self.approval = ("register", ALPHA)
        registration = self.make_credential(ALPHA)
        self.approval = ("authenticate", ALPHA)
        first = self.client.get_assertion(ALPHA, CLIENT_HASH)
        self.assertEqual(first.auth_data.counter, 1)
        self.open()
        head = self.element.head
        self.assert_error(ERR.OPERATION_DENIED, self.client.get_assertion, ALPHA, CLIENT_HASH)
        self.assertEqual(head, self.element.head)
        self.approval = ("authenticate", ALPHA)
        second = self.client.get_assertion(ALPHA, CLIENT_HASH)
        self.assertEqual(second.credential["id"], registration.credential_id)
        self.assertEqual(second.auth_data.counter, 2)
        registration.public_key.verify(second.auth_data + CLIENT_HASH, second.signature)
        blob = (self.directory / "credentials.1.sealed").read_bytes()
        self.assertNotIn(b"fixture-user-", blob)
        self.assertNotIn(registration.credential_id, blob)

    def test_each_reserved_rp_has_its_own_presence_and_key(self):
        self.approval = ("register", ALPHA)
        alpha = self.make_credential(ALPHA)
        self.approval = ("register", BETA)
        beta = self.make_credential(BETA)
        self.assertNotEqual(alpha.credential_id, beta.credential_id)
        self.open()
        prompts = len(self.prompts)
        self.assert_error(ERR.NO_CREDENTIALS, self.client.get_assertion, BETA, CLIENT_HASH,
            allow_list=[{"type": "public-key", "id": alpha.credential_id}])
        self.assert_error(ERR.NO_CREDENTIALS, self.client.get_assertion, "other.invalid", CLIENT_HASH)
        self.assertEqual(len(self.prompts), prompts)
        self.approval = ("authenticate", ALPHA)
        self.assert_error(ERR.OPERATION_DENIED, self.client.get_assertion, BETA, CLIENT_HASH)
        first = self.client.get_assertion(ALPHA, CLIENT_HASH)
        self.approval = ("authenticate", BETA)
        second = self.client.get_assertion(BETA, CLIENT_HASH)
        self.assertEqual(first.credential["id"], alpha.credential_id)
        self.assertEqual(second.credential["id"], beta.credential_id)
        self.assertEqual(second.auth_data.rp_id_hash, sha256(BETA.encode()).digest())
        beta.public_key.verify(second.auth_data + CLIENT_HASH, second.signature)
        with self.assertRaises(InvalidSignature):
            alpha.public_key.verify(second.auth_data + CLIENT_HASH, second.signature)

    def test_replacing_a_committed_slot_with_older_ciphertext_is_rejected(self):
        self.approval = ("register", ALPHA)
        self.make_credential(ALPHA)
        slot = self.directory / "credentials.1.sealed"
        old = slot.read_bytes()
        for _ in range(2):
            self.approval = ("authenticate", ALPHA)
            self.client.get_assertion(ALPHA, CLIENT_HASH)
        self.assertEqual(self.element.head[0], 3)
        newer = slot.read_bytes()
        self.assertNotEqual(old, newer)
        slot.write_bytes(old)
        self.open()
        prompts = len(self.prompts)
        self.assert_error(ERR.INTEGRITY_FAILURE, self.client.get_assertion, ALPHA, CLIENT_HASH)
        self.assertEqual(len(self.prompts), prompts)

    def test_ciphertext_corruption_wrong_generation_and_wrong_element_fail_closed(self):
        self.approval = ("register", ALPHA)
        self.make_credential(ALPHA)
        slot = self.directory / "credentials.1.sealed"
        sealed = slot.read_bytes()
        with self.assertRaises(InvalidTag):
            self.element.unseal(2, sealed)
        self.open(MockSecureElement())
        self.assert_error(ERR.INTEGRITY_FAILURE, self.client.get_assertion, ALPHA, CLIENT_HASH)
        slot.write_bytes(sealed[:-1] + bytes([sealed[-1] ^ 1]))
        self.open()
        self.assert_error(ERR.INTEGRITY_FAILURE, self.client.get_assertion, ALPHA, CLIENT_HASH)

    def test_incomplete_commits_preserve_previous_state_including_first_enrollment(self):
        self.element.fail_next_commit = True
        self.approval = ("register", ALPHA)
        self.assert_error(ERR.INTEGRITY_FAILURE, self.make_credential, ALPHA)
        self.assertEqual(self.element.head[0], 0)
        self.assertTrue((self.directory / "credentials.1.sealed").exists())
        self.open()
        self.assert_error(ERR.NO_CREDENTIALS, self.client.get_assertion, ALPHA, CLIENT_HASH)
        self.approval = ("register", ALPHA)
        registered = self.make_credential(ALPHA)
        self.element.fail_next_commit = True
        self.approval = ("authenticate", ALPHA)
        self.assert_error(ERR.INTEGRITY_FAILURE, self.client.get_assertion, ALPHA, CLIENT_HASH)
        self.assertEqual(self.element.head[0], 1)
        self.open()
        self.approval = ("authenticate", ALPHA)
        signed = self.client.get_assertion(ALPHA, CLIENT_HASH)
        self.assertEqual(signed.auth_data.counter, 1)
        registered.public_key.verify(signed.auth_data + CLIENT_HASH, signed.signature)


if __name__ == "__main__":
    unittest.main(verbosity=2)
