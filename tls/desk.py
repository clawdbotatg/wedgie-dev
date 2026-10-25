# tls.py on the computer: real sockets, the Trust M played by `cryptography`.
import socket, sys, time, os
sys.path.insert(0, os.path.dirname(__file__))
import tls, roots
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature, Prehashed
from cryptography.hazmat.primitives import hashes
tls.ROOTS = {k: v for k, v in roots.ROOTS.items()}

class Soft:
    def random(self, n): return os.urandom(n)
    def keyshare(self):
        self.k = ec.generate_private_key(ec.SECP256R1())
        from cryptography.hazmat.primitives import serialization as s
        return self.k.public_key().public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint)
    def shared(self, peer):
        return self.k.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), peer))
    def verify(self, curve, d, r, s, pub):
        c = ec.SECP256R1() if curve == 3 else ec.SECP384R1()
        h = hashes.SHA256() if len(d) == 32 else hashes.SHA384()
        try:
            ec.EllipticCurvePublicKey.from_encoded_point(c, pub).verify(encode_dss_signature(r, s), d, ec.ECDSA(Prehashed(h)))
            return True
        except Exception: return False

host, path = sys.argv[1], sys.argv[2]
s = socket.create_connection((host, 443))
t = time.time()
c = tls.Conn(host, s.sendall, lambda: s.recv(4096), chip=Soft(), log=lambda m: print(" ", m, round(time.time() - t, 2)))
print(c.get(path)[:300], c.status)
