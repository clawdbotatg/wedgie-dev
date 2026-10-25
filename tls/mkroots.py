# ECC roots (P-256, P-384) from a PEM bundle -> roots.bin for tls.py: per root sha256(subject DER)[:12],
# the curve (3 P-256, 4 P-384) and its key (04 X Y).
#   security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > r.pem
#   python3 mkroots.py r.pem roots.bin
import sys, hashlib, warnings
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
warnings.simplefilter("ignore")
out, names = b"", []
for c in x509.load_pem_x509_certificates(open(sys.argv[1], "rb").read()):
    k = c.public_key()
    if not isinstance(k, ec.EllipticCurvePublicKey) or k.curve.name not in ("secp256r1", "secp384r1"):
        continue
    out += hashlib.sha256(c.subject.public_bytes()).digest()[:12] + bytes([3 if k.curve.name == "secp256r1" else 4])
    out += k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    names.append(c.subject.rfc4514_string())
open(sys.argv[2], "wb").write(out)
print(len(names), "roots,", len(out), "bytes")
