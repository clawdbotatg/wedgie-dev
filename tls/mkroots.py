# The roots Mozilla trusts for websites (certifi's bundle) -> roots.bin for tls.py: per root sha256(subject DER)[:12],
# its kind (3 P-256, 4 P-384: the key 04 X Y; 16 RSA: 2 bytes of length, then the RSAPublicKey DER). Not the Mac's
# store: it has roots trusted only for email or code signing.
#   uv run --with certifi --with cryptography python3 mkroots.py ../firmware/roots.bin
import sys, hashlib, warnings
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives import serialization
warnings.simplefilter("ignore")
out, names = b"", []
import certifi
for c in x509.load_pem_x509_certificates(open(certifi.where(), "rb").read()):
    k = c.public_key()
    if isinstance(k, rsa.RSAPublicKey) and k.key_size >= 2048:
        der = k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.PKCS1)
        out += hashlib.sha256(c.subject.public_bytes()).digest()[:12] + b"\x10" + len(der).to_bytes(2, "big") + der
    elif isinstance(k, ec.EllipticCurvePublicKey) and k.curve.name in ("secp256r1", "secp384r1"):
        out += hashlib.sha256(c.subject.public_bytes()).digest()[:12] + bytes([3 if k.curve.name == "secp256r1" else 4])
        out += k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    else:
        continue
    names.append(c.subject.rfc4514_string())
open(sys.argv[1], "wb").write(out)
print(len(names), "roots,", len(out), "bytes")

