# Honest questions (firmware 0.3.53)

## Your expectations

Two rules over everything: hardware, firmware, apps, the website. Written in `EXPECTATIONS.md`.

1. **The wedgie trusts nothing plugged into it.** Computer, phone, wedgie.dev, me. Anything they send
   is a request. The wedgie checks it and decides.
2. **The person knows exactly what they say yes to.** The wedgie's own screen says everything that
   will happen. Nothing else happens.

## What was wrong

- "Install Welcome" also replaced the firmware. The screen only said "Install Welcome".
- "Update firmware" also updated the app and deleted other apps' leftover files. Not on the screen.
- An install could delete any file that wasn't firmware or a save, such as your own app.
- Any computer could reset the chip while an app was using it. Welcome froze for 10 s.
- My test used a fake wedgie with copied rules. It let a bad job through that every real wedgie refused.

## What changed

**Firmware 0.3.53**

- One job does one thing. The wedgie refuses anything more, after checking the signature, before
  anything changes (`firmware/job.py`, `check`).
  - **Update firmware:** writes only firmware files. Deletes nothing. The app stays as it is.
  - **Install X:** writes only X's files. Deletes only the app it replaces.
  - **Uninstall:** deletes only the current app.
- The screen comes from the wedgie, not the computer (`firmware/slot.py`, `ask`):
  - "Install Welcome / replaces Buttons": the wedgie reads what it runs from its own flash.
  - "Uninstall Buttons": names the app, not just "the app".
  - "Update firmware 0.3.53": the version must match the signed list, or nothing happens.
- The chip check from a computer answers "busy" while an app is using the chip, instead of
  resetting it (`firmware/trustm.py`, `optiga.py`, `atecc.py`, `wedgie.py chip`).

**Website**

- On 0.3.53+, firmware and app are separate questions: /prepare and /update ask "Update firmware",
  then "Install Welcome" (or the app) (`src/serial/install.ts`, `src/pages/prepare.ts`, `update.ts`).
- Older firmware gets the jobs its own installer accepts, once, to reach 0.3.53.
- The chip check waits and asks again on "busy" (`src/serial/wedgies.ts`).

## What I tested

- `tools/test_job.py`: the real installer code. 49 checks, 7 new: an update that writes the app,
  deletes a file, or an install that writes firmware, deletes another app or your own file, an
  uninstall that deletes more. All refused. An update with an old app goes in, the app untouched.
- `tools/test_sitejobs.py` (new): every job /prepare and /update really sent in their tests goes
  through the real installer rules. 3 jobs, all accepted. This is the check that would have caught today's bug.
- `tools/prepareprobe.mjs`: a 0.3.53 wedgie with Buttons gets exactly two questions (firmware, then
  Welcome replacing Buttons), ends with Welcome only. An old 0.3.20 wedgie also ends right.
- `tools/updateprobe.mjs`: four wedgies at once, all updated; a replugged one is "already up to date".
- Release gate (`tools/sign.mjs`): 22 checks on a virtual RP2040 with the real firmware, including
  installs over every app and firmware updates, memory included. Passed, then signed.
- Docs, memory and style checks pass.

## Not tested yet

- **A real wedgie.** Not pushed until one passes. Firmware never ships without that.
- A real Trust M with an app using the chip at the same time as a computer asks (the "busy" path).

## Why this is the right answer

- The rule lives in the wedgie, not the website. A bad site, a bad tool or my mistakes can only make
  a job fail, never do more than the screen said.
- One job, one thing keeps every screen short and true. No small print.
- The screen's facts come from the wedgie's own flash and the signed list, not the computer's words.
- The website is now tested against the real firmware rules, not a copy of them.

## Still open (EXPECTATIONS.md, known gaps)

- Anyone holding the wedgie can press BOOTSEL and flash their own firmware, and the chip signs for it.
- Apps run with full access to the chip. Only review keeps a bad one off the shelf.
- Apps choose whether a fake button press can answer them. The firmware's own questions only take real presses.
- The job's kind still comes from its title text. Better: a kind field, and the wedgie writes all the words.
