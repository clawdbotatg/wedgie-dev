"""Use the real host upload/readback logic against the isolated RP2040 bridge."""

import argparse
from base64 import b64decode
import json
from pathlib import Path
import select
import subprocess
import tempfile

from paired_upload import Bundle, capture_signer, digest, healthy, offer, stage, verify_readback


class Emulator:
    def __init__(self, node):
        self.node = node

    def exchange(self, operation):
        stream = self.node.stdin
        stream.write(json.dumps(operation) + "\n")
        stream.flush()
        if not select.select([self.node.stdout], [], [], 180)[0]:
            raise TimeoutError("No reply from the virtual board")
        line = self.node.stdout.readline()
        if not line:
            raise RuntimeError("Virtual board stream ended unexpectedly")
        return json.loads(line)

    def request(self, message):
        return self.exchange({"request": message})

    def events(self, message, timeout):
        reply = self.request(message)
        yield reply
        if reply["type"] == "paired_ready":
            yield self.exchange({"fixture": "green"})


def signed_profiles(peer):
    return {name: peer.request({"type": "sol_status", "network": name})["profile"] for name in ("local", "devnet")}


def saves(peer):
    return {name: b64decode(peer.request({"type": "get", "path": "/saves/safe/" + name})["data"], validate=True)
            for name in ("solana_profile.json", "solana_devnet_profile.json", "pair-fixture.json")}


def check_named_hashes(peer, hashes):
    names = sorted(hashes)
    for offset in range(0, len(names), 8):
        group = names[offset:offset + 8]
        received = peer.request({"type": "sums", "names": group})
        if received["type"] != "sums" or received["sums"] != {name: hashes[name] for name in group}:
            raise ValueError("Named file hashes changed: " + ", ".join(group))


def check_signer(peer, hello, before, profiles, saved):
    if hello.get("app") != "safe-78" or hello.get("safe_state") != "ok":
        raise ValueError("The reviewed Safe v78 cartridge did not initialize")
    if hello["signer"] != before["signer"] or signed_profiles(peer) != profiles:
        raise ValueError("Saved signer or network profiles changed")
    for kind in ("sol_status", "sol_enroll", "sol_sign"):
        rejected = peer.request({"type": kind, "network": "mainnet"})
        if rejected["type"] != "error" or "unknown Solana network" not in rejected.get("error", ""):
            raise ValueError("Updated signer did not block mainnet " + kind)
    if saves(peer) != saved:
        raise ValueError("Saved fixture bytes changed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firmware", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    metadata = json.loads(Path(str(args.image) + ".host.json").read_text())
    shim = Path(__file__).with_name("paired_rp2040_peer.mjs")
    with tempfile.TemporaryDirectory(prefix="paired-host-fixture-") as directory:
        root = Path(directory)
        release = metadata["release"].encode()
        for dst, src in (("release.txt", "release"), ("release.sig", "sig"),
                         ("apps.txt", "shelf"), ("sizes.txt", "sizes")):
            (root / dst).write_text(metadata[src])
        for name, value in metadata["payload"].items():
            if Path(name).name != name or name in (".", ".."):
                raise ValueError("Unexpected fixture filename")
            (root / name).write_bytes(b64decode(value, validate=True))
        bundle = Bundle(root, digest(release))
        actual = metadata.get("fixture", "").startswith("actual-signer")
        versioned = metadata.get("fixture") == "actual-signer-core"
        with subprocess.Popen(["node", shim, args.firmware, args.image, metadata.get("fixture", "synthetic")], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True, bufsize=1) as node:
            try:
                peer = Emulator(node)
                first = peer.request({"type": "hello"})
                uid = first["uid"]
                healthy(first, uid)
                if first["carts"] != [metadata.get("old_cart", {"mod": "safe", "v": "70"})]:
                    raise ValueError("Expected the untouched starting app")
                before = None
                profiles = {}
                saved = {}
                if actual:
                    if first["app"] != "safe-77" or first["safe_state"] != "ok" or not first["signer"]:
                        raise ValueError("Expected the initialized Safe Signer")
                    before = capture_signer(peer, first)
                    profiles = before["profiles"]
                    if profiles != metadata["profiles"]:
                        raise ValueError("Unexpected starting Solana profile")
                    saved = saves(peer)
                if versioned:
                    if first["version"] != "0.3.91" or first.get("bench_runtime"):
                        raise ValueError("Unexpected starting core")
                    legacy = peer.request({"type": "job", "job": "Update core"})
                    if legacy.get("type") != "error" or "uses checked paired updates" not in legacy.get("error", ""):
                        raise ValueError("Legacy installer was accepted on an enrolled paired board")
                    check_named_hashes(peer, {**metadata["pinned"], **metadata["old_cartridge_files"]})
                staged = stage(peer, bundle)
                print("Staged the signed bundle without changing the live Safe cartridge.", flush=True)
                during = peer.request({"type": "hello"})
                healthy(during, uid)
                if during["carts"] != first["carts"]:
                    raise ValueError("Staging changed the live app")
                previews = []
                if not offer(peer, bundle, previews.append) or len(previews) != 1:
                    raise ValueError("Expected exactly one simulated green approval")
                print("One fixture GPIO approval matched the signed review.", flush=True)
                resets = peer.exchange({"fixture": "wait_boot"})["resets"]
                if resets != (1 if actual and not versioned else 2):
                    raise ValueError(f"Unexpected number of virtual resets: {resets}")
                files = verify_readback(peer, bundle, uid, before)
                final = peer.request({"type": "hello"})
                if actual:
                    check_signer(peer, final, first, profiles, saved)
                save = peer.request({"type": "get", "path": "/saves/safe/pair-fixture.json"})
                if b64decode(save["data"]) != b"fixture: leave intact":
                    raise ValueError("Saved fixture changed")
                cold = None
                if versioned:
                    if final.get("bench_runtime") != "executed new core 0.3.92":
                        raise ValueError("The authenticated replacement core did not execute")
                    check_named_hashes(peer, {**metadata["pinned"], **metadata["new_cartridge_files"]})
                    print("Recovered core 0.3.92 and Safe v78 with all profiles intact. Testing a fresh power cycle.", flush=True)
                    if peer.exchange({"fixture": "cold_boot"}) != {"cold_boot": True}:
                        raise ValueError("Expected a fresh power cycle")
                    verify_readback(peer, bundle, uid, before)
                    cold = peer.request({"type": "hello"})
                    check_signer(peer, cold, first, profiles, saved)
                    if cold["version"] != "0.3.92" or cold.get("bench_runtime") != final["bench_runtime"]:
                        raise ValueError("The authenticated replacement core did not persist across a power cycle")
                    check_named_hashes(peer, metadata["pinned"])
                args.report.write_text(json.dumps({
                    "scope": "signed host client over simulated sealed RP2040 USB",
                    "staged_release": staged["digest"], "physical_gpio_inputs": 1,
                    "reset_count": resets, "app_version": metadata.get("new_app_version", bundle.pair.app["v"]),
                    "cart_fingerprint": bundle.pair.app["v"],
                    "core_version": bundle.pair.core, "files_verified": files, "save_preserved": True,
                    "staging_preserved_cart_identity": True, "actual_signer_binary": actual,
                    "initial_paired_state_seeded_by_boot": metadata.get("initial_paired_state_seeded_by_boot", False),
                    **({"ethereum_signer_preserved": True, "solana_profiles_preserved": True,
                        "mainnet_refused": True, "baseline_free_heap": first.get("ram"),
                        "after_free_heap": final.get("ram")} if actual else {}),
                    **({"before_core_version": first["version"], "bench_executable": final["bench_runtime"],
                        "cold_boot_confirmed": True, "cold_boot_free_heap": cold.get("ram"),
                        "pinned_bootstrap_hashes_match": True, "verified_profile_files": len(saved),
                        "mainnet_refused_requests": ["sol_status", "sol_enroll", "sol_sign"]} if versioned else {}),
                }, indent=2) + "\n")
                print("Host client staged a signed pair, drove one virtual GPIO approval, and verified recovery and readback.")
            finally:
                node.stdin.close()
                try:
                    node.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    node.terminate()
                    node.wait(timeout=8)


if __name__ == "__main__":
    main()
