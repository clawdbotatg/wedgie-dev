# Checked installs: the wedgie puts software on itself, so the computer never gets the REPL.
#
#   {"type":"job","job":"Install Buttons","version":"0.3.10","write":[names],"delete":[names],
#    "apps":<apps.json text or null>}
#
# The question goes up the moment that arrives ("Install Buttons?"). Nothing before it reads the flash
# or checks a signature: the person sees it in milliseconds. A no answers {"type":"refused"}. A yes
# answers {"type":"go"}, and until the job ends nothing else runs (under the boot bar):
#   {"type":"apps","t":<whole lines>}                   -> {"type":"ok"}   (0.3.66+, before the release: the app
#        list, release/apps.txt, in pieces. Hashed whole; only the blocks of the app it puts on and the one it runs are
#        kept. The signed list names its hash, "@apps": a list of every app's files no longer has to fit one USB line)
#   {"type":"release","release":<release.txt>,"sig":"<r> <s>"} -> {"type":"ok"}  the signed list (our key,
#        wedgie.release_ok: 0.2 s on a Trust M, else 2.4 s of pure-Python P-256) must name every file to write and be that version
#   {"type":"sums","names":[..],"exists":[..]}           -> {"type":"sums"}  what's on it already
#   {"type":"put","name":n,"data":<base64>,"end":bool}  -> {"type":"ok"}   (chunks, in order)
#   {"type":"commit"}                                    -> {"type":"done"}, then a soft reset
#   {"type":"abort"}, a bad file, or 30 s of nothing     -> the job ends, nothing changed
# Each file goes to a temp file, hashed as it comes. A job accepts one signed list only. On commit,
# every required app file (and the whole core for a core update) must match that list: one that came,
# or one hashed on the flash at commit. The host's write list cannot omit required files. Then uploads
# are renamed into place (main.py last), the deletes happen and apps.json is written. Saves (/saves)
# and the core's own boot files can't be deleted. 0.3.0-0.3.9 took the release in the job itself
# (hello "jobs": 1); a job that carries one still works that way. Outside a job, {"type":"sums"} works
# too. Only the slot (and the Wallet, which forwards these) calls this.
import sys, os, json, time, gc, select, hashlib, binascii
import wedgie as W

KEEP = ("main.py", "boot.py", "wedgie.py", "slot.py", "lcd.py", "job.py", "p256.py", "loader.py", "serial", "modified",
        "wedgie.mpy", "slot.mpy", "lcd.mpy", "job.mpy", "p256.mpy", "loader.mpy")    # 0.3.14+: the core is compiled
IDLE_MS = 30000
DOG_MS = 8000       # a raw put's bytes stop for this long: stop (_dog)


sums = W.sums           # it lives in wedgie.py: the slot answers sums without loading this file


def _tmp(n):
    return "_job_" + n


def _clean(names):
    for n in names:
        try:
            os.remove(_tmp(n))
        except OSError:
            pass


_OK = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-."


def _plain(n):
    """A file at the top of the flash, by its one real name: no folders, no ./ or ../ (./main.py was
    main.py to os.remove, past every check on the name)."""
    return isinstance(n, str) and 0 < len(n) <= 64 and n[0] != "." and all(c in _OK for c in n)


def rules(m):
    """What a job may ask for before its list is checked: raises ValueError."""
    for n in m.get("delete") or []:
        if not _plain(n) or n in KEEP or n.startswith("saves") or n in ("apps.json", "error.log"):
            raise ValueError("can't delete %s" % n)
    for n in m.get("write") or []:
        if not _plain(n):
            raise ValueError("can't write %s" % n)
    if m.get("apps") is not None:
        a = json.loads(m["apps"])
        if not isinstance(a, list) or len(a) > 1 or not all(isinstance(x, dict) for x in a):
            raise ValueError("a job puts on one app at most")


def _ver(v):
    return tuple(int(x) for x in v.split("."))


def _files_of(a, signed):
    """The files of app a (an apps.json entry) and their .py/.mpy twins: from the signed list for a shelf
    app, from its own entry for an app from a repo, else just its module. None: nothing."""
    if not a or not a.get("mod"):
        return set()
    s = signed.get(a["mod"])
    names = (s and s.get("files")) or (a.get("files") if isinstance(a.get("files"), list) else None) or [a["mod"] + ".py"]
    out = set()
    for n in names:
        if isinstance(n, str):
            out.add(n)
            if n.endswith(".mpy"):
                out.add(n[:-4] + ".py")
            elif n.endswith(".py"):
                out.add(n[:-3] + ".mpy")
    return out


class Apps:
    """The app list (release/apps.txt, 0.3.66+) as it comes, in pieces of whole lines: each app's "@app  <json>",
    then its "<sha256>  <name>" lines. All of it is hashed (check holds it to the signed list's "@apps"); only
    the apps in keep are kept, and of their lines only the files they name."""
    def __init__(self, keep):
        self.h, self.keep, self.cur, self.apps, self.files, self.sum = hashlib.sha256(), keep, None, {}, {}, None

    def feed(self, t):
        if self.sum or t and t[-1] != "\n":
            raise ValueError("a piece ends in a whole line")
        self.h.update(t.encode())
        for l in t.split("\n")[:-1]:
            if l.startswith("@app  "):
                a = json.loads(l[6:])
                self.cur = a if a.get("mod") in self.keep else None
                if self.cur:
                    self.apps[a["mod"]] = a
            elif self.cur:
                h, n = l.split("  ", 1)
                if n in (self.cur.get("files") or ()):
                    self.files[n] = h

    def done(self):
        self.sum = self.sum or binascii.hexlify(self.h.digest()).decode()
        return self.sum


def release_sum(text):
    """The signed list's "@apps  <sha256>" (0.3.66+; tools/release.mjs): the hash of the app list, which comes on
    its own (Apps). The apps' lines filled the one 6 KB USB line the list rides. None: an older list, its apps in it.
    Here, not in wedgie.py: that one stays loaded beside every app (Safe Signer's heap, tools/safechip.mjs)."""
    for l in text.split("\n")[2:]:
        if l.startswith("@apps  "):
            return l[7:]
    return None


def keep(m):
    """The apps a job's app list keeps: the one it puts on and the one it runs."""
    out = set()
    try:
        out.update(a.get("mod") for a in json.loads(m["apps"]))
    except Exception:
        pass
    a = W.active()
    if a:
        out.add(a.get("mod"))
    return out


def check(m, sig=True, tick=None):
    """The job against its signed list: (version, {name: sha}, required names) or raises ValueError. sig=False skips the
    signature (0.2 s on a Trust M, else pure-Python P-256: 2.4 s on an RP2040), which run() checks after the yes.
    Signed too (0.3.12+): which app it puts on and what it may touch. The host says only which signed
    app (its mod); apps.json is written from the signed "@app" line (a host once named wedgie.set_open
    as an app's entry: Ctrl-C on at the next boot). "Install X" must put on the signed app named X; a
    job that doesn't change the app (an update, taking it off) keeps the one it runs. It writes only the
    core and that app's files, and deletes nothing of the core."""
    rel = m.get("release") or ""
    if sig and (not W.RELEASE_KEYS or not W.release_ok(rel.encode(), m.get("sig") or "", tick)):
        raise ValueError("not signed by wedgie.dev")
    version, files = W.release_files(rel)
    if _ver(version) < _ver(W.VERSION):  # an old signed list puts back an old core and its holes (audit 10-16:
        raise ValueError("older than this wedgie: %s" % version)   # 0.3.47's boot.py let a host in, still signed)
    if W.release_serial(rel) < W.serial():  # the same version is signed again and again (0.3.52: 7 lists): an
        raise ValueError("an older signed list than the one on it")   # older one puts back old apps (audit 10-18)
    if m.get("version") and version != m["version"]:    # the question showed the host's version: it must be this one
        raise ValueError("the signed list is %s, not %s" % (version, m["version"]))
    rules(m)
    signed = W.release_apps(rel)
    tag = release_sum(rel)
    if tag is not None:                 # 0.3.66+: the apps came on their own (Apps), named by their hash
        al = m.get("_apps")
        if al is not None:
            if al.done() != tag:
                raise ValueError("the app list isn't the signed one")
            signed.update(al.apps)
            for n, h in al.files.items():
                if files.get(n, h) != h:
                    raise ValueError("%s is in the list twice" % n)
                files[n] = h
    required = set(m.get("write") or ())
    if signed or tag is not None:       # (a list from before 0.3.12 has none: files only, as then)
        appf = set()
        for a in signed.values():
            appf.update(a.get("files") or ())
        core = [n for n in files if n not in appf]
        now = W.active()
        app = now and now.get("mod")    # the app it runs now
        mine = _files_of(now, signed)   # its files: what replacing or uninstalling it may take off
        want = json.loads(m["apps"]) if m.get("apps") is not None else None
        title = str(m.get("job"))
        # One job does one thing, and only what its question said (0.3.53; EXPECTATIONS.md: the person
        # knows exactly what they say yes to). The title decides the kind (codex 2026-10-03: "Install
        # Buttons" with no app uninstalled Hello); the question shows it (slot.ask), and here the job is
        # held to it: "Install X" writes only X's files and takes off only the app it replaces; "Update
        # firmware" writes only the core and takes nothing off; an uninstall takes off only its app.
        if title.startswith("Install "):        # puts on the signed app with that name
            a = signed.get(want[0].get("mod")) if want else None
            if not a or a["name"] != title[8:]:
                raise ValueError("this job said %r but puts on %s" % (title, want and want[0].get("mod")))
            e = dict((k, a[k]) for k in ("mod", "name", "entry", "usb") if k in a)
            e["v"] = str(want[0].get("v") or "")[:16]       # the site's: cosmetic, nothing runs them
            e["about"] = str(want[0].get("about") or "")[:100]
            m["apps"] = json.dumps([e])
            may_write = set(a.get("files") or ())
            may_delete = set() if a["mod"] == app else mine
        elif title == "Update firmware":       # keeps the app it runs, and apps.json as it says
            if want is not None and [x.get("mod") for x in want] != ([app] if app else []):
                raise ValueError("a firmware update keeps the app it runs")
            if want:
                m["apps"] = json.dumps([dict(now, v=str(want[0].get("v") or "")[:16])])
            may_write, may_delete = set(core), set()
            required.update(core)
        elif title in ("Uninstall the app", "Take its app off"):   # no app after it, nothing written
            if want != []:
                raise ValueError("an uninstall only takes the app off")
            may_write, may_delete = set(), mine
        else:
            raise ValueError("not a job this wedgie knows: %r" % title)
        if title.startswith("Install "):
            required.update(may_write)  # the whole app, as signed
        after = json.loads(m["apps"]) if m.get("apps") is not None else ([now] if now else [])
        s = after and signed.get(after[0].get("mod"))
        if not after or s:              # all the core and the app it runs after this, as signed: it clears the mark
            m["clean"] = core + list(s and s.get("files") or ())
        for n in m.get("write") or []:
            if n not in may_write:
                raise ValueError("%s isn't part of this job" % n)
        for n in m.get("delete") or []:
            if n not in may_delete:
                raise ValueError("%s isn't part of this job" % n)
    elif m.get("apps") is not None:
        raise ValueError("this signed list names no apps")
    for n in m.get("write") or []:
        if n not in files:
            raise ValueError("%s isn't in the signed list" % n)
    if any(n not in files for n in required):
        raise ValueError("required file isn't in the signed list")
    return version, files, required


def _dog(_):
    """A raw put's bytes stopped mid-put (the computer's tab closed, its USB went): its read would wait for good.
    Nothing was written to a live file yet, so restart on the old ones, as an install that ends does (resume)."""
    W.log("install stopped: its bytes stopped coming for %d s" % (DOG_MS // 1000))
    restart()


def _err(qid, e):
    """An install stops on a bad request: the host hears why, and the log keeps it (wedgie.py debug)."""
    W.send({"id": qid, "type": "error", "error": e})
    W.log("install stopped:", e[:80])


def _nope(mid, e):
    """A check failed after the yes: tell the host, and the person on its screen for a few seconds (0.3.55
    and before only restarted, saying nothing: Austin, 10-19). Nothing was written."""
    W.send({"id": mid, "type": "error", "error": str(e)})
    W.log("install stopped:", str(e)[:80])
    try:
        import lcd, ui
        d = lcd.LCD()
        ui.page(d, "Not installed", [(str(e)[:56], ui.RED)], show=False)
        if d.width >= 240:
            ui.warn(d, 112, 52)
        d.show()
        ui.wait(lcd.Keys(physical=True), 5000)
    except Exception as x:
        print("job: screen:", x)


_prog = None     # [title, the boot bar, the line under it] while the job runs
_ver_line = ""   # the app's version under the title (the job's "ver": cosmetic, the site's words)


def progress(title, what, p):
    """The screen during a job: the boot screen and the boot bar (loader.screen). what=None keeps the
    line under the bar; the bar only moves forward, and a move redraws only what it filled."""
    global _prog
    import ui, loader
    if not _prog or _prog[0] != title:
        _prog = [title, ui.progress(title.replace("...", ""), what or "", True, _ver_line), what]
    elif what is not None and what != _prog[2]:
        loader.what(what)
        _prog[2] = what
    if _prog[1]:
        _prog[1].to(max(0, min(1, p)))


# The bar moves by time, not by step: each part of a job gets the share of the bar it takes of the
# job's time, so it never sits still (without a Trust M the signature is 2.4 s of a 4 s app install, and sat at 0).
# ms, measured on the virtual RP2040 (tools/chipprobe.mjs --log, firmware 0.3.12): the yes to the job
# running again after the restart, the P-256 check, the sums, the commit. Re-measure on a real board.
RESTART, SIG, SUMS, COMMIT = 1600, 3100, 500, 300
PER_KB = 400        # one 1 KB put: reading its 1.4 KB line a char at a time, json, base64, sha, flash
PER_KB_RAW = 60     # a raw put (0.3.16+): a short header line, then 4 KB read in one go, sha, flash (chipprobe: 45 KB in 2.6 s)
RAW = 4096          # the most bytes one raw put carries (hello "bin")



class Plan:
    """Where on the bar each part of a job starts. nbytes: what the host will send (the job's "bytes";
    older hosts don't say, so 6 KB a file is assumed)."""
    def __init__(self, nbytes, raw=False):
        self.files = max(1, nbytes)
        parts = (("restart", RESTART), ("sig", SIG), ("sums", SUMS), ("files", self.files * (PER_KB_RAW if raw else PER_KB) // 1024), ("commit", COMMIT))
        total = sum(ms for _, ms in parts)
        self.at0, at = {}, 0
        for k, ms in parts:
            self.at0[k] = (at / total, ms / total)
            at += ms

    def at(self, part, frac=0):
        a, w = self.at0[part]
        return a + w * max(0, min(1, frac))


def resume(j):
    """Install mode (main.py, before anything else loads): the job the person said yes to before the
    restart (wedgie.take_job). Then a restart, whatever happened: into the new files after a commit,
    into the old ones otherwise."""
    import machine
    W.asked_ms = j.get("asked_ms")
    try:
        run(j.get("id"), j.get("m") or {}, lambda *a: True, progress)
    except Exception as e:
        W.failed(j.get("id"), e)
    time.sleep_ms(500)                  # the last answer gets out before the reset drops USB
    W.restarting = True
    restart()


def restart():
    """The install's last restart: a hard reset, so the app starts as it does at a plug-in (fresh USB, SPI,
    timers). It was a soft reset (scratch2 0xD21E: main.py added the drive back) and that hung now and then:
    the app's bar full and green, USB gone, no "on" in the log until a replug (0.3.55-0.3.57; Austin 10-20,
    twice in a row on a real board). scratch0 cleared: boot.py adds the WEDGIE drive as at power-up;
    scratch1 0xC01D: it sets the panel up again (slot._cold)."""
    import machine, sys
    try:
        b = (0x400D8000 if "RP2350" in sys.implementation._machine else 0x40058000) + 0x0C
        machine.mem32[b] = 0
        machine.mem32[b + 4] = 0xC01D
    except Exception:
        pass                                # (the emulator: no mem32)
    machine.reset()


def run(mid, m, ask, show=None):
    """Ask, then check and take the files. ask(job, checked, version) -> bool is the slot's yes/no screen (the slot
    asks a 0.3.10+ job itself before loading this, and passes a yes); show(title, what, p) draws the
    progress screen (the moment A is pressed, then as files arrive)."""
    global _ver_line
    show = show or (lambda *a: None)
    _ver_line = str(m.get("ver") or "")[:20]
    late = "release" not in m           # the list comes after the yes (0.3.10+ hosts)
    sn = 0                              # the signed list's serial: kept at commit (wedgie.SERIAL)
    try:
        if late:
            rules(m)
            version = m.get("version")
        else:
            version, files, required = check(m, sig=False)
            sn = W.release_serial(m["release"])
    except ValueError as e:
        W.send({"id": mid, "type": "error", "error": str(e)})
        return
    write = list(m.get("write") or [])
    title = str(m.get("job") or "Update")[:60]
    if not ask(title, True, version):
        W.send({"id": mid, "type": "refused"})
        return
    title = W.doing(title)
    plan = Plan(m.get("bytes") or 6144 * len(write), bool(m.get("raw")))
    sig_tick = lambda f: show(title, None, plan.at("sig", f))
    if late:
        files = None
        required = set()
        show(title, "starting", plan.at("sig"))
    else:
        show(title, "checking the signature", plan.at("sig"))
        try:
            version, files, required = check(m, tick=sig_tick)
        except ValueError as e:
            _nope(mid, e)
            return
        show(title, "starting", plan.at("sums"))
    W.send({"id": mid, "type": "go", "asked_ms": W.asked_ms})
    sent, todo = 0, plan.files              # bytes that came, bytes still to come (less what's there already)
    got = {}                                # name -> sha256 of what arrived
    h, f, cur = None, None, None
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    R = W.lines()                           # the one line reader: never a string grown per char (wedgie.Lines)
    buf = bytearray(RAW)                    # raw puts land here: made once, on install mode's clean heap
    bv = memoryview(buf)
    last, qid, t, dog = time.ticks_ms(), mid, "go", None
    gc.collect()
    try:
        while time.ticks_diff(time.ticks_ms(), last) < IDLE_MS:
            line = R.pump(poll, 50)
            if not line:
                continue
            last = time.ticks_ms()
            try:
                q = json.loads(line)
            except ValueError:
                continue
            line = None
            qid, t = q.get("id"), q.get("type")
            if t == "apps":
                if files is not None:
                    _err(qid, "the app list comes before the signed list")
                    return
                try:
                    m.setdefault("_apps", Apps(keep(m))).feed(q.get("t") or "")
                except ValueError as e:
                    _err(qid, str(e))
                    return
                q = None
                last = time.ticks_ms()
                W.send({"id": qid, "type": "ok"})
            elif t == "release":
                if files is not None:
                    _err(qid, "one signed list per job")
                    return
                show(title, "checking the signature", plan.at("sig"))
                try:
                    m["release"], m["sig"] = q.get("release") or "", q.get("sig") or ""
                    version, files, required = check(m, tick=sig_tick)
                    sn = W.release_serial(m["release"])
                except ValueError as e:
                    _nope(qid, e)
                    return
                m.pop("release", None)      # the list: files has what's needed from it
                m.pop("_apps", None)
                gc.collect()
                show(title, "looking at what's on it", plan.at("sums"))
                last = time.ticks_ms()
                W.send({"id": qid, "type": "ok", "version": version})
            elif t == "sums":
                show(title, "looking at what's on it", plan.at("sums"))
                v = sums(q.get("names"), q.get("exists"))
                for n in q.get("names") or []:
                    if files and v.get(n) == files.get(n):      # already there: it won't be sent
                        try:
                            todo -= os.stat(n)[6]
                        except OSError:
                            pass
                todo = max(1, todo)
                show(title, None, plan.at("files"))
                last = time.ticks_ms()
                W.send({"id": qid, "type": "sums", "sums": v, "apps": W.apps()})
            elif t == "put":
                n = q.get("name")
                if files is None:
                    _err(qid, "the signed list comes first")
                    return
                if n not in write:
                    _err(qid, "%s isn't in this job" % n)
                    return
                if n != cur:                # a new upload: whatever was checked under this name isn't any more
                    if f:                   # (a finished file sent again was committed as the new bytes,
                        f.close()           # unchecked: codex 2026-10-02)
                    got.pop(n, None)
                    f, h, cur = open(_tmp(n), "wb"), hashlib.sha256(), n
                end = q.get("end")
                k = q.get("n")
                if k is not None:           # raw (0.3.16+): k bytes follow this line, no base64
                    if not isinstance(k, int) or k < 0 or k > RAW:
                        _err(qid, "a raw put is 0..%d bytes" % RAW)
                        return
                    b = bv[:k]
                    if dog is None:         # Lines.raw's read can block for good if bytes stop mid-put (the tab
                        dog = False         # closed): a timer then logs it and restarts on the old files (0.3.63)
                        if sys.implementation.name == "micropython":     # (not tools/test_job.py's CPython)
                            from machine import Timer
                            dog = Timer(-1)
                    if dog:
                        dog.init(period=DOG_MS, mode=dog.ONE_SHOT, callback=_dog)
                    try:
                        R.raw(b, poll)
                    finally:
                        if dog:
                            dog.deinit()
                else:
                    b = binascii.a2b_base64((q.pop("data", None) or "").encode())
                q = None
                f.write(b)
                h.update(b)
                sent += len(b)
                show(title, n, plan.at("files", sent / todo))
                if end:
                    f.close()
                    f, cur = None, None
                    got[n] = binascii.hexlify(h.digest()).decode()
                    if got[n] != files[n]:
                        _err(qid, "%s doesn't match the signed list" % n)
                        return
                W.send({"id": qid, "type": "ok"})
                gc.collect()
            elif t == "commit":
                if files is None:
                    _err(qid, "the signed list comes first")
                    return
                if cur is not None:
                    _err(qid, "%s isn't finished" % cur)
                    return
                show(title, "restarting", plan.at("commit"))
                # Recheck existing required files here, even when the host never asked for their sums.
                # No live files change until the complete signed app/core has been verified.
                existing = sums([n for n in required if n not in got])
                missing = [n for n in required if got.get(n, existing.get(n)) != files[n]]
                if missing:
                    _err(qid, "not sent: " + " ".join(missing))
                    return
                for n in sorted(got, key=lambda n: n == "main.py"):     # main.py last
                    try:                # one step: littlefs renames over the old file, so a power cut leaves the
                        os.rename(_tmp(n), n)   # old main.py or the new one, never none (audit 10-18)
                    except OSError:     # a file system that won't rename over a file
                        os.remove(n)
                        os.rename(_tmp(n), n)
                for n in required:
                    if n.endswith(".mpy") and n[:-4] + ".py" not in required:
                        # Remove unsigned shadows even when the signed .mpy was already present.
                        try:
                            os.remove(n[:-4] + ".py")
                        except OSError:
                            pass
                for n in m.get("delete") or []:
                    try:
                        os.remove(n)
                    except OSError:
                        pass
                if m.get("apps") is not None:
                    with open("apps.json", "w") as a:
                        a.write(m["apps"])
                if sn > W.serial():
                    with open(W.SERIAL, "w") as a:
                        a.write(str(sn))
                c = m.get("clean")      # full control left the red border (wedgie.MARK): gone once every file it
                if c and sums((), [W.MARK])[W.MARK] and all(v == files.get(n) for n, v in sums(c).items()) and not any(
                        sums((), [n[:-4] + ".py" for n in c if n.endswith(".mpy")]).values()):    # runs is as signed again
                    try:
                        os.remove(W.MARK)
                    except OSError:
                        pass
                show(title, None, 1)
                W.log("installed", title, version)
                W.send({"id": qid, "type": "done", "version": version})
                write = []
                time.sleep_ms(500)          # "done" gets out before the reset drops USB (100 ms lost it now and then)
                W.restarting = True         # main.py lets this SystemExit through
                restart()
                return                      # (the emulator's soft_reset returns: it restarts once this does)
            elif t == "abort":
                W.send({"id": qid, "type": "ok"})
                W.log("install stopped: the computer said stop", title)
                return
            elif t == "hello":              # job: a host whose port dropped at the restart finds the job here
                W.send(W.hello(qid, job=True, asked_ms=W.asked_ms))
        W.log("install stopped: nothing from the computer for %d s after %s, %d bytes in" % (IDLE_MS // 1000, t, sent), title)
    except Exception as e:                  # out of memory, a full flash...: nothing changed, it restarts
        W.failed(qid, e)
    finally:
        if f:
            f.close()
        _clean(write)
