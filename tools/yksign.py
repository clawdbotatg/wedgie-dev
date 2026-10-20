#!/usr/bin/env python3
"""The YubiKey half of the release keys (tools/sign.mjs): signs stdin with the P-256 key in its PIV
signature slot (9c, made there: it can't be copied off). Asks for the PIN in the terminal you run it in
(never a pop-up: any program can draw one, Austin 10-19), then wants a touch. Prints "r s" in hex.
    node tools/sign.mjs --yubikey      in your own Terminal: it runs this after the gate"""
import sys, getpass
from ykman.device import list_all_devices
from yubikit.core.smartcard import SmartCardConnection
from yubikit.piv import PivSession, SLOT, KEY_TYPE
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

data = sys.stdin.buffer.read()
devs = list_all_devices()
if not devs:
    sys.exit("yksign: no YubiKey plugged in")
try:
    open("/dev/tty").close()                 # a terminal to ask in? (stdin is the text being signed)
except OSError:
    sys.exit("yksign: needs a terminal to ask the PIN in (run node tools/sign.mjs --yubikey in Terminal)")
pin = getpass.getpass("YubiKey PIN: ")       # reads /dev/tty itself; open(.., "w+") on a tty never worked (not seekable)
if not pin:
    sys.exit("yksign: no PIN")
with devs[0][0].open_connection(SmartCardConnection) as c:
    p = PivSession(c)
    p.verify_pin(pin)
    sys.stderr.write("touch the YubiKey\n")
    r, s = decode_dss_signature(p.sign(SLOT.SIGNATURE, KEY_TYPE.ECCP256, data, hashes.SHA256()))
print("%064x %064x" % (r, s))
