# Security roadmap

What stops a bad computer (or a thief) from using a wedgie's key. Status as of 2026-09-29.

## Done: the lock (0.2.5)

- Ctrl-C does nothing, so a computer can't get into the REPL by itself.
- `{"type":"open"}` asks on the wedgie's screen. Only a real press answers: A yes, Y no.
- A yes is for one job: the wedgie locks again when its app restarts. (0.2.5 kept it open until
  unplugged; on a real wedgie that lasted far longer than the job, so 0.2.7 dropped it.)
- Details: `firmware/main.py`, `slot.let_in`, `wedgie.py`.

## Next: one question per job

Today a yes gives the computer everything. Instead the computer sends a job and the wedgie asks
about just that: "Update firmware to 0.2.7?", "Install Buttons?", "Delete Hi-Lo's saves?". The
wedgie does the job itself; the computer never gets the REPL.

The files still come from the computer, so the wedgie must check them:
- It hashes every file it receives (sha256 on the board).
- It compares against a list of right hashes signed with our key, checked with `p256.py`.
  Signing is how it knows that list came from us. The key lives on Austin's machine, not Vercel.
- Official firmware and apps: a plain yes/no.
- An unreviewed app (someone's GitHub repo): the wedgie says so and shows a short fingerprint
  (a blockie of the hash) that the person can compare with wedgie.dev on their phone.
- Full access stays as a developer option, asked the way it is now.

## Then

- **PIN checked by the chip.** An on-screen keypad (arrows move, A types, red deletes, dots not digits).
  The ATECC's slot 0 gets ReqAuth with a key derived from the PIN, and slot 0 is locked so its key
  can't be replaced. Open question: can the chip limit wrong guesses?
- **Limits on the account:** daily cap, delay on big transfers, guardian recovery, a second signer
  above a threshold.

## Stage 2: hashes onchain

Publish each release's hashes (firmware and reviewed apps) to a smart contract. Then anyone with a
node can ask a third party with no stake in it what the right hash is, instead of trusting
wedgie.dev or our signing key alone. The wedgie, the site and wedgie.py could all check against it,
and a release that isn't onchain would be refused or flagged.

## Known gaps that stay open

- Holding BOOTSEL while plugging in bypasses everything: the RP2040 has no secure boot.
- Firmware put on by someone else (BOOTSEL, or a thief who gives it back) can fake the screens.
- An app you approved runs with full access to the chip. While a wallet key exists, only allow
  apps we signed.
