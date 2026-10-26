# ECC roots (P-256, P-384) Mozilla trusts for websites (certifi's bundle) -> roots.bin for tls.py: per root
# sha256(subject DER)[:12], the curve (3 P-256, 4 P-384) and its key (04 X Y). Not the Mac's store: it has roots
# trusted only for email or code signing.
#   uv run --with certifi --with cryptography python3 mkroots.py ../firmware/roots.bin
import sys, hashlib, warnings
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
warnings.simplefilter("ignore")
out, names = b"", []
import certifi
for c in x509.load_pem_x509_certificates(open(certifi.where(), "rb").read()):
    k = c.public_key()
    if not isinstance(k, ec.EllipticCurvePublicKey) or k.curve.name not in ("secp256r1", "secp384r1"):
        continue
    out += hashlib.sha256(c.subject.public_bytes()).digest()[:12] + bytes([3 if k.curve.name == "secp256r1" else 4])
    out += k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    names.append(c.subject.rfc4514_string())
open(sys.argv[1], "wb").write(out)
print(len(names), "roots,", len(out), "bytes")
print("\n".join(names))
