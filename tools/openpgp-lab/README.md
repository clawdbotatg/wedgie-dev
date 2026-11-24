# GnuPG external signing bench

This test exercises GnuPG's Assuan signing interface with one disposable NIST P-256 key. GnuPG imports only the public certificate into its temporary client home. A local Assuan fixture accepts the registered keygrip and a SHA-256 digest, then forwards one approved `PKSIGN` to a second GnuPG agent acting as a mock token. Only that mock token's scratch keyring holds the private key. The client produces a real detached OpenPGP signature. GnuPG verifies the fingerprint and rejects a changed message.

From the checkout root, run the test with a local `pgvector/pgvector:pg16` image containing GnuPG and Perl:

```sh
docker run --pull=never --rm --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev \
  -v "$PWD/tools/openpgp-lab:/fixture:ro" --entrypoint /usr/bin/timeout \
  pgvector/pgvector:pg16 15 /bin/sh /fixture/verify-external-signing.sh
```

The harness uses a temporary file system and mounts the fixture source only. It checks an unknown keygrip, malformed digest length and stale digest state, plus a denied second signing operation. The command was tested with GnuPG 2.2.40.

## Device integration

The interface under test is `SIGKEY`, `SETHASH`, and `PKSIGN`. The one-shot approval and second GnuPG agent are fixtures. A Wedgie implementation needs a reviewed device request that binds the exact key and digest to an operation, presents enough context for the person reviewing it, and waits for a physical button before the secure chip signs. It also needs isolated key enrollment, policy for missing approval and disconnects, and protocol tests across supported GnuPG versions. OpenPGP card discovery, secure PIN entry, encryption and decryption, and persistent device keys are separate work.

[GnuPG Agent protocol](https://www.gnupg.org/documentation/manuals/gnupg/Agent-Protocol.html) · [GnuPG PKSIGN](https://www.gnupg.org/documentation/manuals/gnupg/Agent-PKSIGN.html)
