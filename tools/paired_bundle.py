"""Prepare an unsigned paired envelope from a reviewed ordinary release."""

import argparse
import json
from pathlib import Path
import tempfile

from paired_update_boot import Pair
from paired_upload import MAX_META, MAX_PAYLOAD, check, digest, read_bounded


def prepare(source, destination, reviewed_hash, mod):
    release = read_bounded(source, "release.txt", MAX_META)
    shelf = read_bounded(source, "apps.txt", MAX_META)
    check(digest(release) == reviewed_hash, "Input release differs from the reviewed digest")
    check(release.endswith(b"\n") and not any(
        line.startswith((b"@pair ", b"@sizes ")) for line in release.splitlines()),
        "Expected an ordinary release envelope")
    check(b"@apps  " + digest(shelf).encode() + b"\n" in release, "App shelf differs from the reviewed release")
    carts = [json.loads(line[6:]) for line in shelf.splitlines() if line.startswith(b"@app  ")]
    selected = [app for app in carts if app.get("mod") == mod]
    check(len(selected) == 1, "Expected one selected app in the release shelf")
    app = selected[0]

    def pair_envelope(v):
        target = json.dumps({"mod": mod, "name": app["name"], "v": v}, separators=(",", ":")).encode()
        return release + b"@pair  " + target + b"\n"

    provisional = pair_envelope("pending")
    parsed = Pair.parse(provisional, "", shelf, lambda content, _: content == provisional)
    fingerprint = digest("\n".join(parsed.files[name] for name in app["files"]).encode())[:12]
    files, remaining = {}, MAX_PAYLOAD
    for name, expected in parsed.files.items():
        contents = read_bounded(source, name, remaining)
        check(digest(contents) == expected, "File differs from reviewed release: " + name)
        files[name] = contents
        remaining -= len(contents)
    sizes = "".join(f"{len(data)}  {name}\n" for name, data in sorted(files.items())).encode()
    paired = pair_envelope(fingerprint) + b"@sizes  " + digest(sizes).encode() + b"\n"
    check(len(paired) + len(shelf) + len(sizes) <= MAX_META, "Paired metadata exceeds the device limit")
    pair = Pair.parse(paired, "", shelf, lambda content, _: content == paired)
    pair.sizes(sizes)

    check(not destination.exists(), "Destination must be new")
    destination.mkdir(mode=0o700)
    # The signed envelope is absent. A path that fails partway is never
    # mistaken for a staged or signed bundle.
    try:
        with tempfile.TemporaryDirectory(prefix=".pair-build-", dir=destination) as temporary:
            work = Path(temporary)
            for name, data in {**files, "release.txt": paired, "apps.txt": shelf, "sizes.txt": sizes}.items():
                (work / name).write_bytes(data)
            for path in work.iterdir():
                path.rename(destination / path.name)
    except Exception:
        # This directory was created exclusively by this invocation.
        for path in destination.iterdir():
            path.unlink()
        destination.rmdir()
        raise
    return {"type": "unsigned_pair", "app": pair.app["name"], "cart_fingerprint": pair.app["v"],
            "core": pair.core, "serial": pair.serial, "files": len(files), "release_sha256": pair.digest}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--source", type=Path, required=True)
    cli.add_argument("--destination", type=Path, required=True)
    cli.add_argument("--reviewed-sha256", required=True)
    cli.add_argument("--app", required=True)
    args = cli.parse_args()
    print(json.dumps(prepare(args.source, args.destination, args.reviewed_sha256, args.app), indent=2))


if __name__ == "__main__":
    main()
