# Sealed SSH bench cartridge

This bench exercises one OpenSSH P-256 login to a disposable server. On the
device, pair the actual test server's SHA-256 host-key fingerprint, then
approve its login on the physical green button. The fresh key lives in Trust M
session RAM. Pairing accepts one host and waits two minutes for an authenticated request.
A valid login attempt consumes the session even if declined. The app closes the
chip session after use, decline, or expiration.

The device verifies the paired server's signature on the SSH session ID and
rebuilds the exact `wedgie-test` authentication payload before displaying the
login prompt. The loopback agent must also validate OpenSSH's session-binding
extension and refuse forwarded sessions. The cartridge declines Full Control
and ignores Ctrl-C and synthetic button presses while sealed. It returns to
the standard checked installer for signed jobs.

The RP2040 test boots stock core 0.3.91 with the compiled test app and a virtual
Trust M. Install the repository's Node dependencies and cache MicroPython
1.29.0 cross-compiler and littlefs-python before running offline.

```sh
ssh_test_out=$(mktemp -d)
uv run --offline --with mpy-cross==1.29.0.post2 python -c \
  'import mpy_cross, subprocess, sys; subprocess.run([mpy_cross.mpy_cross, "-s", "ssh_bench.py", "-o", sys.argv[1], "tools/ssh-lab/ssh_bench.py"], check=True)' \
  "$ssh_test_out/ssh_bench.mpy"
UV_OFFLINE=1 node tools/ssh-lab/test_ssh_bench.mjs "$PWD" \
  "$ssh_test_out/ssh_bench.mpy" "$ssh_test_out/results.json"
```

The harness tests permission and signature handling through emulated USB.
The stdio mode is an emulator-only fixture for running a real loopback
OpenSSH client against the virtual board. It dispatches the emulated green
button. The cartridge itself accepts only the physical button path.

Physical qualification needs a spare board, a signature-verified install,
and an actual test server with a known host key. A reusable SSH authenticator
also needs a reviewed persistent-key location and a host-enrollment lifecycle.
