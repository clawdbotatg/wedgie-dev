---
name: wedgie-security
description: Is a wedgie safe, and exactly how - the two rules (it trusts nothing plugged in; the person knows exactly what they say yes to), the lock and the green-button press, signed firmware and apps (two release keys that can't be copied), what the screen proves, what a computer, wedgie.dev or an app can and can't do, the known gaps, what to do if it's lost, and the security history by firmware version. Use for "is my wedgie safe", "can a computer steal my key", "what if I lose my wedgie", "is the firmware signed", "audit", "threat model".
---

# Is a wedgie safe?

Part of the wedgie skills. Index: https://wedgie.dev/skill.md

## The two rules

1. **The wedgie trusts nothing plugged into it.** Not the computer, a phone, wedgie.dev, or an app's host.
   Everything they send is a request; the wedgie checks it and decides.
2. **The person knows exactly what they say yes to.** The wedgie's own screen says everything that will happen,
   in plain words, worked out by the wedgie, never taken from the computer's label. Nothing happens beyond it.

## What that means

| Claim | How |
|---|---|
| Plugging it in gives a computer nothing | It's **locked** (`hello` says `"sealed": true`): no REPL, no files outside `/saves/`, no chip, no screen, no button presses without a yes on the wedgie |
| Nothing signs or installs without a person | Only a **real press of the green button** on the wedgie answers its questions. A USB `press` can never answer one. A question takes no press in its first 0.6 s |
| A computer can't wear you down | A **no** to FULL CONTROL holds until unplugged: every later ask is refused without asking |
| Firmware and shelf apps are wedgie.dev's | Signed lists, checked on the wedgie **while the question is up**: a green check (signed) or a red warning (a yes changes nothing). Yes stays grey until the check ends |
| An old release can't be replayed | A signed list older than the last one it installed is refused (`@serial`) |
| A job does one thing | "Update firmware" writes only firmware; "Install X" writes only X and removes only the app it replaces (the question names it); anything more is refused |
| Release keys can't be copied | Two keys, either signs: one in a Mac's Secure Enclave (Touch ID), one on a YubiKey (PIN + touch). No key file exists |
| Keys never leave the chip | Made inside the Trust M / ATECC608. Not to the computer, not to wedgie.dev |
| You can see full control was given | After FULL CONTROL a thin **red border** stays on every screen until a signed install puts it back to signed code |
| Everything is open | MIT: https://github.com/clawdbotatg/wedgie-dev |

## Honest limits

- **An app runs with full power on the wedgie,** including the chip. Install only shelf apps (reviewed and
  signed) or code you trust. An app added from a GitHub repo by hand is **not** signed and installs with full
  access: it can even replace keys in the Trust M's spare slots.
- **Safe Signer's key is locked, not exclusive:** nothing can replace it, but any code on the wedgie can sign with it.
- **Physical access:** whoever holds the wedgie can hold BOOTSEL, flash any firmware, and sign with its key. **A
  lost wedgie is a lost key:** remove it as an owner of your Safe.
- **A dead chip is a lost key:** keep a second owner or recovery on every Safe.
- **Apps decide** whether a USB press counts inside their own screens; the firmware's own questions take only real
  presses.
- **The internet (0.3.61+):** an app can fetch from the sites its wedgie.json lists (`"net"`), through its open
  wedgie.dev page or `wedgie.py net`. The page and wedgie.py refuse any other site, so a reviewed app can only
  talk to what the review saw. A site (`net.get`, 0.3.67+) is the wedgie's own TLS 1.3: it checks the site's
  certificate (ECDSA, or RSA 0.3.69+) against Mozilla's roots, and the computer and wedgie.dev's relay carry only encrypted bytes (they
  can block, not read or change). Not checked: certificate dates (no clock) and revocation. The request goes
  out while the certificate is still being checked (0.3.68+: sites hang up on a slow one), so a fake site could
  see the path asked for; nothing it sends is read until every check passes. Ethereum reads
  (`net.chain(1, ...)`, `net.price`, 0.3.70+) go the same way to BuidlGuidl's node (only it could change them).
  Other chains are wedgie.dev's answers: the computer or wedgie.dev could change them.
  wedgie.dev's Alchemy key never leaves wedgie.dev.
- **Not an audited hardware wallet.** Don't keep more on it than you can afford to lose.
- No secp256k1 in either chip: a wedgie owns smart accounts (Safe) through P-256, never a plain Ethereum key.

## What each party can do

| Party | Can | Can't |
|---|---|---|
| A computer it's plugged into | `hello`, `ping`, `chip` proof, list and read `/saves/`, read its log, ask questions | anything else without a yes on the wedgie |
| wedgie.dev | sign firmware and shelf apps; show you pages | press the button; see your keys; install without your yes |
| An installed app | anything on the wedgie, including the chip | change the firmware's own questions or the lock |
| Someone holding it | reflash it, use its key | read the key out of the chip |

## Checks you can run

- **Is the chip real?** `{"type":"chip"}`: a Trust M signs random bytes with its factory key; its certificate
  chains to Infineon.
- **Is my Safe key mine?** Safe Signer's first screen must say **No key** (safe.md).
- **Is the firmware right?** Update at https://wedgie.dev/connect; the question shows the version and a green check.
- **What happened?** `get /log.txt` (no yes needed): power-ons, app starts, crashes, installs. No keys in it.

## Security history (firmware)

| Version | Change |
|---|---|
| 0.2.5 | Sealed: the lock and the green-button question |
| 0.3.49 | Older signed lists refused before the question; lock starts closed on a real chip |
| 0.3.50 | A checked install binds to one complete signed release |
| 0.3.52 | A log readable while locked |
| 0.3.53 | One job, one thing, all of it on its question |
| 0.3.54 | Locked wedgie refuses `shot` and `press`; deleting saves asks; no press in a question's first 0.6 s; a no to FULL CONTROL holds till unplugged; rollback blocked (`@serial`) |
| 0.3.55 | Two release keys that can't be copied (Secure Enclave, YubiKey); the old key file's lists refused |
| 0.3.56 | Signature checked while the question is up (green check / red warning); red border after full control |
| 0.3.57 | Yes is grey until the check ends; installs end in a hard reset |
| 0.3.64 | Release signatures checked on the Trust M (0.2 s, was 2.4 s); pure Python only without one, or if it says no |
| 0.3.66 | Apps in their own list, named by its hash in the signed one (no size limit) |

Report a problem: wedgie@buidlguidl.com, or **Send a bug report** on a wedgie's page at wedgie.dev/connect.
