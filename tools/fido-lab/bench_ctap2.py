"""CTAP2 subset for disposable credentials on reserved test RPs."""

from hashlib import sha256
from secrets import token_bytes
from struct import error as StructError

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fido2 import cbor
from fido2.cose import ES256
from fido2.ctap import CtapError
from fido2.webauthn import AttestedCredentialData, AuthenticatorData

from credential_store import BENCH_RPS, Credential, CredentialStore, StoreIntegrityError
from pin_uv_fixture import PK_ASSERTION, PK_REGISTRATION, field as require_field


RP_ID = "localhost"
RP_HASH = sha256(RP_ID.encode()).digest()
MAX_REQUEST = 1024
MAKE_CREDENTIAL = 0x01
GET_ASSERTION = 0x02
GET_INFO = 0x04
CLIENT_PIN = 0x06
ERR = CtapError.ERR


def credential_ids(request, field):
    if field not in request:
        return None
    entries = require_field(request, field, list)
    ids = []
    for entry in entries:
        if type(entry) is not dict:
            raise CtapError(ERR.CBOR_UNEXPECTED_TYPE)
        if require_field(entry, "type", str) == "public-key":
            ids.append(require_field(entry, "id", bytes))
    return ids


def require_options(request, field, registration=False):
    if field in request:
        options = require_field(request, field, dict)
        for key, value in options.items():
            if type(key) is not str or type(value) is not bool:
                raise CtapError(ERR.CBOR_UNEXPECTED_TYPE)
        supported = {"rk", "up", "uv"} if registration else {"up", "uv"}
        if options.keys() - supported:
            raise CtapError(ERR.UNSUPPORTED_OPTION)
    else:
        options = {}
    if options.get("uv", False) or not options.get("up", True):
        raise CtapError(ERR.INVALID_OPTION)
    if registration and options.get("rk") is not True:
        raise CtapError(ERR.UNSUPPORTED_OPTION)


class BenchAuthenticator:
    """Discoverable ES256 credentials with explicit test presence."""

    def __init__(self, user_presence, store=None, *, rp_ids=(RP_ID,), pin=None):
        self.user_presence = user_presence
        self._rps = frozenset(rp_ids)
        if not self._rps or self._rps - BENCH_RPS:
            raise ValueError("Expected reserved fixture RPs")
        self._store = CredentialStore() if store is None else store
        self._pin = pin

    def handle(self, payload):
        """Return a CTAP status byte followed by canonical CBOR on success."""
        try:
            response = self._dispatch(payload)
            return b"\x00" if response is None else b"\x00" + cbor.encode(response)
        except CtapError as error:
            return bytes((error.code,))
        except StoreIntegrityError:
            return bytes((ERR.INTEGRITY_FAILURE,))

    def _dispatch(self, payload):
        if not 1 <= len(payload) <= MAX_REQUEST:
            raise CtapError(ERR.INVALID_LENGTH)
        command, data = payload[0], payload[1:]
        if command == GET_INFO:
            if data:
                raise CtapError(ERR.INVALID_LENGTH)
            info = {1: ["FIDO_2_0"], 3: bytes(16), 4: {"rk": True, "up": True},
                    5: MAX_REQUEST, 9: ["usb"], 10: [{"type": "public-key", "alg": ES256.ALGORITHM}]}
            if self._pin is not None:
                info[1].insert(0, "FIDO_2_1")
                info[4].update(self._pin.options())
                info[6] = [2]
            return info
        if command not in (MAKE_CREDENTIAL, GET_ASSERTION) and (command != CLIENT_PIN or self._pin is None):
            raise CtapError(ERR.INVALID_COMMAND)
        try:
            request = cbor.decode(data)
            canonical = cbor.encode(request)
        except (ValueError, TypeError, IndexError, RecursionError, StructError):
            raise CtapError(ERR.INVALID_CBOR) from None
        if canonical != data:
            raise CtapError(ERR.INVALID_CBOR)
        if type(request) is not dict or any(type(key) is not int for key in request):
            raise CtapError(ERR.CBOR_UNEXPECTED_TYPE)
        if command == CLIENT_PIN:
            return self._pin.handle(request, self._rps)
        if command == MAKE_CREDENTIAL:
            return self._register(request)
        return self._authenticate(request)

    def _require_presence(self, operation, rp):
        if self.user_presence(operation, rp) is not True:
            raise CtapError(ERR.OPERATION_DENIED)

    def _verification_flags(self, request, rp, digest, permission, auth_index, proto_index):
        flags = AuthenticatorData.FLAG.UP
        if self._pin is not None:
            self._pin.authorize(rp, permission, digest, request, auth_index, proto_index)
            flags |= AuthenticatorData.FLAG.UV
        elif auth_index in request or proto_index in request:
            raise CtapError(ERR.UNSUPPORTED_OPTION)
        return flags

    def _register(self, request):
        client_hash = require_field(request, 1, bytes)
        rp = require_field(request, 2, dict)
        user = require_field(request, 3, dict)
        parameters = require_field(request, 4, list)
        user_id = require_field(user, "id", bytes)
        if len(client_hash) != 32 or not 1 <= len(user_id) <= 64:
            raise CtapError(ERR.INVALID_LENGTH)
        rp_id = require_field(rp, "id", str)
        if rp_id not in self._rps:
            raise CtapError(ERR.OPERATION_DENIED)
        if 10 in request:
            raise CtapError(ERR.UNSUPPORTED_OPTION)
        if not any(type(item) is dict and item.get("type") == "public-key"
                   and item.get("alg") == ES256.ALGORITHM for item in parameters):
            raise CtapError(ERR.UNSUPPORTED_ALGORITHM)
        require_options(request, 7, registration=True)
        excluded = credential_ids(request, 5)
        self._verification_flags(request, rp_id, client_hash, PK_REGISTRATION, 8, 9)
        self._require_presence("register", rp_id)
        flags = self._verification_flags(request, rp_id, client_hash, PK_REGISTRATION, 8, 9)

        key = ec.generate_private_key(ec.SECP256R1())
        credential = Credential(token_bytes(32), user_id, key)
        credential_data = AttestedCredentialData.create(
            bytes(16), credential.id, ES256.from_cryptography_key(key.public_key()))
        auth_data = AuthenticatorData.create(
            sha256(rp_id.encode()).digest(), flags | AuthenticatorData.FLAG.AT, 0, credential_data)
        signature = key.sign(auth_data + client_hash, ec.ECDSA(hashes.SHA256()))
        self._store.enroll(rp_id, credential, excluded)
        return {1: "packed", 2: bytes(auth_data), 3: {"alg": ES256.ALGORITHM, "sig": signature}}

    def _authenticate(self, request):
        rp = require_field(request, 1, str)
        client_hash = require_field(request, 2, bytes)
        if len(client_hash) != 32:
            raise CtapError(ERR.INVALID_LENGTH)
        require_options(request, 5)
        allowed = credential_ids(request, 3)
        if rp not in self._rps:
            raise CtapError(ERR.NO_CREDENTIALS)
        self._verification_flags(request, rp, client_hash, PK_ASSERTION, 6, 7)
        credential = self._store.get(rp)
        if credential is None or (allowed is not None and credential.id not in allowed):
            raise CtapError(ERR.NO_CREDENTIALS)

        self._require_presence("authenticate", rp)
        flags = self._verification_flags(request, rp, client_hash, PK_ASSERTION, 6, 7)
        credential = self._store.advance(rp, credential.id)
        auth_data = AuthenticatorData.create(sha256(rp.encode()).digest(), flags, credential.counter)
        signature = credential.key.sign(auth_data + client_hash, ec.ECDSA(hashes.SHA256()))
        return {1: {"type": "public-key", "id": credential.id}, 2: bytes(auth_data),
                3: signature, 4: {"id": credential.user_id}}
