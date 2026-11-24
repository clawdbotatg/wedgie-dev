# KeePassXC and virtual Trust M

The RP2040 emulator starts stock MicroPython with a disposable vault fixture.
The firmware creates a volatile P-256 key in E102, keeps its ECDH shared
coordinate in E103, and uses the Trust M TLS 1.2 PRF to derive a 32-byte
key for one fixture vault context.

The cartridge asks for physical approval before starting the chip session.
The emulator checks that a synthetic USB press leaves the prompt pending
and that red returns a refusal without key material. A fresh boot and green
GPIO press allow the disposable derivation to run.

An independent OpenSSL ECDH and HMAC-SHA256 reference checks each
derivation. The fixture also checks session reset and compares persistent
chip state before and after. KeePassXC opens a newly created dummy database
with the virtual device-derived bytes supplied through an unnamed descriptor.
It rejects a different device and vault context and opens with the disposable
recovery reference. The temporary vault and key files are removed.

With the repository's Node dependencies, cached LittleFS tooling and
KeePassXC CLI installed, run from the checkout root:

```sh
UV_OFFLINE=1 node tools/vault-lab/test-vault.mjs NEW_RESULT_JSON
```

Set `KEEPASSXC_CLI` for a custom CLI path. The fixture generates a temporary
peer key in the harness and uses only volatile chip slots. A persistent vault
on a physical device needs separate key enrollment, physical approval, and
recovery qualification. KeePassXC receives the derived key during unlock,
so that step depends on host security.
