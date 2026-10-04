# Apps: one repo each, signed onto the site

Since 2026-10-03 every wedgie app lives in its own GitHub repo. Ours are `clawdbotatg/wedgie-<name>`.
Nothing app-shaped lives in `firmware/` any more (`firmware/carts.json` is `[]`). The old built-in apps
(Hello, Buttons, Demo, Speed lab, Wallet look, Clear sign, Battery, the ATECC608 Wallet) are in git
history before commit 020765c.

## How it works

- A repo has a `wedgie.json` and the app's files (rules: `public/code.md`, checked by `src/apps/appjson.mjs`).
- `community.json` lists the repos on the site, each pinned to one commit we read.
- `tools/community.mjs` copies that commit's app files into `community/<owner>/<repo>/`, so a review
  is a normal `git diff`, and the site never fetches from GitHub at build time.
- `tools/release.mjs shelf()` adds those apps to the signed list (a hash of each file, plus an `@app`
  line: mod, name, entry, usb, files). One release key signs the firmware and the apps together.
- `tools/fw.mjs` publishes them to `/fw/` beside the core, first in the manifest, so they're first on
  the site. A wedgie installs them with a checked install (`firmware/job.py`): every file must match
  the signed hash, and the person presses A.
- A new commit in the app's repo changes nothing until someone adds it again (`community.mjs update`).
- Repos a person adds by hand on their wedgie's page aren't signed. They install through full access.

## Versions

**An app's version is its repo's commit** (`4f7748d · Oct 4`). There is no version number to bump.

- **Pushing to the app's repo puts nothing on wedgie.dev.** The site serves only the commit it signed.
  Until you add it again, Update on the site gives the old one. The site says so under the cart:
  "GitHub has a newer commit, ..., not on wedgie.dev yet."
- `community.json` keeps each repo's commit (`sha`), its date (`at`), each app's `v` (the hash of its
  files that a wedgie records in apps.json), and every earlier commit in `past`.
- `tools/fw.mjs` publishes that history as the manifest's `known` (v -> commit). With it the site and
  `wedgie.py apps` say which commit a wedgie runs, and tell three cases apart:
  - **older**: a commit wedgie.dev published before. **Update** is offered.
  - **newer**: also one wedgie.dev published, but newer than what the site has now.
  - **other**: a version wedgie.dev never published (put on from GitHub, /code or wedgie.py).
  For newer and other, the button says **Replace**, never Update.
- Firmware has its own version: `VERSION` in `firmware/wedgie.py` (bump it when the core changes).

## Put an app on the site, or update one

```
node tools/community.mjs status                             # which apps GitHub has newer commits of
node tools/community.mjs update                             # take every one of them (or: update owner/repo)
node tools/community.mjs add clawdbotatg/wedgie-<name>     # its current commit (or owner/repo@ref)
git diff community/                                         # read it: this runs on people's wedgies
node tools/sign.mjs                                         # runs tools/gate.mjs first; signs only if it passes
git add community.json community/ release/ && git commit && git push
```

Push to main = deploy. Check it's live: `curl -s https://wedgie.dev/fw/release.txt | cmp - release/firmware.txt`.

- No `VERSION` bump for an app-only change: the core didn't change. The site sees the new app by its
  `v` (a hash of its files).
- The gate boots each shelf app on a virtual RP2040 (`tools/bootprobe.mjs <mod>`, >= 16 KB free).
  A real board is still the only full test: `python3 tools/boardprobe.py <mod>`.

## Take an app off the site

```
node tools/community.mjs remove clawdbotatg/wedgie-<name>
node tools/sign.mjs
```

Then commit and push. Wedgies that have it keep it until they install another app.

## A new app

1. Make the repo `clawdbotatg/wedgie-<name>`: `wedgie.json`, the files, a README (what it is, the
   controls, the saves), MIT LICENSE. Start from `clawdbotatg/wedgie-buttons` or `clawdbotatg/wedgie-starter`.
2. Follow `docs/STYLE.md` (the `ui` kit, the palette) and the memory rules in `public/code.md`.
3. Try it in the emulator (wedgie.dev/code, Open a folder) and on a real wedgie (`wedgie.py install .`).
4. Add it as above.

## Tests

The probes no longer use real apps as fixtures:

- `tools/fixtures/hello.py`: a small Timer app (it leaves the REPL free). emuprobe and chipprobe use it.
- `tools/test_job.py` defines three tiny apps of its own.
- `tools/fakeserial.mjs` uses Buttons, Dodge (wedgie-starter) and Vault, a fake repo app with a chip and USB.

## Not done yet

- **Leftover files.** Old wedgies keep the removed apps' files after a firmware update. It's harmless.
  They come off when another app is installed only if apps.json lists them, and the old built-ins
  didn't.
- **Separate signatures per app.** Today one signature covers everything, so changing one app re-signs
  the whole list. With many apps, give each app its own signed note (repo, commit, file hashes). That
  needs a `job.py` change.
- **The Wallet.** A new one is planned on the Trust M chip, in its own repo.
