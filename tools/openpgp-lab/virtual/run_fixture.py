"""Run the OpenPGP test with scratch state and a no-network GnuPG image."""

import argparse
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic, sleep

import mpy_cross


def main(repo, receipt):
    bench = Path(__file__).resolve().parent
    with TemporaryDirectory(prefix="mailbox-", dir=bench) as tmp, receipt.open("w") as log:
        mailbox = Path(tmp)
        cartridge = mailbox / "pgp_bench.mpy"
        subprocess.run([mpy_cross.mpy_cross, "-s", "pgp_bench.py", "-o", cartridge, bench / "pgp_bench.py"],
                       check=True, stdout=log, stderr=subprocess.STDOUT)
        process = subprocess.Popen(
            ["node", "--no-warnings", bench / "virtual_token.mjs", repo, cartridge, mailbox],
            stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = monotonic() + 90
            while not (mailbox / "ready").exists():
                if process.poll() is not None:
                    raise RuntimeError("Virtual token startup failed")
                if monotonic() >= deadline:
                    raise TimeoutError("Virtual token startup timed out")
                sleep(0.05)
            command = ["docker", "run", "--pull=never", "--rm", "--read-only", "--network", "none",
                       "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev",
                       "-v", f"{bench}:/fixture:ro", "-v", f"{mailbox}:/mailbox", "--entrypoint", "/usr/bin/timeout",
                       "pgvector/pgvector:pg16", "90", "/bin/sh", "/fixture/verify_gnupg.sh"]
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=100)
            (mailbox / "stop").touch()
            if process.wait(timeout=10) != 0:
                raise RuntimeError("Virtual token claims did not pass")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("emulator_checkout", type=Path)
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    main(args.emulator_checkout.resolve(), args.receipt)
