"""Test-only CTAP2 ClientPIN protocol 2 with scoped authorization tokens."""

from dataclasses import dataclass
from hashlib import sha256
from hmac import compare_digest
from secrets import token_bytes
from time import monotonic

from cryptography.hazmat.primitives.asymmetric import ec
from fido2.ctap import CtapError
from fido2.ctap2 import ClientPin
from fido2.ctap2.pin import PinProtocolV2


ERR = CtapError.ERR
PK_REGISTRATION = int(ClientPin.PERMISSION.MAKE_CREDENTIAL)
PK_ASSERTION = int(ClientPin.PERMISSION.GET_ASSERTION)
RETRIES = 8
POWER_CYCLE_LIMIT = 3
TOKEN_SECONDS = 30


class MockPinState:
    """Keep the test PIN verifier and retry counters with the mock element."""

    def __init__(self, lock):
        self.lock = lock
        self.pin_hash = None
        self.retries = RETRIES
        self.consecutive = 0
        self.boot = 0

    def power_cycle(self):
        with self.lock:
            self.boot += 1
            self.consecutive = 0


@dataclass(frozen=True)
class Token:
    secret: bytes
    relying_party: str
    permissions: int
    expires: float


def field(request, key, kind, size=None):
    if key not in request:
        raise CtapError(ERR.MISSING_PARAMETER)
    value = request[key]
    if type(value) is not kind:
        raise CtapError(ERR.CBOR_UNEXPECTED_TYPE)
    if size is not None and len(value) != size:
        raise CtapError(ERR.INVALID_LENGTH)
    return value


class PinUvFixture:
    def __init__(self, state, clock=monotonic):
        self._state = state
        self._clock = clock
        self._protocol = PinProtocolV2()
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._token = None
        with state.lock:
            state.boot += 1
            self._boot = state.boot

    def _check(self):
        state = self._state
        if self._boot != state.boot:
            raise CtapError(ERR.PIN_AUTH_INVALID)
        if (state.pin_hash is not None and (type(state.pin_hash) is not bytes or len(state.pin_hash) != 16)
                or type(state.retries) is not int or not 0 <= state.retries <= RETRIES
                or type(state.consecutive) is not int or not 0 <= state.consecutive <= POWER_CYCLE_LIMIT):
            raise CtapError(ERR.INTEGRITY_FAILURE)

    def options(self):
        with self._state.lock:
            self._check()
            return {"clientPin": self._state.pin_hash is not None, "pinUvAuthToken": True}

    def handle(self, request, allowed_rps):
        with self._state.lock:
            self._check()
            if field(request, 1, int) != self._protocol.VERSION:
                raise CtapError(ERR.INVALID_PARAMETER)
            command = field(request, 2, int)
            if command == ClientPin.CMD.GET_PIN_RETRIES:
                return {3: self._state.retries, 4: self._state.consecutive >= POWER_CYCLE_LIMIT}
            if command == ClientPin.CMD.GET_KEY_AGREEMENT:
                point = self._key.public_key().public_numbers()
                return {1: {1: 2, 3: -25, -1: 1, -2: point.x.to_bytes(32, "big"), -3: point.y.to_bytes(32, "big")}}
            if command == ClientPin.CMD.SET_PIN:
                return self._set_pin(request)
            if command == ClientPin.CMD.CHANGE_PIN:
                return self._change_pin(request)
            if command == ClientPin.CMD.GET_TOKEN_USING_PIN:
                return self._get_token(request, allowed_rps)
            raise CtapError(ERR.INVALID_SUBCOMMAND)

    def _shared_secret(self, request):
        cose = field(request, 3, dict)
        if any(type(cose.get(key)) is not int or cose[key] != expected for key, expected in ((1, 2), (3, -25), (-1, 1))):
            raise CtapError(ERR.INVALID_PARAMETER)
        x = int.from_bytes(field(cose, -2, bytes, 32), "big")
        y = int.from_bytes(field(cose, -3, bytes, 32), "big")
        try:
            peer = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
        except ValueError:
            raise CtapError(ERR.INVALID_PARAMETER) from None
        return self._protocol.kdf(self._key.exchange(ec.ECDH(), peer))

    def _set_pin(self, request):
        if self._state.pin_hash is not None:
            raise CtapError(ERR.PIN_AUTH_INVALID)
        secret = self._shared_secret(request)
        encrypted = field(request, 5, bytes, 80)
        auth = field(request, 4, bytes, 32)
        if not compare_digest(auth, self._protocol.authenticate(secret, encrypted)):
            raise CtapError(ERR.PIN_AUTH_INVALID)
        self._state.pin_hash = self._new_pin_hash(secret, encrypted)
        return None

    def _new_pin_hash(self, secret, encrypted):
        raw = self._protocol.decrypt(secret, encrypted)
        pin, delimiter, padding = raw.partition(b"\x00")
        try:
            valid_length = len(pin.decode("utf8")) >= 4
        except UnicodeDecodeError:
            valid_length = False
        if not valid_length or not delimiter or any(padding):
            raise CtapError(ERR.PIN_POLICY_VIOLATION)
        return sha256(pin).digest()[:16]

    def _check_pin_available(self):
        state = self._state
        if state.pin_hash is None:
            raise CtapError(ERR.PIN_NOT_SET)
        if state.retries == 0:
            raise CtapError(ERR.PIN_BLOCKED)
        if state.consecutive >= POWER_CYCLE_LIMIT:
            raise CtapError(ERR.PIN_AUTH_BLOCKED)

    def _verify_current_pin(self, secret, encrypted):
        state = self._state
        pin_hash = self._protocol.decrypt(secret, encrypted)
        if not compare_digest(pin_hash, state.pin_hash):
            self._token = None
            self._key = ec.generate_private_key(ec.SECP256R1())
            state.retries -= 1
            state.consecutive += 1
            if state.retries == 0:
                raise CtapError(ERR.PIN_BLOCKED)
            if state.consecutive >= POWER_CYCLE_LIMIT:
                raise CtapError(ERR.PIN_AUTH_BLOCKED)
            raise CtapError(ERR.PIN_INVALID)
        state.retries = RETRIES
        state.consecutive = 0

    def _change_pin(self, request):
        self._check_pin_available()
        secret = self._shared_secret(request)
        new_pin = field(request, 5, bytes, 80)
        current = field(request, 6, bytes, 32)
        auth = field(request, 4, bytes, 32)
        if not compare_digest(auth, self._protocol.authenticate(secret, new_pin + current)):
            raise CtapError(ERR.PIN_AUTH_INVALID)
        self._verify_current_pin(secret, current)
        self._state.pin_hash = self._new_pin_hash(secret, new_pin)
        self._token = None
        return None

    def _get_token(self, request, allowed_rps):
        self._check_pin_available()
        permissions = field(request, 9, int)
        rp = field(request, 10, str)
        if not permissions or permissions & ~(PK_REGISTRATION | PK_ASSERTION) or rp not in allowed_rps:
            raise CtapError(ERR.UNAUTHORIZED_PERMISSION)
        secret = self._shared_secret(request)
        self._verify_current_pin(secret, field(request, 6, bytes, 32))
        self._token = Token(token_bytes(32), rp, permissions, self._clock() + TOKEN_SECONDS)
        return {2: self._protocol.encrypt(secret, self._token.secret)}

    def authorize(self, rp, permission, digest, request, param_index, protocol_index):
        with self._state.lock:
            self._check()
            if self._state.pin_hash is None:
                raise CtapError(ERR.PIN_NOT_SET)
            token = self._token
            if param_index not in request or protocol_index not in request or token is None:
                raise CtapError(ERR.PUAT_REQUIRED)
            if field(request, protocol_index, int) != self._protocol.VERSION:
                raise CtapError(ERR.PIN_AUTH_INVALID)
            param = field(request, param_index, bytes, 32)
            if self._clock() >= token.expires:
                self._token = None
                raise CtapError(ERR.PIN_TOKEN_EXPIRED)
            if token.relying_party != rp or not (token.permissions & permission):
                raise CtapError(ERR.UNAUTHORIZED_PERMISSION)
            if not compare_digest(param, self._protocol.authenticate(token.secret, digest)):
                raise CtapError(ERR.PIN_AUTH_INVALID)
