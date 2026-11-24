"""Receive only disposable vault keys from a parent pipe, with no key output."""
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile

MAC_CLI = Path("/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli")
KEEPASSXC = Path(os.environ.get("KEEPASSXC_CLI") or shutil.which("keepassxc-cli") or MAC_CLI)


def list_entries(vault, password, material):
    with tempfile.TemporaryFile(dir=vault.parent) as handle:
        handle.write(material)
        handle.seek(0)
        descriptor = handle.fileno()
        checked = subprocess.run([KEEPASSXC, "ls", "--key-file", f"/dev/fd/{descriptor}", vault],
                                 input=password + "\n", text=True, capture_output=True,
                                 pass_fds=(descriptor,), timeout=20, check=False)
        return checked.returncode == 0


def main():
    if not KEEPASSXC.is_file():
        raise RuntimeError("Install KeePassXC CLI or set KEEPASSXC_CLI")
    data = sys.stdin.buffer.read(129)
    if len(data) != 128:
        raise RuntimeError("Missing disposable fixture keys")
    known, device, wrong_vault, wrong_device = (data[i:i + 32] for i in range(0, len(data), 32))
    password = secrets.token_hex(24)
    with tempfile.TemporaryDirectory(prefix="wedgie-trustm-vault-fixture-") as root:
        vault = Path(root) / "fixture.kdbx"
        enrollment = Path(root) / "fixture.key"
        with os.fdopen(os.open(enrollment, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
            handle.write(known)
        try:
            created = subprocess.run([KEEPASSXC, "db-create", "--quiet", "--set-password", "--set-key-file", enrollment, vault],
                                     input=f"{password}\n{password}\n", text=True, capture_output=True,
                                     timeout=40, check=False)
            if created.returncode or enrollment.read_bytes() != known:
                raise RuntimeError("Couldn't enroll the dummy vault with the expected reference key")
        finally:
            enrollment.unlink()
        if not list_entries(vault, password, device):
            raise RuntimeError("The device-derived key couldn't unlock the dummy vault")
        if list_entries(vault, password, wrong_vault) or list_entries(vault, password, wrong_device):
            raise RuntimeError("The dummy vault accepted a different device or context")
        if not list_entries(vault, password, known):
            raise RuntimeError("The disposable recovery reference couldn't unlock the dummy vault")
        if set(Path(root).iterdir()) != {vault}:
            raise RuntimeError("A named fixture key file remained")
    print("KeePassXC unlocked with the virtual Trust M and recovery keys and refused both incorrect keys.")


if __name__ == "__main__":
    main()
