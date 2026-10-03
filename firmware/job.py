# Checked installs: the wedgie puts software on itself, so the computer never gets the REPL.
#
#   {"type":"job","job":"Install Buttons","version":"0.3.10","write":[names],"delete":[names],
#    "apps":<apps.json text or null>}
#
# The question goes up the moment that arrives ("Install Buttons?"). Nothing before it reads the flash
# or checks a signature: the person sees it in milliseconds. A no answers {"type":"refused"}. A yes
# answers {"type":"go"}, and until the job ends nothing else runs (under the boot bar):
#   {"type":"release","release":<release.txt>,"sig":"<r> <s>"} -> {"type":"ok"}  the signed list (our key,
#        wedgie.release_ok: seconds of pure-Python P-256) must name every file to write and be that version
#   {"type":"sums","names":[..],"exists":[..]}           -> {"type":"sums"}  what's on it already
#   {"type":"put","name":n,"data":<base64>,"end":bool}  -> {"type":"ok"}   (chunks, in order)
#   {"type":"commit"}                                    -> {"type":"done"}, then a soft reset
#   {"type":"abort"}, a bad file, or 30 s of nothing     -> the job ends, nothing changed
# Each file goes to a temp file, hashed as it comes; on commit every file in write must match its line
# in the list: one that came, or one already on it (this job's sums said so), then the ones that came
# are renamed into place (main.py last), the deletes happen and apps.json is written. Saves (/saves)
# and the core's own boot files can't be deleted. 0.3.0-0.3.9 took the release in the job itself
# (hello "jobs": 1); a job that carries one still works that way. Outside a job, {"type":"sums"} works
# too. Only the slot (and the Wallet, which forwards these) calls this.
import sys, os, json, time, gc, select, hashlib, binascii
import wedgie as W

KEEP = ("main.py", "boot.py", "wedgie.py", "slot.py", "lcd.py", "job.py", "p256.py", "loader.py")
IDLE_MS = 30000


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


def check(m, sig=True, tick=None):
    """The job against its signed list: (version, {name: sha}) or raises ValueError. sig=False skips the
    signature (pure-Python P-256: 2.2 s on an RP2040), which run() checks after the yes.
    Signed too (0.3.12+): which app it puts on and what it may touch. The host says only which signed
    app (its mod); apps.json is written from the signed "@app" line (a host once named wedgie.set_open
    as an app's entry: Ctrl-C on at the next boot). "Install X" must put on the signed app named X; a
    job that doesn't change the app (an update, taking it off) keeps the one it runs. It writes only the
    core and that app's files, and deletes nothing of the core."""
    rel = m.get("release") or ""
    if sig and (not W.RELEASE_KEY[0] or not W.release_ok(rel.encode(), m.get("sig") or "", tick)):
        raise ValueError("not signed by wedgie.dev")
    version, files = W.release_files(rel)
    rules(m)
    signed = W.release_apps(rel)
    if signed:                          # (a list from before 0.3.12 has none: files only, as then)
        appf = set()
        for a in signed.values():
            appf.update(a.get("files") or ())
        core = [n for n in files if n not in appf]
        now = W.active()
        app = now and now.get("mod")    # the app it runs now
        want = json.loads(m["apps"]) if m.get("apps") is not None else None
        title = str(m.get("job"))
        # What the person said yes to is what happens: the title decides the kind of job, and the job
        # must be exactly that (codex 2026-10-03: "Install Buttons" with no app uninstalled Hello).
        if title.startswith("Install "):        # puts on the signed app with that name
            a = signed.get(want[0].get("mod")) if want else None
            if not a or a["name"] != title[8:]:
                raise ValueError("this job said %r but puts on %s" % (title, want and want[0].get("mod")))
            app = a["mod"]
            e = dict((k, a[k]) for k in ("mod", "name", "entry", "usb") if k in a)
            e["v"] = str(want[0].get("v") or "")[:16]       # the site's: cosmetic, nothing runs them
            e["about"] = str(want[0].get("about") or "")[:100]
            m["apps"] = json.dumps([e])
        elif title == "Update firmware":       # keeps the app it runs, and apps.json as it says
            if want is not None and [x.get("mod") for x in want] != ([app] if app else []):
                raise ValueError("a firmware update keeps the app it runs")
            if want:
                m["apps"] = json.dumps([dict(now, v=str(want[0].get("v") or "")[:16])])
        elif title in ("Uninstall the app", "Take its app off"):   # no app after it, nothing written
            if want != [] or m.get("write"):
                raise ValueError("an uninstall only takes the app off")
            app = None
        else:
            raise ValueError("not a job this wedgie knows: %r" % title)
        own = (signed.get(app) or {}).get("files") or ()
        for n in m.get("write") or []:
            if n not in core and n not in own:
                raise ValueError("%s isn't part of this job" % n)
        for n in m.get("delete") or []:
            if n in core or n in own:
                raise ValueError("can't delete %s" % n)
    elif m.get("apps") is not None:
        raise ValueError("this signed list names no apps")
    for n in m.get("write") or []:
        if n not in files:
            raise ValueError("%s isn't in the signed list" % n)
    return version, files


_prog = None     # [title, the boot bar, the line under it] while the job runs


def progress(title, what, p):
    """The screen during a job: the boot screen and the boot bar (loader.screen). what=None keeps the
    line under the bar; the bar only moves forward, and a move redraws only what it filled."""
    global _prog
    import ui, loader
    if not _prog or _prog[0] != title:
        _prog = [title, ui.progress(title.replace("...", ""), what or ""), what]
    elif what is not None and what != _prog[2]:
        loader.what(what)
        _prog[2] = what
    if _prog[1]:
        _prog[1].to(max(0, min(1, p)))


# The bar moves by time, not by step: each part of a job gets the share of the bar it takes of the
# job's time, so it never sits still (the signature is 2.2 s of a 4 s app install, and sat at 0).
# ms, measured on the virtual RP2040 (tools/chipprobe.mjs --log, firmware 0.3.12): the yes to the job
# running again after the restart, the P-256 check, the sums, the commit. Re-measure on a real board.
RESTART, SIG, SUMS, COMMIT = 1600, 3100, 500, 300
PER_KB = 400        # one 1 KB put: reading its 1.4 KB line a char at a time, json, base64, sha, flash


class Plan:
    """Where on the bar each part of a job starts. nbytes: what the host will send (the job's "bytes";
    older hosts don't say, so 6 KB a file is assumed)."""
    def __init__(self, nbytes):
        self.files = max(1, nbytes)
        parts = (("restart", RESTART), ("sig", SIG), ("sums", SUMS), ("files", self.files * PER_KB // 1024), ("commit", COMMIT))
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
    time.sleep_ms(100)
    W.restarting = True
    machine.soft_reset()


def run(mid, m, ask, show=None):
    """Ask, then check and take the files. ask(job, note) -> bool is the slot's yes/no screen (the slot
    asks a 0.3.10+ job itself before loading this, and passes a yes); show(title, what, p) draws the
    progress screen (the moment A is pressed, then as files arrive)."""
    show = show or (lambda *a: None)
    late = "release" not in m           # the list comes after the yes (0.3.10+ hosts)
    try:
        if late:
            rules(m)
            note = "checked: wedgie.dev release " + str(m.get("version") or "")[:12]
        else:
            version, files = check(m, sig=False)
            note = "checked: wedgie.dev release " + version
    except ValueError as e:
        W.send({"id": mid, "type": "error", "error": str(e)})
        return
    write = list(m.get("write") or [])
    title = str(m.get("job") or "Update")[:60]
    if not ask(title, note):
        W.send({"id": mid, "type": "refused"})
        return
    title = W.doing(title)
    plan = Plan(m.get("bytes") or 6144 * len(write))
    sig_tick = lambda f: show(title, None, plan.at("sig", f))
    if late:
        files = None
        show(title, "starting", plan.at("sig"))
    else:
        show(title, "checking the signature", plan.at("sig"))
        try:
            check(m, tick=sig_tick)
        except ValueError as e:
            W.send({"id": mid, "type": "error", "error": str(e)})
            return
        show(title, "starting", plan.at("sums"))
    W.send({"id": mid, "type": "go", "asked_ms": W.asked_ms})
    sent, todo = 0, plan.files              # bytes that came, bytes still to come (less what's there already)
    got = {}                                # name -> sha256 of what arrived
    there = {}                              # name -> sha256 of what's on it (this job's sums)
    h, f, cur = None, None, None
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    R = W.lines()                           # the one line reader: never a string grown per char (wedgie.Lines)
    last, qid = time.ticks_ms(), mid
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
            if t == "release":
                show(title, "checking the signature", plan.at("sig"))
                try:
                    m["release"], m["sig"] = q.get("release") or "", q.get("sig") or ""
                    version, files = check(m, tick=sig_tick)
                    if m.get("version") and version != m["version"]:
                        raise ValueError("the signed list is %s, not %s" % (version, m["version"]))
                except ValueError as e:
                    W.send({"id": qid, "type": "error", "error": str(e)})
                    return
                m.pop("release", None)      # the 2.6 KB list: files has what's needed from it
                gc.collect()
                show(title, "looking at what's on it", plan.at("sums"))
                last = time.ticks_ms()
                W.send({"id": qid, "type": "ok", "version": version})
            elif t == "sums":
                show(title, "looking at what's on it", plan.at("sums"))
                v = sums(q.get("names"), q.get("exists"))
                for n in q.get("names") or []:
                    there[n] = v.get(n)
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
                    W.send({"id": qid, "type": "error", "error": "the signed list comes first"})
                    return
                if n not in write:
                    W.send({"id": qid, "type": "error", "error": "%s isn't in this job" % n})
                    return
                if n != cur:                # a new upload: whatever was checked under this name isn't any more
                    if f:                   # (a finished file sent again was committed as the new bytes,
                        f.close()           # unchecked: codex 2026-10-02)
                    got.pop(n, None)
                    f, h, cur = open(_tmp(n), "wb"), hashlib.sha256(), n
                end = q.get("end")
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
                        W.send({"id": qid, "type": "error", "error": "%s doesn't match the signed list" % n})
                        return
                W.send({"id": qid, "type": "ok"})
                gc.collect()
            elif t == "commit":
                if files is None:
                    W.send({"id": qid, "type": "error", "error": "the signed list comes first"})
                    return
                if cur is not None:
                    W.send({"id": qid, "type": "error", "error": "%s isn't finished" % cur})
                    return
                show(title, "restarting...", plan.at("commit"))
                missing = [n for n in write if n not in got and there.get(n) != files[n]]
                if missing:
                    W.send({"id": qid, "type": "error", "error": "not sent: " + " ".join(missing)})
                    return
                for n in sorted(got, key=lambda n: n == "main.py"):     # main.py last
                    try:
                        os.remove(n)
                    except OSError:
                        pass
                    os.rename(_tmp(n), n)
                    if n.endswith(".mpy"):      # its old source: MicroPython imports a .py first, so it would
                        try:                    # run instead (the Wallet from source runs out of memory)
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
                show(title, None, 1)
                W.send({"id": qid, "type": "done", "version": version})
                write = []
                time.sleep_ms(100)
                import machine
                W.restarting = True         # main.py lets this SystemExit through
                machine.soft_reset()
                return                      # (the emulator's soft_reset returns: it restarts once this does)
            elif t == "abort":
                W.send({"id": qid, "type": "ok"})
                return
            elif t == "hello":              # job: a host whose port dropped at the restart finds the job here
                W.send(W.hello(qid, job=True, asked_ms=W.asked_ms))
    except Exception as e:                  # out of memory, a full flash...: nothing changed, it restarts
        W.failed(qid, e)
    finally:
        if f:
            f.close()
        _clean(write)
