# Stand-in for stable, sealed boot code. It runs only in the fixture RP2040.
import gc
import json
import machine
import os
import sys
import time

from paired_update_boot import _exists, _read, _sum, resume
import wedgie


def pause():
    while True:
        time.sleep_ms(100)


def boot():
    with open("fixture.json") as stream:
        fixture = json.load(stream)
    wedgie.RELEASE_KEYS = fixture["public"]

    def checkpoint(name):
        if not _exists("cut"):
            return
        with open("cut") as stream:
            match = name == stream.read()
        if match:
            os.remove("cut")
            os.sync()
            print("PAIR RESET", name)
            time.sleep_ms(200)
            machine.reset()

    base = "/pair"
    space = os.statvfs(base)
    print("PAIR PREBOOT", gc.mem_free(), space[1] * space[4], fixture["staged_bytes"])
    try:
        if not resume(base, wedgie.release_ok, checkpoint=checkpoint):
            raise RuntimeError("fixture lacks the approved stage")
    except Exception as err:
        assert _sum(base + "/live/main.py") == fixture["old_main"]
        assert _exists(base + "/approved.json")
        print("PAIR HOLD", err)
        return
    state = fixture["state"]
    assert _read(base + "/installed.json") == state
    assert _read(base + "/live/apps.json") == [state["app"]]
    assert not _exists(base + "/approved.json")
    assert not _exists(base + "/live/safe.py")
    with open(base + "/live/saves/test.json", "rb") as saved:
        assert saved.read() == b"local/devnet test fixture"
    assert all(_sum(base + "/live/" + n) == fixture["files"][n] for n in fixture["files"])
    print("PAIR READY", state["core"], state["app"]["v"], len(fixture["files"]))


try:
    boot()
except Exception as err:
    sys.print_exception(err)
    print("PAIR ERROR", err)
pause()
