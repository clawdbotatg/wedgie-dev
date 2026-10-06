# Plan: why a wedgie trusts what it runs

Status 2026-10-06. Austin: "all of that stuff needs to have signatures that trace back to keys we
know we trust. And what if someone flashes the firmware with their own version?"

## What we have today

- **Release key.** One P-256 key, `~/.wedgie/release-key.pem` on Austin's Mac, a plain file.
  Its public half is `RELEASE_KEY` in `firmware/wedgie.py`. `tools/sign.mjs` runs the gate, then
  signs `release/firmware.txt`: the sha256 of every firmware file plus the shelf apps (`@app` lines).
- **The wedgie checks it.** A checked install (`firmware/job.py`) verifies the signature with
  `p256.py` and hashes every file it's sent. A computer can't swap in other files or rename an app.
- **The chip is real.** Trust M answers with its Infineon certificate; the site checks it
  (`src/serial/chipcheck.ts`). That proves the chip, not the firmware.
- **The money key** (Safe signer) is made inside the Trust M and never leaves it.

## The holes, worst first

1. **Nothing stops someone flashing their own firmware.** Hold BOOTSEL, plug in, copy a UF2: the
   RP2040 runs anything and its flash can be read out. The fake firmware talks to the same Trust M,
   so it can sign with the same money key, draw fake screens, and answer every check the site makes
   the way real firmware would. On an RP2040 no check can prove the firmware is ours: any check our
   firmware can pass, a copy of it can pass too. We can only limit the damage (phase 3) or change
   the chip (phase 4).
2. **The release key is one plain file on a machine where agents run.** Any Claude session here can
   sign firmware every wedgie accepts. If it leaks, an attacker can too. If it's lost, no wedgie can
   ever be updated again: the firmware trusts that one key and there's no way to swap it.
3. **No rollback guard.** `job.py` checks the list is the version the host claims, not that it's
   newer. A host can put back an old signed release with a known bug, after one yes.
4. **Full access leaves no mark.** After a yes to full control, the computer can write anything,
   and the wedgie runs it from then on looking normal.
5. **Signed apps get the whole chip.** MicroPython has no walls between an app and the core. The
   shelf is signed with the same key, so signing an app means trusting its author with the money.
6. **The site isn't signed.** Vercel serves the JS. It can't install unsigned files, but it shows
   addresses and builds Safe transactions. The wedgie's own screen is the only display to trust.

## The plan

### Phase 1: the release key (no firmware change)

- Move it into hardware where it can't be copied: **two YubiKeys** (PIV slot, P-256, touch to
  sign). One on Austin's keychain, one in a safe. `sign.mjs` signs through the YubiKey.
- Every firmware signature then needs Austin's touch. Agents run the gate and build; the last step
  is his. (Fits the existing rule: no firmware push until a real board ran the exact build.)
- Write down where the backup is and how to rotate (phase 2).

### Phase 2: firmware (one release)

- **A key list, not one key.** `RELEASE_KEYS` holds both YubiKeys' keys. The signature names which
  key signed, so the wedgie still checks only one (2.2 s on an RP2040, no slower).
- **Rotation.** A signed list may carry a new key set (`@keys` line), signed by a current key. The
  wedgie saves it. Losing one key = sign a rotation with the other. No reflash, no lockout.
- **No going back.** The wedgie keeps the lowest version it accepts (the version it's on, or a
  `min` line in the signed list) and refuses older ones in a checked install. Full access can still
  go back, for development.
- **Mark full access.** A yes to full control writes a `modified` flag; only a checked install
  clears it. Boot and the site say "this wedgie runs changed firmware". Honest firmware tells the
  truth; fake firmware can hide it (hole 1), so it's a warning, not proof.
- Tests: `test_job.py` (old list refused, list from an unknown key refused, rotation accepted, a
  rotation signed by an unknown key refused); `chipprobe.mjs` heap before/after; a real board.

### Phase 3: limit the damage the RP2040 can't prevent

- **Money in Safes with rules**, not a single key: the wedgie as one signer of two, a guard with a
  daily cap or a delay on big transfers. A swapped firmware then can't empty anything alone.
  `/safe` already does the signer part.
- **PIN checked by the chip.** Trust M V3 can refuse to use a key until it's given an auth value;
  derive it from a PIN typed on the wedgie. A stolen wedgie with fake firmware still can't sign.
  (It doesn't stop swap-and-give-back: the owner types the PIN into the fake.) To research: does
  our Trust M version support it, and does it limit wrong guesses.
- **Apps on a money wedgie:** only shelf apps, each reviewed for what it does with the chip. Keep
  a short review checklist in `docs/APPS.md`.

### Phase 4: a real chain of trust (RP2350)

The fix for hole 1 is a chip that refuses unsigned firmware.

- **RP2350 secure boot.** Burn the hash of a boot key into OTP. The boot ROM then runs only images
  signed by that key; BOOTSEL can't load anything else, and debug is locked.
- **The core moves into the signed image** (frozen MicroPython modules). Files on the flash
  filesystem aren't covered by the image signature, so the signed core checks the apps, as job.py
  does now.
- **Bind the Trust M to that RP2350.** Trust M's shielded connection uses a shared secret; keep it
  in OTP that only signed code reads. Move the Trust M to other hardware, or sniff its wires, and it
  won't talk.
- **Then the wedgie can prove it's genuine** to the site: a signed answer only real firmware can
  make.
- Costs: OTP is forever, a mistake bricks a board; the boot key needs the same care as the release
  key (phase 1); RP2350 has known glitch attacks with lab gear, so "hard", not "impossible".

### Phase 5: hashes onchain

As in `SECURITY-ROADMAP.md` stage 2: each release's hash and the current key set go onchain. The
site and `wedgie.py` check there too, so a stolen key can't quietly ship a release nobody sees.

## Decisions for Austin

1. Release key: two YubiKeys (recommended), or a passphrase-locked file, or a dedicated wedgie.
2. Firmware signing needs your touch every release, agents can't sign (recommended: yes).
3. Money wedgies move to RP2350 with secure boot (recommended: yes, after phases 1-2).
4. Rollback: refuse older than current in a checked install, full access can still (recommended).
