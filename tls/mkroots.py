# ECC roots from the Mac's system store -> a Python dict literal for tls.ROOTS
import sys
from cryptography import x509
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
pem = open(sys.argv[1], "rb").read()
out = {}
for c in x509.load_pem_x509_certificates(pem):
    k = c.public_key()
    if not isinstance(k, ec.EllipticCurvePublicKey) or k.curve.name not in ("secp256r1", "secp384r1"):
        continue
    out[c.subject.public_bytes()] = (3 if k.curve.name == "secp256r1" else 4, k.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint), c.subject.rfc4514_string())
print("ROOTS = {")
for s, (cv, p, name) in out.items():
    print(f"    # {name}\n    {s!r}: ({cv}, {p!r}),")
print("}")
print(len(out), "roots", file=sys.stderr)
