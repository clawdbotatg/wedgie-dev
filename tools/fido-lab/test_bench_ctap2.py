"""Drive the localhost fixture through a FIDO client and packet transport."""

from collections import deque
from time import monotonic_ns
import unittest

from fido2.attestation.packed import PackedAttestation
from fido2.ctap import CtapError
from fido2.ctap2 import Ctap2
from fido2.hid import CAPABILITY, CTAPHID, CtapHidDevice, HidDescriptor
from fido2.server import Fido2Server
from fido2.webauthn import (
    AttestationObject,
    AuthenticationResponse,
    AuthenticatorAssertionResponse,
    AuthenticatorAttestationResponse,
    CollectedClientData,
    PublicKeyCredentialRpEntity,
    PublicKeyCredentialUserEntity,
    RegistrationResponse,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from bench_ctap2 import BenchAuthenticator, MAX_REQUEST, RP_HASH, RP_ID
from ctaphid import Transport


ORIGIN = "http://localhost:48368"
TEST_USER = PublicKeyCredentialUserEntity(name="fixture", id=b"disposable-local-fixture")
ERR = CtapError.ERR


class PacketConnection:
    """Loop back HID packets in memory without opening a device or socket."""

    def __init__(self, authenticator):
        self.transport = Transport(
            lambda: bytes.fromhex("12345678"), lambda: monotonic_ns() // 1_000_000,
            lambda now, start: now - start, cbor=authenticator.handle)
        self.replies = deque()

    def read_packet(self):
        return self.replies.popleft()

    def write_packet(self, packet):
        self.replies.extend(self.transport.receive(packet))

    def close(self):
        self.replies.clear()


class CTAP2BenchTest(unittest.TestCase):
    def setUp(self):
        self.approve_next = False
        self.prompts = []
        self.device, self.client = self.make_client()
        self.addCleanup(self.device.close)
        self.server = Fido2Server(PublicKeyCredentialRpEntity(id=RP_ID, name="Local fixture"))

    def simulated_presence(self, operation, rp):
        approved, self.approve_next = self.approve_next, False
        self.prompts.append((operation, rp))
        return approved

    def make_client(self):
        descriptor = HidDescriptor("fixture", 0, 0, 64, 64, "Wedgie bench", None)
        device = CtapHidDevice(descriptor, PacketConnection(BenchAuthenticator(self.simulated_presence)))
        return device, Ctap2(device)

    def make_credential(self, client_hash=bytes(32), **kwargs):
        options = dict(rp={"id": RP_ID, "name": "Local fixture"},
                       user={"id": TEST_USER.id, "name": TEST_USER.name},
                       key_params=[{"type": "public-key", "alg": -7}], options={"rk": True})
        options.update(kwargs)
        return self.client.make_credential(client_hash, **options)

    def assert_ctap_error(self, code, action, *args, **kwargs):
        with self.assertRaises(CtapError) as caught:
            action(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_get_info_advertises_only_implemented_features(self):
        self.assertTrue(self.device.capabilities & CAPABILITY.CBOR)
        self.assertTrue(self.device.capabilities & CAPABILITY.NMSG)
        info = self.client.get_info()
        self.assertEqual(info.versions, ["FIDO_2_0"])
        self.assertEqual(info.options, {"up": True, "rk": True})
        self.assertEqual(info.algorithms, [{"alg": -7, "type": "public-key"}])
        self.assertEqual(info.max_msg_size, MAX_REQUEST)
        self.assertEqual(self.prompts, [])

    def test_register_and_authenticate_against_webauthn_server(self):
        options, state = self.server.register_begin(
            TEST_USER, resident_key_requirement=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.DISCOURAGED)
        creation = CollectedClientData.create("webauthn.create", options.public_key.challenge, ORIGIN)
        self.approve_next = True
        result = self.make_credential(creation.hash)
        self.assertEqual(result.auth_data.rp_id_hash, RP_HASH)
        self.assertFalse(result.auth_data.is_user_verified())
        self.assertTrue(result.auth_data.is_user_present())
        PackedAttestation().verify(result.att_stmt, result.auth_data, creation.hash)
        credential_id = result.auth_data.credential_data.credential_id
        attestation = AttestationObject.create(result.fmt, result.auth_data, result.att_stmt)
        registered = self.server.register_complete(state, RegistrationResponse(
            raw_id=credential_id, response=AuthenticatorAttestationResponse(
                client_data=creation, attestation_object=attestation)))

        options, state = self.server.authenticate_begin(
            user_verification=UserVerificationRequirement.DISCOURAGED)
        request = CollectedClientData.create("webauthn.get", options.public_key.challenge, ORIGIN)
        self.approve_next = True
        result = self.client.get_assertion(RP_ID, request.hash)
        self.assertEqual(result.user, {"id": TEST_USER.id})
        self.assertEqual(result.auth_data.counter, 1)
        self.assertFalse(result.auth_data.is_user_verified())

        def auth_response(client_data):
            return AuthenticationResponse(raw_id=result.credential["id"],
                response=AuthenticatorAssertionResponse(client_data=client_data,
                    authenticator_data=result.auth_data, signature=result.signature,
                    user_handle=result.user["id"]))

        self.assertEqual(self.server.authenticate_complete(
            state, [registered.credential_data], auth_response(request)), registered.credential_data)
        wrong_challenge = CollectedClientData.create("webauthn.get", bytes(32), ORIGIN)
        with self.assertRaisesRegex(ValueError, "challenge"):
            self.server.authenticate_complete(state, [registered.credential_data], auth_response(wrong_challenge))
        wrong_origin = CollectedClientData.create("webauthn.get", options.public_key.challenge, "https://example.invalid")
        with self.assertRaisesRegex(ValueError, "origin"):
            self.server.authenticate_complete(state, [registered.credential_data], auth_response(wrong_origin))
        self.assertEqual(self.prompts, [("register", RP_ID), ("authenticate", RP_ID)])

    def test_denies_without_presence_scope_or_supported_options(self):
        self.assert_ctap_error(ERR.OPERATION_DENIED, self.make_credential, rp={"id": "example.invalid"})
        self.assert_ctap_error(ERR.UNSUPPORTED_ALGORITHM, self.make_credential,
                               key_params=[{"type": "public-key", "alg": -8}])
        self.assert_ctap_error(ERR.INVALID_OPTION, self.make_credential, options={"rk": True, "uv": True})
        self.assertEqual(self.prompts, [])
        self.assert_ctap_error(ERR.OPERATION_DENIED, self.make_credential)
        self.assert_ctap_error(ERR.NO_CREDENTIALS, self.client.get_assertion, RP_ID, bytes(32))
        self.approve_next = True
        result = self.make_credential()
        descriptor = {"type": "public-key", "id": result.auth_data.credential_data.credential_id}
        self.assert_ctap_error(ERR.NO_CREDENTIALS, self.client.get_assertion, "example.invalid", bytes(32))
        self.assert_ctap_error(ERR.NO_CREDENTIALS, self.client.get_assertion, RP_ID, bytes(32), allow_list=[])
        self.assert_ctap_error(ERR.NO_CREDENTIALS, self.client.get_assertion, RP_ID, bytes(32),
                               allow_list=[dict(descriptor, type="other")])
        self.assert_ctap_error(ERR.INVALID_OPTION, self.client.get_assertion, RP_ID, bytes(32),
                               options={"up": False})
        self.assert_ctap_error(ERR.OPERATION_DENIED, self.client.get_assertion, RP_ID, bytes(32))
        for counter in (1, 2):
            self.approve_next = True
            response = self.client.get_assertion(RP_ID, bytes(32), allow_list=[descriptor])
            self.assertEqual(response.auth_data.counter, counter)

    def test_refuses_overwrite_and_discards_credentials_on_recreate(self):
        self.approve_next = True
        result = self.make_credential()
        descriptor = {"type": "public-key", "id": result.auth_data.credential_data.credential_id}
        self.assert_ctap_error(ERR.OPERATION_DENIED, self.make_credential, exclude_list=[descriptor])
        self.approve_next = True
        self.assert_ctap_error(ERR.CREDENTIAL_EXCLUDED, self.make_credential, exclude_list=[descriptor])
        self.approve_next = True
        self.assert_ctap_error(ERR.KEY_STORE_FULL, self.make_credential)
        fresh_device, fresh_client = self.make_client()
        self.addCleanup(fresh_device.close)
        self.assert_ctap_error(ERR.NO_CREDENTIALS, fresh_client.get_assertion, RP_ID, bytes(32))

    def test_rejects_malformed_and_unimplemented_commands_without_prompt(self):
        requests = (
            (b"", ERR.INVALID_LENGTH),
            (b"\x04\xa0", ERR.INVALID_LENGTH),
            (b"\x01\xa2\x01\x00\x01\x00", ERR.INVALID_CBOR),  # duplicate key
            (b"\x01\xa0\x00", ERR.INVALID_CBOR),  # trailing data
            (b"\x01\xa1\x18\x01\x00", ERR.INVALID_CBOR),  # noncanonical key
            (b"\x01\x1b\x00", ERR.INVALID_CBOR),  # truncated 64-bit integer
            (b"\x01" + (b"\x81" * 999), ERR.INVALID_CBOR),  # unsafe nesting/truncation
            (b"\x01\x80", ERR.CBOR_UNEXPECTED_TYPE),
            (b"\x01\xa0", ERR.MISSING_PARAMETER),
            (b"\x01" + (b"\0" * MAX_REQUEST), ERR.INVALID_LENGTH),
            (b"\x06\xa0", ERR.INVALID_COMMAND),  # PIN
            (b"\x07", ERR.INVALID_COMMAND),  # reset
        )
        for payload, code in requests:
            with self.subTest(size=len(payload), status=code):
                self.assertEqual(self.device.call(CTAPHID.CBOR, payload), bytes((code,)))
        self.assertEqual(self.prompts, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
