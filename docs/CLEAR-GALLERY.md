# Keeping wedgie.dev/clear true

wedgie.dev/clear says "this is how a wedgie shows every transaction". That's only true while its screens come from
the Safe Signer and the data that are on the shelf now. Nothing redoes them by itself. **If you ship something in
the list below, redoing /clear is part of the job.**

Status 2026-11-13: the screens are from **Safe Signer 64**, data `1c4d8c1d`. The shelf has **Safe Signer 67**,
data `e649676a`. So /clear is three releases behind: about 20 screens changed (an ETH send inside a batch reads as
a send now), and its "no descriptor" list still names Multicall3, 0x, Relay and `transferFrom`, which have
descriptors now. The plan at the bottom is not built.

## What makes /clear go stale

| What changed | What is now wrong on /clear | What to redo |
|---|---|---|
| A Safe Signer release (wedgie-safe `FW`) | Screens: the app draws them | everything (steps 1-6) |
| New clear-signing data (a new tag in `public/clear/`, made by `wire/release.py`) | Screens and badges of the calls whose descriptor or token changed; the "no descriptor" list | everything (steps 1-6) |
| A week went by | "mainnet txs last week", the order of dapps, the "no descriptor" list | usage only (steps 2 and 6: minutes, no chips) |
| The registry got new descriptors or tests | Nothing yet: a wedgie's data is pinned to one registry commit (`safe_roots.py` names it). They show up at the next data release | a data release (`wire/README.md`, "Make a release"), then everything |
| `tools/test_clear.py` changed what it accepts | Badges (match / close match / differs) | steps 4-6 (minutes) |

How to tell which Safe Signer the screens are from, today: `git log -1 -- public/clear/screens/all.json` (the
commit message says). There is no stamp in the data yet (plan, step 1).

## How to redo it

A full run is hours of CPU (2,944 transactions, ~12 s of one core each) but no one's time: start it in the
background and come back. A stopped run picks up where it left off.

Work in a worktree off `origin/main` (other sessions use this checkout). The tools look for two checkouts **beside
the worktree**: `../wedgie-safe` and `../clear-descriptors`. In a worktree, link them:

```
ln -s <path to wedgie-safe checkout at the shelf's commit>  ../wedgie-safe
ln -s <path to clear-descriptors checkout>                  ../clear-descriptors
```

1. **The registry, at the commit the shelf's data was made from.**
   `grep Registry community/clawdbotatg/wedgie-safe/safe_roots.py` names it.
   ```
   git clone https://github.com/ethereum/clear-signing-erc7730-registry /tmp/reg && git -C /tmp/reg checkout <commit>
   ```
2. **Mainnet use, last 7 days** (a minute, from erc7730.sourcify.dev):
   ```
   python3 tools/clear_gallery.py usage /tmp/usage.json
   ```
3. **Every transaction on a virtual wedgie** (hours; in the background; `mkdir -p /tmp/work` first):
   ```
   python3 -u tools/clear_gallery.py run /tmp/reg /tmp/work --jobs 8 --usage /tmp/usage.json
   ```
   It ends with "N of N answered; 0 left". If some are left, run it again: it does only those.
   Use a **new** work dir for a new Safe Signer or new data, or it will keep the old screens.
4. **The verdict for each transaction** (a few minutes; the app's reader against what each test expects):
   ```
   RESULTS=/tmp/verdicts.json uv run -q -p 3.13 --with clearsig --with eth-account --with pycryptodome \
       --with cryptography python3 tools/test_clear.py /tmp/reg ../wedgie-safe
   ```
   It must end "all ok". More "differ in a way not explained" than last time means the app or the data broke
   something, or changed on purpose: look at each one before publishing (`DUMP=/tmp/why.json` says what differs).
5. **Publish into the site:**
   ```
   python3 tools/clear_gallery.py publish /tmp/work /tmp/verdicts.json /tmp/usage.json
   ```
   Read its last line: transactions, screens, and the counts. `'fail'` above 0 is an app crash on a virtual chip:
   a bug, fix it first.
6. **Ship:** `git add -A public/clear/screens`, commit (say which Safe Signer and data tag), push to main, then
   `node tools/loadprobe.mjs https://wedgie.dev`. Look at wedgie.dev/clear once.

Usage only (the weekly case): steps 2 and 5 with the **old** work dir and verdicts, then 6. No chips.

### Things that bit us

- zsh stops a command on a glob with no match (`rm -f dir/*`): `setopt nonomatch`, or don't glob.
- `publish` needs the verdicts file. Without it there are no badges.
- The transaction ids are their place in the list, so `--only` gives different ids than a full run. Don't publish
  a `--only` run.
- gitleaks reads a 64-hex value as a key. Test names carry mainnet transaction hashes; that's what they are.
  Never bypass the hook: look at what it flagged.
- The screens are 26 MB of small PNGs. A full redo rewrites most of them: a big commit, once per release.
- `/clear`'s hand-made sections (`public/clear/screens/index.json`, `tools/clear_page.py`) are separate and only
  for what the registry doesn't have. Don't add a dapp by hand that the registry covers.

## The plan (not built)

The goal: /clear can't quietly fall behind, and catching up is one command.

1. **Stamp the data.** `publish` writes `public/clear/screens/meta.json`: Safe Signer version, data tag, registry
   commit, the usage window, the date. /clear shows it in one line ("Safe Signer 67 · data e649676a · 11-13").
2. **A check that fails when it's behind.** `tools/test_docs.py` compares the stamp with the shelf
   (`community/clawdbotatg/wedgie-safe/wedgie.json` version, `safe_roots.py` TAG). Behind = FAIL, with the
   command to run. It's in the gate, so every release sees it.
3. **One command.** `python3 tools/clear_gallery.py refresh`: clones the registry at the right commit, links what
   it needs, runs steps 2-5, prints what changed since the last publish (screens that differ, verdicts that
   moved). Step 6 stays with whoever ran it.
4. **Redo only what changed.** Keep, per transaction, a hash of (the app's files, its bundle, the transaction).
   Same hash = keep the screens. New data then reruns only the calls it touched (minutes). A new app still
   reruns everything (hours): its drawing code can change any screen.
5. **On a timer.**
   - Weekly: usage only (step 2 and 5). A scheduled agent, no chips, a small commit.
   - After every Safe Signer or data release: the session that released starts `refresh` in the background
     right after the gate, and ships it when it ends. Until step 2 exists, this line is the only reminder.
6. **Stable ids.** Name a transaction's screens by a hash of (test file, description), not its place in the
   list. Then links to one transaction survive a new registry commit, and `--only` runs can be published.

Order to build: 1, 2 (an hour, and it ends the "nobody noticed" problem), then 3, 5, then 4 and 6.

## Not part of this

- New descriptors: `../clear-descriptors/MAP.md`.
- Registry data for the wedgie (a release, needs Touch ID): `wire/README.md`.
- The sandbox (wedgie.dev/sandbox) needs no redo: `tools/sign.mjs` remakes its image at every release.
