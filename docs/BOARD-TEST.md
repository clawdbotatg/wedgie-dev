# Real-board test before a firmware release (0.3.12)

Use a test wedgie, not the one with your wallet on it. Each step: press A on the wedgie when it asks.

## Setup (once)

1. On the Mac (it has the release key): `node tools/sign.mjs`, commit `release/`, push the branch.
2. On omen: `git pull`, then `npm run build && npx vite preview --port 4173 --host`.
3. Plug the test wedgie into omen. It shows up as `/dev/ttyACM0`.
4. Put 0.3.12 on it: `WEDGIE_SITE=http://localhost:4173 python3 public/wedgie.py update`.

## Installs

5. **Fresh plug-in (the port-drop case).** Unplug it, plug it back in, wait 5 s, then:
   `python3 tools/boardprobe.py --site http://localhost:4173 --port /dev/ttyACM0 battery`
   This is the first soft reset since the plug-in. It must finish, not hang after the A press.
6. Every app over every app:
   `python3 tools/boardprobe.py --site http://localhost:4173 --port /dev/ttyACM0 hello keytest demo speed mock wire_demo battery usbwallet`
   Watch for "memory allocation failed" and note the lowest free RAM it prints.
7. **Entry app (Demo):** `python3 tools/boardprobe.py --site http://localhost:4173 --port /dev/ttyACM0 demo hello`
   (Hello goes on over a running Demo: the hard-reset backstop). It must finish.
8. A firmware update while Battery runs: `WEDGIE_SITE=http://localhost:4173 python3 public/wedgie.py update`.

## The escape hatch

9. `python3 public/wedgie.py unlock`. You should see a red FULL CONTROL? screen. Press Y: it restarts,
   still locked. Run it again and press A: `mpremote connect /dev/ttyACM0 exec "print(1)"` prints 1.
10. Unplug, plug in, wait 5 s. Run `mpremote connect /dev/ttyACM0 repl`. The red screen comes up.
    Press A within 10 s: you get the `>>>` prompt. If mpremote gave up first, run it again.
11. Unplug and plug in again: Ctrl-C does nothing until you press A on the red screen.

Pass = every step finishes, nothing says "wedgie broke", and nothing gets in without an A press.
