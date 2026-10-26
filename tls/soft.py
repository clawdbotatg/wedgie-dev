# The Trust M played by `cryptography`, for tls.py on the computer (desk.py, test_tls.py).
import os
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature, Prehashed
from cryptography.hazmat.primitives import hashes, serialization


class Soft:
    def random(self, n):
        return os.urandom(n)

    def keyshare(self):
        self.k = ec.generate_private_key(ec.SECP256R1())
        return self.k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)

    def shared(self, peer):
        return self.k.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), bytes(peer)))

    def verify(self, curve, d, r, s, pub):
        c = ec.SECP256R1() if curve == 3 else ec.SECP384R1()
        h = hashes.SHA256() if len(d) == 32 else hashes.SHA384()
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(c, bytes(pub)).verify(encode_dss_signature(r, s), bytes(d), ec.ECDSA(Prehashed(h)))
            return True
        except Exception:
            return False
