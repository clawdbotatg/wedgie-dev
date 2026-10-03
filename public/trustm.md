---
name: wedgie-trustm
description: Use the OPTIGA Trust M secure chip on a wedgie from an app (firmware/optiga.py) - keys that never leave the chip, ECDSA and RSA signatures, signature checks, ECDH shared secrets, key derivation, SHA-256, true random numbers, monotonic counters, protected storage, RSA encryption, AES and HMAC on V3 chips. Use for "sign with the wedgie", "make a key on the chip", "store a secret on the wedgie", "a counter that can't go back", "use the Trust M". Covers every call with examples, what each returns, timings measured on a real chip, errors, and the few calls that can lock the chip forever.
---

# The Trust M on a wedgie

Some wedgies have an **Infineon OPTIGA Trust M** (Adafruit 4351) wedged between the boards on I2C
(SDA GP4, SCL GP5, address 0x30). It's a small secure computer of its own: keys made inside it never
leave it, it signs and checks signatures, and it holds data and counters a program can't fake. Your app
talks to it with `optiga`, part of the wedgie firmware (0.3.17+):

```python
import optiga
c = optiga.Chip()                    # 46 ms: resets the chip's link and opens a session
c.random(32)                         # 32 true random bytes
pub = c.genkey(optiga.KEY2)          # a P-256 key pair inside the chip; you get the public key
r, s = c.sign(optiga.KEY2, digest)   # ECDSA over a 32-byte digest, 140 ms
```

Which chip does this wedgie have? `wedgie.chip()` says (or hello's `"chip"`): `"OPTIGA Trust M"` or
`"ATECC608"`. `optiga` is for the Trust M only. The emulator at wedgie.dev/code has no secure chip:
`optiga.Chip()` fails there, so test chip code on a real wedgie (`python3 wedgie.py run app.py`).

Other wedgie docs: making apps https://wedgie.dev/code.md, the hardware and USB https://wedgie.dev/skill.md

## What you should know first

- **Memory.** `import optiga` takes about 10 KB of RAM (measured, with its I2C layer). Import it when you
  need it, not at the top of a game that's already tight on memory; `del sys.modules["optiga"]` and
  `del sys.modules["trustm"]` give it back. Don't paste big data into code you send to a wedgie: build it
  there, or the wedgie runs out of memory compiling it.
- **One `Chip()` at a time**, and reuse it. Making a new one resets the chip's link (~45 ms) and
  forgets session secrets (`SESSION`).
- **Speed.** Every call waits for the chip. Measured on a real Trust M V1 on a wedgie (RP2040, 400 kHz I2C):

  | Call | Time |
  |---|---|
  | `Chip()` | 46 ms |
  | `random(32)` | 11 ms |
  | `sign` (P-256) | 140 ms |
  | `genkey` P-256 | 157 ms |
  | `verify` P-256 | 190 ms |
  | `ecdh` P-256 | 132 ms |
  | `sha256` of 1 KB | 221 ms |
  | `genkey` RSA-1024 | 3 s |
  | `genkey` RSA-2048 | 25 s (show `ui.progress`) |
  | `read` of the 485-byte certificate | 148 ms |

  Do chip work between frames or behind `ui.progress`, never once a frame.
- **Errors** raise `optiga.Error` with `.code` (the table at the end). `except optiga.Error as e:`.
- **Two chip versions.** V1 does everything here except AES, HMAC, HKDF, Brainpool and P-521 curves,
  and `aes_*`/`hmac`/`mac`; those are V3. A V1 answers them with error `0x0A` (AES, HMAC) or `0x03`
  (HKDF, the other curves). The Trust M tested so far (an Adafruit 4351, chip firmware build 0809) is a
  V1: plan for V1.
- **The security event counter.** Using a stored private key, or deriving from a stored secret, counts
  as a "security event". More than about one every 5 seconds for a while and the chip slows itself down
  (up to seconds a call). Normal use never gets there; a loop that signs as fast as it can does. While
  the count isn't 0, `hibernate()` refuses (error `0x0B`); it was back to 0 about 6 s after a few signatures.

## The chip's slots

Everything on the chip lives in an object with a 2-byte ID (OID). `optiga` names them:

| Name | OID | What | You can |
|---|---|---|---|
| `FACTORY_KEY` | E0F0 | P-256 key made at Infineon, usage Auth | sign with it, never change it |
| `CERT` | E0E0 | its certificate, signed by Infineon (~485 bytes) | read it |
| `KEY2` `KEY3` `KEY4` | E0F1-E0F3 | ECC key slots, empty from the factory | `genkey` into them, sign, ECDH |
| `RSA1` `RSA2` | E0FC-E0FD | RSA key slots | `genkey` RSA, sign, decrypt |
| `SESSION[0..3]` | E100-E103 | session keys/secrets, in RAM | `genkey`/`ecdh`/`derive` into them; gone at reset |
| `DATA[0..11]` | F1D0-F1DB | 140-byte data objects | `read`, `write` |
| `BIG_DATA[0..1]` | F1E0-F1E1 | 1500-byte data objects | `read`, `write` |
| `COUNTERS[0..3]` | E120-E123 | monotonic counters | `count`, `counter`, `set_counter` |
| `CERT2-4` | E0E1-E0E3 | your own certificates | `read`, `write` |
| `TRUST1` `TRUST2` `TRUST8` | E0E8 E0E9 E0EF | trust anchors (CA certs) for `verify(cert=)` | `read`, `write` |
| `BINDING` | E140 | 64-byte platform binding secret | (shielded connection; not used by wedgies) |
| `AES_KEY` | E200 | AES key (V3) | `aes_genkey`, `aes`, `mac` |
| `UID` `LCSG` `SEC` ... | E0C0-E0C6, F1C0-F1C2 | chip info and state | `read`, `info()` |

Who can do what to each slot is in its **metadata** (`c.metadata(oid)`). As shipped, the key slots,
data, counters and certificates are open to everyone (rule: "while its lifecycle is below
operational"). That means **any program on the wedgie can use or replace a key in KEY2-4**: the
wedgie's lock (nothing gets the REPL without an A press) is what keeps a computer from doing it.

## Every call

### Random

```python
c.random(32)              # 8-256 bytes from the true random generator (TRNG)
c.random(32, drng=True)   # from its deterministic generator (seeded from the TRNG)
```
For fair shuffles and dice, `wedgie.rand` / `rand_below` (code.md) already use this and work on both
chips.

### Keys and signatures (ECC)

```python
pub = c.genkey(optiga.KEY2)                                  # P-256, usage SIGN, kept in KEY2
pub = c.genkey(optiga.KEY3, optiga.P384, optiga.SIGN | optiga.KEY_AGREE)
pub, priv = c.genkey(None, optiga.P256)                      # exported: the chip keeps nothing
```
- `pub` is the uncompressed point: `04 || X || Y` (65 bytes for P-256, 97 for P-384).
- **Save `pub` yourself** (a save file, a `DATA` object). The chip never hands a stored key's public key
  out again. The factory key's public key is inside `CERT`.
- `genkey` into a slot **replaces** what was there. There's no undo.
- Curves: `P256`, `P384` (V1 and V3); `P521`, `BP256`, `BP384`, `BP512` (V3).
- Usage bits, OR them: `SIGN`, `AUTH`, `KEY_AGREE` (ECDH), `ENC` (RSA). A key only does what its usage says.

```python
import hashlib
d = hashlib.sha256(b"message").digest()
r, s = c.sign(optiga.KEY2, d)              # ints; the digest goes in, never the message
c.verify(d, r, s, pub)                     # True / False, on the chip
c.verify(d, r, s, pub, optiga.P384)        # other curves: say which
c.verify(d, r, s, cert=optiga.CERT2)       # check against the key in a stored certificate
```
- ECDSA over the digest as given. For P-256 hash with SHA-256 (`hashlib.sha256` or `c.sha256`).
- On a computer, `(r, s)` with `pub` verifies with any ECDSA library (Python `cryptography`:
  `encode_dss_signature(r, s)` + `ec.ECDSA(hashes.SHA256())`).
- **Ethereum needs secp256k1, which the Trust M doesn't have.** P-256 works with passkey-style smart
  accounts (RIP-7212 / P-256 verification on chain), not plain Ethereum keys.

### Shared secrets (ECDH) and key derivation

```python
mine = c.genkey(optiga.KEY3, optiga.P256, optiga.KEY_AGREE)
secret = c.ecdh(optiga.KEY3, their_pub)          # 32 bytes: the shared X coordinate
c.ecdh(optiga.KEY3, their_pub, store=optiga.SESSION[0])   # kept inside the chip instead
key = c.derive(optiga.SESSION[0], 32, b"label" + seed, method="prf256")   # TLS 1.2 PRF (V1 + V3)
key = c.derive(optiga.SESSION[0], 32, salt, info=b"app v1", method="hkdf256")  # HKDF (V3)
```
- Both sides get the same `secret` (the other side computes it with its private key and your `mine`).
- With `store=`, the secret never leaves the chip; `derive` turns it into key material (16+ bytes).
- `derive(..., store=optiga.SESSION[1])` keeps the result inside too.
- A `DATA` object can be a derive secret only if its type is "pre-shared secret" (metadata `E8 = 21`),
  which takes a metadata write: see "Calls that can lock the chip".

### Hashing

```python
c.sha256(data)                       # any length; long data goes in 264-byte parts
c.sha256_object(optiga.CERT)         # hash an object without it leaving the chip
```
`hashlib.sha256` on the RP2040 is faster for your own data; the chip's is for what's inside it.

### RSA

```python
pub = c.genkey(optiga.RSA1, optiga.RSA2048, optiga.ENC | optiga.SIGN)   # 25 s on a V1
ct = c.rsa_encrypt(b"hi", pub)                    # PKCS#1 v1.5, up to key size - 11 bytes
c.rsa_decrypt(optiga.RSA1, ct)                    # b"hi"
sig = c.sign_rsa(optiga.RSA1, sha256_digest)      # PKCS#1 v1.5, raw bytes (256 for RSA-2048)
c.verify_rsa(sha256_digest, sig, pub)             # True / False
```
- `pub` for RSA is the DER `SEQUENCE { n, e }`. A computer loads it as a SubjectPublicKeyInfo once you
  put `30 82 01 22 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00 03 82 01 0f 00` (RSA-2048) or
  `30 81 9f 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00 03 81 8d 00` (RSA-1024) in front.
- `RSA1024` and `RSA2048`. `sign_rsa(..., sha=384)` / `512` for those digests.

### Storage

```python
c.write(optiga.DATA[0], b"hello", erase=True)   # erase=True: empty it first
c.write(optiga.DATA[0], b"!", offset=5)         # change bytes in place
c.read(optiga.DATA[0])                          # b"hello!"
c.read(optiga.CERT, 0, 64)                      # a slice: offset, length
```
- `DATA` objects hold 140 bytes, `BIG_DATA` 1500. Writing past the end raises error `0x08`.
- What's in the chip survives a reflash of the wedgie (a wipe at /format erases the Pico's flash, not
  the chip). It's a good place for something an app must find again after a reinstall.
- Anyone who can run code on the wedgie can read and write these as shipped. For secrets that must
  stay inside, use a key slot (nothing reads a private key) or change the object's read rule (metadata).
- Flash on the chip wears out too: ~2 million writes across the whole chip. Don't write every frame.

### Counters that only go up

```python
o = optiga.COUNTERS[0]
c.set_counter(o, 0, 1000)    # value 0, threshold 1000 (while its rules allow changing it)
c.count(o)                   # (1, 1000)
c.count(o, 5)                # (6, 1000)
c.counter(o)                 # (6, 1000)
```
At the threshold, `count` raises error `0x0E`. Each counter takes ~600,000 counts.
To make one nobody can reset, lock its change rule (metadata) after `set_counter`; that's permanent.

### Sessions and power

```python
ctx = c.hibernate()    # 8 bytes: the session saved inside the chip (security event count must be 0)
c = optiga.Chip()      # ... later, even after a power cycle
c.open(ctx)            # back where it was (SESSION keys included)
c.close()              # forget the session
```

### AES and HMAC (V3 chips)

Written from Infineon's manual; **not yet run on a real V3** (the tested chip is a V1). Same for HKDF,
Brainpool and P-521, and for `verify(cert=)` / `rsa_encrypt(cert=)`.

```python
c.aes_genkey(128)                              # an AES-128 key in AES_KEY (or 192, 256)
ct = c.aes(data16, iv=iv16)                    # AES-CBC, data a multiple of 16 bytes (no padding)
c.aes(ct, decrypt=True, iv=iv16)
c.aes(data16, mode="ecb")
c.mac(data)                                    # AES-CMAC
c.hmac(optiga.SESSION[0], data)                # HMAC-SHA256 keyed by a session secret (or sha=384/512)
key = c.aes_genkey(256, export=True)           # just random key bytes, kept nowhere
```

### Chip info and anything else

```python
c.info()     # {'uid': ..., 'lifecycle': 7, 'security_events': 0, 'sleep_ms': 20, 'current_ma': 6, 'buffer': 1557}
c.metadata(optiga.KEY2)     # {0xC0: b'\x01', 0xD0: b'\xe1\xfc\x07', 0xD3: b'\x00', 0xE0: b'\x03', 0xE1: b'\x10'}
c.command(cmd, param, data) # any raw command (Infineon's Solution Reference Manual), returns its data
c.last_error()              # the chip's last error code (reading it clears it)
```

Metadata tags: `C0` lifecycle (01 creation, 03 initialization, 07 operational, 0F terminated), `C4` max
size, `C5` used size, `D0` change rule, `D1` read rule, `D3` use rule, `E0` key algorithm, `E1` key
usage, `E8` object type. Rules: `00` always, `FF` never, `E1 FC 07` "while the object's lifecycle is
below operational", `40 <counter OID>` "each use counts that counter".

## Calls that can lock the chip forever

`set_metadata` is the only call in `optiga` that can do it, and only on purpose. **Never call it to
"try it out".** What's permanent:
- **A lifecycle (`C0`) only goes up.** Setting a slot's lifecycle to `07` (operational) closes every
  "below operational" rule on it for good: on a key slot, no more `genkey` into it, ever; on a data
  object or counter, no more changes. That's how you *make* something tamper-proof, and it can't be undone.
- A rule set to `FF` (never) on an operational object is gone for good.
- The global lifecycle (`LCSG`, E0C0) and the application's (`LCSA`, F1C0) only go up too; `0F` there
  ends the chip's application. Don't write them.
- `genkey` into a slot destroys the key that was there (not a lock, but no undo either).
- `c.command(...)` can send anything, including Infineon's protected-update and lifecycle commands.

Everything else in `optiga` (keys, signing, storage, counters below their threshold, sessions) can be
done again or undone.

## Errors

`optiga.Error.code`:

| Code | Meaning |
|---|---|
| 0x01 | no such object |
| 0x03 / 0x05 | bad parameter |
| 0x04 | bad length |
| 0x07 | access rules say no (a locked slot, a key without that usage) |
| 0x08 | past the end of the object |
| 0x0A | command not on this chip (a V3 command on a V1) |
| 0x0B | out of sequence |
| 0x0E | counter reached its threshold |
| 0x24 / 0x25 | unsupported algorithm or parameters |
| 0x2C | signature doesn't verify (`verify` returns False instead) |
| 0x2E | decryption failed |

## How it's tested

`tools/optigaprobe.py` in github.com/clawdbotatg/wedgie-dev runs every call above on a real Trust M and
checks the results on the computer (signatures, ECDH, hashes and RSA against Python's `cryptography`).
It touches only things that can be redone: KEY3, RSA1, one data object and one counter (both put back),
and sessions. It talks over one raw-REPL session (never restarts the wedgie). Last run, 2026-10-03, on a
Trust M V1: 21 of 21 checks pass. Not covered by it: the V3-only calls (above), `verify`/`rsa_encrypt` with a
stored certificate, `set_metadata` (on purpose: it can lock the chip).
