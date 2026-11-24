"""Verify per-site volatile credentials through fido2 and a virtual Trust M."""

import argparse
from contextlib import contextmanager
from hashlib import sha256
import json
from pathlib import Path
from subprocess import PIPE, Popen, TimeoutExpired

from cryptography.hazmat.primitives.asymmetric import ec, utils
from fido2.attestation.packed import PackedAttestation
from fido2.ctap import CtapError
from fido2.ctap2 import Ctap2
from fido2.hid import CtapHidDevice, HidDescriptor
from fido2.server import Fido2Server
from fido2.webauthn import (
    AttestationObject, AuthenticationResponse, AuthenticatorAssertionResponse,
    AuthenticatorAttestationResponse, CollectedClientData, PublicKeyCredentialRpEntity,
    PublicKeyCredentialUserEntity, RegistrationResponse, ResidentKeyRequirement,
    UserVerificationRequirement,
)

from bench_ctap2 import BenchAuthenticator
from test_bench_ctap2 import PacketConnection


class Token:
    def __init__(self, process):
        self.process = process
        self.next_button = "A"

    def receive(self):
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Virtual Trust M fixture stopped")
        return json.loads(line)

    def exchange(self, action, **fields):
        request = {"type": action, "button": self.next_button, **fields}
        self.next_button = "A"
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        reply = self.receive()
        if reply["type"] == "refused":
            raise CtapError(CtapError.ERR.OPERATION_DENIED)
        if reply["type"] == "error" and reply["error"] == "Unavailable test operation":
            raise CtapError(CtapError.ERR.NO_CREDENTIALS)
        if reply["type"] == "error":
            raise RuntimeError(reply["error"])
        return reply

    def new_key(self, rp):
        reply = self.exchange("fido_key", rp=rp)
        assert reply["type"] == "fido_public" and set(reply) == {"type", "id", "public"}
        return TokenKey(self, rp, bytes.fromhex(reply["public"]))


class TokenKey:
    def __init__(self, token, rp, public):
        self.token, self.rp = token, rp
        self.public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)

    def public_key(self):
        return self.public

    def sign(self, message, algorithm):
        assert isinstance(algorithm, ec.ECDSA) and algorithm.algorithm.name == "sha256"
        reply = self.token.exchange("fido_sign", rp=self.rp, message=message.hex())
        assert reply["type"] == "fido_sig" and set(reply) == {"type", "id", "signature"}
        signature = bytes.fromhex(reply["signature"])
        assert len(signature) == 64
        return utils.encode_dss_signature(int.from_bytes(signature[:32], "big"),
                                          int.from_bytes(signature[32:], "big"))


@contextmanager
def open_token(cartridge, emulator_checkout):
    folder = Path(__file__).resolve().parent
    with Popen(["node", folder / "virtual/token.mjs", emulator_checkout, cartridge],
               text=True, stdin=PIPE, stdout=PIPE) as process:
        token = Token(process)
        try:
            assert token.receive() == {"type": "ready"}
            yield token
        finally:
            if process.poll() is None and not process.stdin.closed:
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except TimeoutExpired:
                    process.terminate()


def no_ctap_result(code, method, *args, **kwargs):
    try:
        method(*args, **kwargs)
    except CtapError as error:
        assert error.code == code
    else:
        raise AssertionError(f"Expected CTAP error {code}")


def register(client, rp, user):
    server = Fido2Server(PublicKeyCredentialRpEntity(id=rp, name=rp))
    options, state = server.register_begin(user, resident_key_requirement=ResidentKeyRequirement.REQUIRED,
        user_verification=UserVerificationRequirement.DISCOURAGED)
    data = CollectedClientData.create("webauthn.create", options.public_key.challenge, "https://" + rp)
    args = {"rp": {"id":rp, "name":rp}, "user":{"id":user.id,"name":user.name},
            "key_params":[{"type":"public-key","alg":-7}], "options":{"rk":True}}
    attested = client.make_credential(data.hash, **args)
    PackedAttestation().verify(attested.att_stmt, attested.auth_data, data.hash)
    assert attested.auth_data.rp_id_hash == sha256(rp.encode()).digest()
    assert attested.auth_data.is_user_present() and not attested.auth_data.is_user_verified()
    credential = attested.auth_data.credential_data
    response = RegistrationResponse(raw_id=credential.credential_id, response=AuthenticatorAttestationResponse(
        client_data=data, attestation_object=AttestationObject.create(attested.fmt, attested.auth_data, attested.att_stmt)))
    stored = server.register_complete(state, response).credential_data
    assert stored == credential
    return server, stored, args


def authenticate(client, rp, server, credential):
    options, state = server.authenticate_begin(user_verification=UserVerificationRequirement.DISCOURAGED)
    challenge = CollectedClientData.create("webauthn.get", options.public_key.challenge, "https://" + rp)
    result = client.get_assertion(rp, challenge.hash)
    response = AuthenticationResponse(raw_id=result.credential["id"], response=AuthenticatorAssertionResponse(
        client_data=challenge, authenticator_data=result.auth_data, signature=result.signature, user_handle=result.user["id"]))
    assert result.auth_data.is_user_present() and not result.auth_data.is_user_verified()
    assert server.authenticate_complete(state, [credential], response) == credential
    return result.auth_data.counter


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("cartridge", type=Path)
    cli.add_argument("--emulator-checkout", type=Path, required=True, help="Simulator with volatile Trust M signing support")
    args = cli.parse_args()
    alpha, beta = "alpha.invalid", "beta.invalid"
    with open_token(args.cartridge.resolve(), args.emulator_checkout.resolve()) as token:
        auth = BenchAuthenticator(lambda _op, _rp: True, rp_ids=(alpha, beta), key_factory=token.new_key)
        descriptor = HidDescriptor("fixture", 0, 0, 64, 64, "Virtual Trust M bench", None)
        device = CtapHidDevice(descriptor, PacketConnection(auth))
        client = Ctap2(device)
        a, key_a, params = register(client, alpha, PublicKeyCredentialUserEntity(name="alpha", id=b"local-a"))
        b, key_b, _ = register(client, beta, PublicKeyCredentialUserEntity(name="beta", id=b"local-b"))
        assert key_a.public_key != key_b.public_key
        assert not hasattr(auth._store.get(alpha).key, "private_bytes")
        assert authenticate(client, alpha, a, key_a) == 1
        assert authenticate(client, beta, b, key_b) == 1
        other = [{"type":"public-key","id":key_b.credential_id}]
        no_ctap_result(CtapError.ERR.NO_CREDENTIALS, client.get_assertion, alpha, bytes(32), allow_list=other)
        no_ctap_result(CtapError.ERR.KEY_STORE_FULL, client.make_credential, bytes(32), **params)
        token.next_button = "Y"
        no_ctap_result(CtapError.ERR.OPERATION_DENIED, client.get_assertion, alpha, bytes(32))
        assert authenticate(client, alpha, a, key_a) > 1
        assert token.exchange("fido_close")["type"] == "fido_closed"
        no_ctap_result(CtapError.ERR.NO_CREDENTIALS, client.get_assertion, alpha, bytes(32))
        device.close()
        token.process.stdin.close()
        receipt = token.receive()
        assert receipt == {"type":"receipt", "approvals":7, "denials":1, "signatures":5, "persistentKeysUnchanged":True}
        print(json.dumps({"registeredAndAuthenticatedRps":[alpha,beta], "isolatedCredentialKeys":True,
            "crossRpRefused":True, "repeatedEnrollmentRefused":True, "physicalGpioDenialRefused":True,
            "closedSessionRefusedOldCredential":True,"persistedPrivateKeys":False,"physicalBoard":False,
            "ctapTransport":"host loopback", **receipt}))
