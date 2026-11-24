"""Exercise a sealed passkey fixture with the real Yubico ClientPIN protocol."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fido2.ctap import CtapError
from fido2.ctap2 import ClientPin, Ctap2
from fido2.hid import CtapHidDevice, HidDescriptor
from fido2.server import Fido2Server
from fido2.webauthn import (
    AttestationObject, AuthenticationResponse, AuthenticatorAssertionResponse,
    AuthenticatorAttestationResponse, CollectedClientData, PublicKeyCredentialRpEntity,
    PublicKeyCredentialUserEntity, RegistrationResponse, ResidentKeyRequirement,
    UserVerificationRequirement,
)

from bench_ctap2 import BenchAuthenticator
from credential_store import CredentialStore, MockSecureElement
from pin_uv_fixture import PinUvFixture
from test_bench_ctap2 import PacketConnection


ALPHA = "alpha.invalid"
BETA = "beta.invalid"
PIN = "fixture-PIN-only"
OTHER_PIN = "fixture-bad-PIN"
DIGEST = bytes(32)
ERR = CtapError.ERR
MC = ClientPin.PERMISSION.MAKE_CREDENTIAL
GA = ClientPin.PERMISSION.GET_ASSERTION


class PinUvTests(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory(prefix="wedgie-test-pin-")
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.element = MockSecureElement()
        self.now = 0
        self.approval = None
        self.on_approval = None
        self.prompts = []
        self.open()

    def open(self):
        auth = BenchAuthenticator(self.presence, CredentialStore(self.directory, self.element),
            rp_ids=(ALPHA, BETA), pin=PinUvFixture(self.element.pin, lambda: self.now))
        device = CtapHidDevice(HidDescriptor("fixture", 0, 0, 64, 64, "Wedgie PIN fixture", None), PacketConnection(auth))
        self.addCleanup(device.close)
        self.ctap = Ctap2(device)
        self.pin = ClientPin(self.ctap)
        self.assertEqual(self.pin.protocol.VERSION, 2)

    def presence(self, operation, rp):
        request = (operation, rp)
        self.prompts.append(request)
        if self.approval != request:
            return False
        self.approval = None
        if self.on_approval is not None:
            self.on_approval()
        return True

    def auth(self, token, digest):
        return {"pin_uv_param": self.pin.protocol.authenticate(token, digest), "pin_uv_protocol": 2}

    def register(self, token, *, digest=DIGEST, rp=ALPHA):
        return self.ctap.make_credential(digest, {"id": rp, "name": "Fixture RP"},
            {"id": b"fixture-user"}, [{"type": "public-key", "alg": -7}],
            options={"rk": True}, **self.auth(token, digest))

    def enroll(self):
        self.pin.set_pin(PIN)
        token = self.pin.get_pin_token(PIN, MC, ALPHA)
        self.approval = ("register", ALPHA)
        return self.register(token).auth_data.credential_data

    def assert_error(self, expected, action, *args, **kwargs):
        with self.assertRaises(CtapError) as caught:
            action(*args, **kwargs)
        self.assertEqual(caught.exception.code, expected)

    def test_real_pin_and_required_uv_registration_and_assertion(self):
        self.assertFalse(self.ctap.info.options["clientPin"])
        self.pin.set_pin(PIN)
        self.assertTrue(self.ctap.get_info().options["clientPin"])
        self.assertTrue(self.ctap.info.options["pinUvAuthToken"])

        origin = "https://alpha.invalid"
        server = Fido2Server(PublicKeyCredentialRpEntity(id=ALPHA, name="Fixture RP"))
        user = PublicKeyCredentialUserEntity(name="Fixture user", id=b"fixture-user")
        options, create_state = server.register_begin(user, resident_key_requirement=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED)
        creation = CollectedClientData.create("webauthn.create", options.public_key.challenge, origin)
        token = self.pin.get_pin_token(PIN, MC, ALPHA)
        self.assert_error(ERR.OPERATION_DENIED, self.register, token, digest=creation.hash)
        self.approval = ("register", ALPHA)
        response = self.register(token, digest=creation.hash)
        self.assertTrue(response.auth_data.is_user_verified())
        self.assertTrue(response.auth_data.is_user_present())
        credentials = server.register_complete(create_state, RegistrationResponse(
            raw_id=response.auth_data.credential_data.credential_id,
            response=AuthenticatorAttestationResponse(client_data=creation,
                attestation_object=AttestationObject.create(response.fmt, response.auth_data, response.att_stmt)),
        )).credential_data

        options, auth_state = server.authenticate_begin(user_verification=UserVerificationRequirement.REQUIRED)
        assertion = CollectedClientData.create("webauthn.get", options.public_key.challenge, origin)
        self.approval = ("authenticate", ALPHA)
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        response = self.ctap.get_assertion(ALPHA, assertion.hash, **self.auth(token, assertion.hash))
        self.assertTrue(response.auth_data.is_user_verified())
        verified = server.authenticate_complete(auth_state, [credentials], AuthenticationResponse(
            raw_id=response.credential["id"], response=AuthenticatorAssertionResponse(client_data=assertion,
                authenticator_data=response.auth_data, signature=response.signature, user_handle=response.user["id"])))
        self.assertEqual(verified, credentials)

    def test_scope_and_token_authentication_fail_without_presence_or_counter(self):
        self.enroll()
        get_assertion = self.ctap.get_assertion
        prompts = len(self.prompts)
        head = self.element.head
        token = self.pin.get_pin_token(PIN, MC, ALPHA)
        self.assert_error(ERR.UNAUTHORIZED_PERMISSION, get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assert_error(ERR.UNAUTHORIZED_PERMISSION, self.pin.get_pin_token, PIN, ClientPin.PERMISSION.CREDENTIAL_MGMT, ALPHA)
        self.assert_error(ERR.UNAUTHORIZED_PERMISSION, self.pin.get_pin_token, PIN, GA, "offsite.invalid")
        self.assert_error(ERR.INVALID_SUBCOMMAND, self.pin.get_pin_token, PIN)
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        previous = token
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        self.assert_error(ERR.PIN_AUTH_INVALID, get_assertion, ALPHA, DIGEST, **self.auth(previous, DIGEST))
        self.assert_error(ERR.UNAUTHORIZED_PERMISSION, get_assertion, BETA, DIGEST, **self.auth(token, DIGEST))
        self.assert_error(ERR.PIN_AUTH_INVALID, get_assertion, ALPHA, bytes([1]) * 32, **self.auth(token, DIGEST))
        self.assert_error(ERR.PIN_AUTH_INVALID, get_assertion, ALPHA, DIGEST, pin_uv_protocol=1, pin_uv_param=bytes(32))
        self.assert_error(ERR.PIN_AUTH_INVALID, get_assertion, ALPHA, DIGEST, pin_uv_protocol=2, pin_uv_param=bytes(32))
        self.assert_error(ERR.PUAT_REQUIRED, get_assertion, ALPHA, DIGEST)
        self.now = 30
        self.assert_error(ERR.PIN_TOKEN_EXPIRED, get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assertEqual(len(self.prompts), prompts)
        self.assertEqual(self.element.head, head)

    def test_token_expiry_during_presence_leaves_sealed_state_unchanged(self):
        self.enroll()
        head = self.element.head
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        self.approval = ("authenticate", ALPHA)
        self.on_approval = lambda: setattr(self, "now", 30)
        self.assert_error(ERR.PIN_TOKEN_EXPIRED, self.ctap.get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assertEqual(self.element.head, head)
        self.on_approval = None
        self.approval = ("authenticate", ALPHA)
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        self.assertEqual(self.ctap.get_assertion(ALPHA, DIGEST, **self.auth(token, DIGEST)).auth_data.counter, 1)

    def test_pin_backoff_persists_and_only_virtual_power_cycle_releases_temporary_block(self):
        self.pin.set_pin(PIN)
        for expected in (ERR.PIN_INVALID, ERR.PIN_INVALID, ERR.PIN_AUTH_BLOCKED):
            self.assert_error(expected, self.pin.get_pin_token, OTHER_PIN, GA, ALPHA)
        self.assertEqual(self.pin.get_pin_retries(), (5, True))
        self.open()
        self.assert_error(ERR.PIN_AUTH_BLOCKED, self.pin.get_pin_token, PIN, GA, ALPHA)
        self.element.pin.power_cycle()
        self.open()
        self.assertEqual(self.pin.get_pin_retries(), (5, False))
        for expected in (ERR.PIN_INVALID, ERR.PIN_INVALID, ERR.PIN_AUTH_BLOCKED):
            self.assert_error(expected, self.pin.get_pin_token, OTHER_PIN, GA, ALPHA)
        self.element.pin.power_cycle()
        self.open()
        self.assert_error(ERR.PIN_INVALID, self.pin.get_pin_token, OTHER_PIN, GA, ALPHA)
        self.assert_error(ERR.PIN_BLOCKED, self.pin.get_pin_token, OTHER_PIN, GA, ALPHA)
        self.element.pin.power_cycle()
        self.open()
        self.assert_error(ERR.PIN_BLOCKED, self.pin.get_pin_token, PIN, GA, ALPHA)

    def test_pin_survives_reopen_tokens_expire_and_corruption_fails_closed(self):
        credential = self.enroll()
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        previous = self.ctap
        self.open()
        self.assert_error(ERR.PIN_AUTH_INVALID, previous.get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assert_error(ERR.PUAT_REQUIRED, self.ctap.get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assert_error(ERR.PIN_AUTH_INVALID, self.pin.set_pin, OTHER_PIN)
        self.assert_error(ERR.PIN_INVALID, self.pin.get_pin_token, OTHER_PIN, GA, ALPHA)
        token = self.pin.get_pin_token(PIN, GA, ALPHA)
        self.assertEqual(self.pin.get_pin_retries(), (8, False))
        self.approval = ("authenticate", ALPHA)
        response = self.ctap.get_assertion(ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assertEqual(response.auth_data.counter, 1)
        credential.public_key.verify(response.auth_data + DIGEST, response.signature)
        path = self.directory / "credentials.0.sealed"
        original = path.read_bytes()
        path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        prompts = len(self.prompts)
        self.assert_error(ERR.INTEGRITY_FAILURE, self.ctap.get_assertion, ALPHA, DIGEST, **self.auth(token, DIGEST))
        self.assertEqual(len(self.prompts), prompts)
        self.element.pin.pin_hash = b"malformed fixture state"
        self.assert_error(ERR.INTEGRITY_FAILURE, self.pin.get_pin_retries)

    def test_pin_setup_rejects_bad_mac_and_invalid_curve_point(self):
        params, secret = self.pin._get_shared_secret()
        wrapped = self.pin.protocol.encrypt(secret, PIN.encode().ljust(64, b"\x00"))
        self.assert_error(ERR.PIN_AUTH_INVALID, self.ctap.client_pin, 2, ClientPin.CMD.SET_PIN,
            params, bytes(32), wrapped)
        self.assertIsNone(self.element.pin.pin_hash)
        params[-2] = params[-3] = bytes(32)
        self.assert_error(ERR.INVALID_PARAMETER, self.ctap.client_pin, 2, ClientPin.CMD.SET_PIN,
            params, bytes(32), wrapped)
        self.assertEqual(self.pin.get_pin_retries(), (8, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
