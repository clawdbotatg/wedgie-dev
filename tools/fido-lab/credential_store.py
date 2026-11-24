"""Disposable profile storage and a mock secure element for the CTAP2 bench."""

from dataclasses import dataclass, replace
from hashlib import sha256
from hmac import compare_digest
import os
from pathlib import Path
from secrets import token_bytes
from tempfile import NamedTemporaryFile
from threading import RLock

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fido2 import cbor
from fido2.ctap import CtapError
from pin_uv_fixture import MockPinState


ERR = CtapError.ERR
BENCH_RPS = frozenset({"localhost", "alpha.invalid", "beta.invalid"})
NONCE_SIZE = 12
MAX_BLOB = 4096
LABEL = b"wedgie-fido-bench-1\0"


class StoreIntegrityError(Exception):
    """The trusted head could not be read or published."""


@dataclass(frozen=True)
class Credential:
    id: bytes
    user_id: bytes
    key: ec.EllipticCurvePrivateKey
    counter: int = 0


class MockSecureElement:
    """Keep the wrapping key and trusted commit head outside the backing files."""

    def __init__(self):
        self.lock = RLock()
        self.head = (0, b"")
        self.pin = MockPinState(self.lock)
        self._aead = AESGCM(AESGCM.generate_key(bit_length=256))

    def seal(self, generation, plaintext):
        nonce = token_bytes(NONCE_SIZE)
        return nonce + self._aead.encrypt(nonce, plaintext, LABEL + generation.to_bytes(8, "big"))

    def unseal(self, generation, sealed):
        return self._aead.decrypt(sealed[:NONCE_SIZE], sealed[NONCE_SIZE:], LABEL + generation.to_bytes(8, "big"))

    def commit(self, expected_generation, digest):
        if self.head[0] != expected_generation:
            raise StoreIntegrityError("Stale commit")
        self.head = (expected_generation + 1, digest)


class CredentialStore:
    """One fixture credential per RP with optional sealed backing files."""

    def __init__(self, directory=None, element=None):
        if (directory is None) != (element is None):
            raise ValueError("A sealed store requires a scratch directory and mock element")
        if element is not None and not isinstance(element, MockSecureElement):
            raise TypeError("The bench uses a mock secure element")
        self._directory = None if directory is None else Path(directory)
        self._element = element
        self._lock = RLock() if element is None else element.lock
        self._records = {}

    def get(self, rp):
        with self._lock:
            return self._load().get(rp)

    def enroll(self, rp, credential, excluded):
        if rp not in BENCH_RPS:
            raise ValueError("Expected a reserved fixture RP")
        with self._lock:
            records = self._load()
            existing = records.get(rp)
            if existing is not None:
                if excluded and existing.id in excluded:
                    raise CtapError(ERR.CREDENTIAL_EXCLUDED)
                raise CtapError(ERR.KEY_STORE_FULL)
            records[rp] = credential
            self._save(records)

    def advance(self, rp, credential_id):
        with self._lock:
            records = self._load()
            existing = records.get(rp)
            if existing is None or existing.id != credential_id:
                raise CtapError(ERR.NO_CREDENTIALS)
            if existing.counter == 0xFFFFFFFF:
                raise CtapError(ERR.KEY_STORE_FULL)
            advanced = replace(existing, counter=existing.counter + 1)
            records[rp] = advanced
            self._save(records)
            return advanced

    def _path(self, generation):
        return self._directory / f"credentials.{generation % 2}.sealed"

    def _read(self, path):
        with path.open("rb") as stream:
            sealed = stream.read(MAX_BLOB + 1)
        if not NONCE_SIZE + 16 <= len(sealed) <= MAX_BLOB:
            raise StoreIntegrityError("Bad sealed record length")
        return sealed

    def _load(self):
        if self._element is None:
            return self._records.copy()
        generation, digest = self._element.head
        try:
            if generation == 0:
                if self._path(0).exists():
                    raise StoreIntegrityError("Unexpected sealed state for an empty element")
                if self._path(1).exists():
                    # A first write may reach disk before the trusted commit.
                    self._element.unseal(1, self._read(self._path(1)))
                return {}
            sealed = self._read(self._path(generation))
            if not compare_digest(sha256(sealed).digest(), digest):
                raise StoreIntegrityError("Sealed state does not match the committed head")
            records = cbor.decode(self._element.unseal(generation, sealed))
            if not isinstance(records, dict) or records.keys() - BENCH_RPS:
                raise StoreIntegrityError("Unexpected credential records")
            result = {}
            for rp, fields in records.items():
                identifier, user_id, key_der, counter = fields
                key = serialization.load_der_private_key(key_der, password=None)
                if (not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1)
                        or type(identifier) is not bytes or len(identifier) != 32
                        or type(user_id) is not bytes or not 1 <= len(user_id) <= 64
                        or type(counter) is not int or not 0 <= counter <= 0xFFFFFFFF):
                    raise StoreIntegrityError("Invalid credential fields")
                result[rp] = Credential(identifier, user_id, key, counter)
            return result
        except (InvalidTag, OSError, ValueError, TypeError) as error:
            raise StoreIntegrityError("Could not open sealed credentials") from error

    def _save(self, records):
        if self._element is None:
            self._records = records
            return
        generation = self._element.head[0]
        plaintext = cbor.encode({rp: [credential.id, credential.user_id, credential.key.private_bytes(
            serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
            credential.counter] for rp, credential in records.items()})
        sealed = self._element.seal(generation + 1, plaintext)
        try:
            with NamedTemporaryFile(dir=self._directory, delete=False) as temporary:
                path = Path(temporary.name)
                try:
                    temporary.write(sealed)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    os.replace(path, self._path(generation + 1))
                finally:
                    path.unlink(missing_ok=True)
            directory_fd = os.open(self._directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            self._element.commit(generation, sha256(sealed).digest())
        except OSError as error:
            raise StoreIntegrityError("Could not write sealed credentials") from error
