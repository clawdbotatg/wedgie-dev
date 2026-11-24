# FIDO USB bench lab

This lab tests a FIDO HID interface against the Wedgie `usbdev` module. The interface tests run with an in-process USB controller. The independent CTAP2 fixture defaults to one disposable `localhost` credential in memory. It also has a sealed storage fixture for two reserved test RPs and an opt-in protocol 2 PIN test. All use a simulated presence callback and software ES256.

From the checkout root, run:

```sh
python3 -B tools/fido-lab/verify-ctaphid.py
uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/test_bench_ctap2.py
WEDGIE_FIRMWARE="$PWD/firmware" \
  uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/test_fido_usb.py
uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/test_sealed_credentials.py
uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/test_pin_uv.py
```

The packet tests cover discoverable credential registration and assertion with a WebAuthn verifier, packed self-attestation, denial of missing presence and wrong RP, malformed CBOR, and expected counter changes. The controller tests drive the real `usbdev` interface and endpoint callbacks with a synthetic CDC descriptor and storage interface. They cover descriptor composition, FIDO HID report discovery, CTAP2 GetInfo, fragmented PING, short transfers, timeout, USB reset, and failed transfer submission.

## Sealed fixture credentials

The host fixture uses one discoverable credential each for `alpha.invalid` and `beta.invalid`. It recreates the CTAP2 and store objects around the same mock secure element. That element keeps an AES-GCM key and the committed generation and digest in memory, separate from the two alternating backing files. Each file authenticates its generation. A write syncs the new file and directory before advancing the trusted head, so an interrupted write leaves the previous head readable. Tests check both initial enrollment and interrupted counter updates, wrong RP and wrong element, a corrupted or older slot, independent RP keys, and fresh approval after reopen.

The mock element and software P-256 keys live in the test process. A restart of that process discards the mock element. The fixture models the storage contract for a real element with protected wrapping keys and rollback-resistant state. Before a hardware implementation, qualify those capabilities, the counter endurance and recovery behavior, and how to keep credential private keys inside the hardware boundary.

## PIN and user verification

The opt-in bench uses Yubico's protocol 2 key derivation, encryption, and authentication, exercised by its real `ClientPin` over CTAPHID packets. PIN setup verifies the authenticated encrypted PIN. PIN tokens last 30 seconds and are bound to one reserved RP and registration or assertion permissions. The bench requires a matching token before it asks for simulated presence and checks it again after approval. The WebAuthn server verifies a registration and assertion with user verification required.

The simulated secure element retains the test PIN verifier and the eight-attempt limit when the authenticator reopens. Three consecutive failures require a simulated power cycle. The total retry count survives that cycle, and successful PIN verification restores the retry budget. PIN changes use the same retry budget as token requests. A successful change invalidates existing tokens and preserves enrolled credentials. Reopening invalidates active tokens, and storage corruption causes the operation to fail. Host process exit discards all mock state. PIN reset and hardware-backed PIN and retry storage remain separate milestones. The previously built Pico UF2 remains a transport-only probe.

## Spare-board transport wiring

On a dedicated disposable MicroPython Pico build, a boot harness can configure the interface alongside built-in CDC and call `hid.poll()` from its main loop. The transport-only factory below advertises FIDO HID framing with INIT and PING and has no credential operations. This example is a wiring reference. Physical enumeration and OS behavior remain the next checks.

```python
import usbdev
from ctaphid import Transport
from fido_usb import FidoHid
from os import urandom
from time import ticks_diff, ticks_ms

hid = FidoHid(lambda: Transport(lambda: urandom(4), ticks_ms, ticks_diff))
usbdev.get().init(hid, builtin_driver=True)
# Call hid.poll() from the bench main loop after boot.
```

Check that the host sees both CDC and FIDO HID after cold boot and reset. Verify INIT and PING before adding a credential implementation. Physical WebAuthn needs asynchronous user presence with cancel and keepalive, PIN or another user verification method, protected per-site storage, and a reviewed reset and recovery lifecycle. Test those on separate hardware with disposable credentials.

Build the transport probe from the local stock `RPI_PICO.uf2`, using the Pico LittleFS layout:

```sh
uv run --with 'mpy-cross==1.29.0.post2' --with 'littlefs-python==0.19.0' \
  python -B tools/fido-lab/build_transport_probe.py /tmp/spare-pico-fido-transport-only.uf2
node tools/fido-lab/test_transport_probe.mjs /tmp/spare-pico-fido-transport-only.uf2
```

This image replaces the filesystem of a spare RP2040 Pico. It contains the CDC and HID probe, with INIT and PING only. To exercise the exact image through the python-fido2 host implementation, run:

```sh
uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/probe_native_hid.py \
  --emulator-uf2 /tmp/spare-pico-fido-transport-only.uf2
```

After flashing the transport probe to a disposable Pico and confirming its USB serial, use the same host client with the operating system's HID backend:

```sh
uv run --with 'fido2==2.2.1' --with 'cryptography==50.0.2' \
  python -B tools/fido-lab/probe_native_hid.py --usb-serial '<spare-Pico serial>'
```

The native probe checks that exactly one HID interface matches the bench product and serial before opening it. The client checks the INIT nonce, PING across report boundaries, and refusal of CTAP2 GetInfo. The emulator can verify those exchanges before hardware enumeration is available.

[FIDO Alliance CTAP USB transport](https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#usb) · [MicroPython USBDevice](https://docs.micropython.org/en/v1.29.0/library/machine.USBDevice.html) · [Yubico Python FIDO](https://github.com/Yubico/python-fido2) · [UF2 format](https://github.com/microsoft/uf2)
