# GnuPG on a virtual Wedgie

This test delegates NIST P-256 key generation and signing from GnuPG to a disposable cartridge on the RP2040 emulator. The cartridge calls the stock MicroPython `optiga.Chip` to generate its key in a volatile Trust M session and to sign through simulated I²C. The simulator applies physical-button input after each on-device prompt. The cartridge returns only a public point and signatures.

GnuPG builds its own OpenPGP certificate. Two authorized signatures certify and create its revocation certificate, and the third signs a test message. A new GnuPG home imports only the public certificate and verifies the detached signature. The test checks that modified text and a fourth signing request are refused. All three signatures are independently checked against the generated public key. The fixture checks the virtual chip's persistent key slots and both GnuPG homes for unintended private-key writes.

Run from the checkout root with an emulator checkout that includes the volatile Trust M ECC signing fix and its local Node and LittleFS dependencies. The Docker image must already be available locally.

```sh
UV_OFFLINE=1 uv run --with 'mpy-cross==1.29.0.post2' \
  python -B tools/openpgp-lab/virtual/run_fixture.py /path/to/emulator-checkout /tmp/openpgp-virtual-test.log
```

This proof targets GnuPG 2.2.40. It communicates over a disposable Unix socket inside a no-network container, with a scratch mailbox for the emulator. A desktop or physical version needs independent key enrollment, a reviewed digest and operation binding, local peer authentication, PIN policy, and safe card lifecycle behavior. The emulator test exercises the real firmware signing interface and the OpenPGP packet result. Hardware card discovery, live decryption, and device credential persistence remain separate work.
