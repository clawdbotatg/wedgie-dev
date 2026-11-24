"""Offline client for a sealed, signed-pair staging session."""

import argparse
from base64 import b64encode
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
import time

from paired_update_boot import Pair

CHUNK = 1024
MAX_META = 8192
MAX_PAYLOAD = 2 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}")
UID = re.compile(r"[0-9a-f]{16}")


def check(condition, message):
    if not condition:
        raise ValueError(message)


def read_bounded(directory, name, limit):
    path = directory / name
    check(path.is_file() and not path.is_symlink(), "Expected a regular bundle file: " + name)
    with path.open("rb") as file:
        data = file.read(limit + 1)
    check(len(data) <= limit, "Bundle file is too large: " + name)
    return data


def digest(data):
    return sha256(data).hexdigest()


class Bundle:
    def __init__(self, directory, reviewed_hash):
        check(bool(SHA.fullmatch(reviewed_hash)), "Expected a reviewed release SHA-256")
        release, shelf, sizes = (
            read_bounded(directory, name, MAX_META) for name in ("release.txt", "apps.txt", "sizes.txt")
        )
        self.metadata = release + shelf + sizes
        check(0 < len(self.metadata) <= MAX_META, "Combined release metadata exceeds the device limit")
        check(digest(release) == reviewed_hash, "Release differs from the reviewed hash")
        self.signature = read_bounded(directory, "release.sig", 170).decode("ascii").strip()
        check(bool(re.fullmatch(r"[0-9a-f]{64} [0-9a-f]{64}(?: [012])?", self.signature)), "Invalid release signature encoding")
        # This verifies the caller's reviewed bytes. The board independently
        # authenticates the real signature against its installed trust roots.
        self.pair = Pair.parse(release, self.signature, shelf, lambda value, _: digest(value) == reviewed_hash)
        lengths = self.pair.sizes(sizes)
        check(sum(lengths.values()) <= MAX_PAYLOAD, "Payload exceeds the Pico bundle limit")
        self.files = {}
        for name, size in lengths.items():
            content = read_bounded(directory, name, size)
            check(len(content) == size and digest(content) == self.pair.files[name],
                  "Content differs from signed bundle: " + name)
            self.files[name] = content
        self.header = {"release_size": len(release), "shelf_size": len(shelf), "sizes_size": len(sizes),
                       "sig": self.signature}


def healthy(hello, uid):
    check(isinstance(hello, dict) and hello.get("type") == "hello" and hello.get("sealed") is True
          and hello.get("open") is False and hello.get("uid") == uid, "Expected the selected sealed Wedgie")


def response(peer, kind, **fields):
    reply = peer.request({"type": kind, **fields})
    check(isinstance(reply, dict), "Wedgie did not reply")
    check(reply.get("type") != "error", "Wedgie refused " + kind + ": " + str(reply.get("error", "unknown")))
    return reply


def tagged_bytes(data):
    return b64encode(data).decode("ascii")


def stage(peer, bundle):
    """Transfer only requested signed payload bytes and leave the release staged."""
    has_stage = False
    try:
        reply = response(peer, "paired_stage_begin", **bundle.header)
        has_stage = (reply.get("type") == "paired_stage_meta" and type(reply.get("offset")) is int
                     and reply["offset"] == 0)
        for offset in range(0, len(bundle.metadata), CHUNK):
            check(reply.get("type") == "paired_stage_meta" and type(reply.get("offset")) is int
                  and reply["offset"] == offset, "Unexpected metadata cursor")
            chunk = bundle.metadata[offset:offset + CHUNK]
            reply = response(peer, "paired_stage_meta", offset=offset, data=tagged_bytes(chunk))

        visited = set()
        name, offset = None, 0
        while reply.get("type") == "paired_stage_put":
            requested = reply.get("name")
            check(isinstance(requested, str) and requested in bundle.files, "Device requested a file outside the reviewed release")
            if requested != name:
                check(name is None or offset == len(bundle.files[name]), "Device skipped the remainder of a file")
                check(requested not in visited, "Device requested a completed file again")
                visited.add(requested)
                name, offset = requested, 0
            content = bundle.files[name]
            check(type(reply.get("offset")) is int and reply["offset"] == offset < len(content),
                  "Unexpected payload cursor")
            check(type(reply.get("size")) is int and reply["size"] == len(content)
                  and reply.get("digest") == bundle.pair.files[name], "Payload cursor differs from signed file")
            chunk = content[offset:offset + CHUNK]
            reply = response(peer, "paired_stage_put", name=name, offset=offset, data=tagged_bytes(chunk))
            offset += len(chunk)

        check(name is None or offset == len(bundle.files[name]), "Device ended transfer inside a file")
        check(reply.get("type") == "paired_staged" and reply.get("digest") == bundle.pair.digest,
              "Device did not confirm the reviewed staged digest")
        return reply
    except (Exception, KeyboardInterrupt) as error:
        if has_stage:
            try:
                cleanup = peer.request({"type": "paired_stage_abort"})
                check(isinstance(cleanup, dict) and cleanup.get("type") != "error", "Device did not acknowledge cleanup")
            except Exception as cleanup_error:
                error.add_note("Staging cleanup could not be confirmed: " + str(cleanup_error))
        raise


def offer(peer, bundle, on_ready):
    preview = False
    for reply in peer.events({"type": "paired_update"}, timeout=85):
        kind = reply.get("type")
        if kind == "refused":
            return False
        check(reply.get("digest") == bundle.pair.digest, "Device offered a different release. Do not approve it.")
        if kind == "paired_ready":
            check(not preview, "Received a second approval prompt")
            check(reply.get("core") == bundle.pair.core and reply.get("app") == bundle.pair.app["name"]
                  and reply.get("v") == bundle.pair.app["v"], "Device preview differs from the reviewed release")
            preview = True
            on_ready(reply)
        else:
            check(kind == "paired_accepted" and preview, "Missing verified device preview")
            return True
    raise TimeoutError("Device did not report an approval outcome")


def matches_release(hello, bundle):
    return (hello.get("version") == bundle.pair.core and hello.get("running") == bundle.pair.app["mod"]
            and any(cart.get("mod") == bundle.pair.app["mod"] and cart.get("v") == bundle.pair.app["v"]
                    for cart in hello.get("carts", [])))


def capture_signer(peer, hello):
    """Keep the existing wallet identities in memory until readback."""
    state, signer = hello.get("safe_state"), hello.get("signer")
    check(hello.get("running") == "safe" and (
        (state == "ok" and isinstance(signer, str) and bool(signer))
        or (state == "none" and signer is None)), "Safe Signer is not in a usable state")
    profiles = None
    if hello.get("solana_protocol"):
        profiles = {}
        for network in ("local", "devnet"):
            reply = response(peer, "sol_status", network=network)
            profile = reply.get("profile")
            check(reply.get("type") == "sol_ok" and "profile" in reply and (
                profile is None or (isinstance(profile, dict) and profile.get("network") == network)),
                "Unable to verify Solana " + network + " profile")
            profiles[network] = profile
    return {"state": state, "signer": signer, "profiles": profiles}


def verify_readback(peer, bundle, uid, before=None):
    hello = response(peer, "hello")
    healthy(hello, uid)
    check(matches_release(hello, bundle), "Reconnected board is not running the approved release")
    if before is not None:
        after = capture_signer(peer, hello)
        check(before["state"] == after["state"] and before["signer"] == after["signer"],
              "Ethereum signer identity or status changed")
        if before["profiles"] is not None:
            check(before["profiles"] == after["profiles"], "Saved Solana profiles changed")
    hashes = dict(bundle.pair.files, serial=digest(str(bundle.pair.serial).encode()))
    names = sorted(hashes)
    for start in range(0, len(names), 8):
        group = names[start:start + 8]
        reply = response(peer, "sums", names=group)
        check(reply.get("type") == "sums" and all(reply.get("sums", {}).get(n) == hashes[n] for n in group),
              "Post-reboot signed file check failed")
    return len(bundle.pair.files)


class SerialPeer:
    def __init__(self, board):
        self.board = board

    def request(self, message):
        return self.board.request(message, timeout=20)

    def events(self, message, timeout):
        board = self.board
        mid = board.id
        board.id += 1
        board.s.reset_input_buffer()
        board.buf = b""
        board.s.write((json.dumps(dict(message, id=mid)) + "\n").encode())
        for line in board._lines(lambda _: False, timeout):
            if not line.startswith("{"):
                continue
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if isinstance(reply, dict) and reply.get("id") == mid:
                yield reply
                if reply.get("type") != "paired_ready":
                    return


def wait_for_install(board, bundle, uid, seconds=85):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not board.reopen(min(4, deadline - time.monotonic())):
            continue
        try:
            hello = board.hello(timeout=3)
        except OSError:
            hello = None
        if hello:
            healthy(hello, uid)
            if matches_release(hello, bundle):
                return
    raise TimeoutError("Board accepted the update. Reconnect for readback before retrying.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path, help="local fw directory containing the signed pair")
    parser.add_argument("--release-sha256", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--uid", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--offer", action="store_true", help="stage and show the pair for one physical confirmation")
    mode.add_argument("--offer-staged", action="store_true", help="offer the exact pair already staged on the board")
    args = parser.parse_args()
    check(bool(UID.fullmatch(args.uid)), "Expected the selected board's exact hexadecimal UID")
    bundle = Bundle(args.bundle, args.release_sha256)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public"))
    from wedgie import Wedgie

    board = Wedgie(args.port)
    try:
        peer = SerialPeer(board)
        hello = response(peer, "hello")
        healthy(hello, args.uid)
        applies = args.offer or args.offer_staged
        before = capture_signer(peer, hello) if applies and bundle.pair.app["mod"] == "safe" else None
        if not args.offer_staged:
            receipt = stage(peer, bundle)
            print(json.dumps(receipt), flush=True)
        if applies:
            def cue(preview):
                print(f"Check {preview['app']} v{preview['v']} and core {preview['core']} on the board, then press green.",
                      file=sys.stderr, flush=True)

            if not offer(peer, bundle, cue):
                print(json.dumps({"type": "refused"}))
                return 2
            wait_for_install(board, bundle, args.uid)
            files = verify_readback(peer, bundle, args.uid, before)
            print(json.dumps({"type": "verified", "release_sha256": bundle.pair.digest, "files": files}))
        return 0
    finally:
        board.close()


if __name__ == "__main__":
    raise SystemExit(main())
