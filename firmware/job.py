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


def sums(names, exists=()):
    """sha256 of each of names; for exists, only whether it's there (1 or None): hashing every file
    on the flash took seconds before each question."""
    out = {}
    for n in exists or ():
        try:
            os.stat(n)
            out[n] = 1
        except OSError:
            out[n] = None
    for n in names or []:
        try:
            h = hashlib.sha256()
            with open(n, "rb") as f:
                while True:
                    b = f.read(1024)
                    if not b:
                        break
                    h.update(b)
            out[n] = binascii.hexlify(h.digest()).decode()
        except OSError:
            out[n] = None
    return out


def _tmp(n):
    return "_job_" + n


def _clean(names):
    for n in names:
        try:
            os.remove(_tmp(n))
        except OSError:
            pass


def rules(m):
    """What a job may ask for before its list is checked: raises ValueError."""
    for n in m.get("delete") or []:
        if n in KEEP or n.startswith("/") or n.startswith("saves"):
            raise ValueError("can't delete %s" % n)
    if m.get("apps") is not None:
        json.loads(m["apps"])


def check(m, sig=True):
    """The job's files against its signed list: (version, {name: sha}) or raises ValueError. sig=False
    skips the signature (pure-Python P-256: seconds on an RP2040), which run() checks after the yes."""
    rel = m.get("release") or ""
    if sig and (not W.RELEASE_KEY[0] or not W.release_ok(rel.encode(), m.get("sig") or "")):
        raise ValueError("not signed by wedgie.dev")
    version, files = W.release_files(rel)
    for n in m.get("write") or []:
        if n not in files:
            raise ValueError("%s isn't in the signed list" % n)
    rules(m)
    return version, files


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
    title = title.replace("Install", "Installing").replace("Update", "Updating") + "..."
    if late:
        files = None
        show(title, "starting", 0)
    else:
        show(title, "checking the signature", 0)
        try:
            check(m)
        except ValueError as e:
            W.send({"id": mid, "type": "error", "error": str(e)})
            return
        show(title, "starting", 0)
    W.send({"id": mid, "type": "go"})
    chunks = 0
    got = {}                                # name -> sha256 of what arrived
    there = {}                              # name -> sha256 of what's on it (this job's sums)
    h, f, cur = None, None, None
    poll = select.poll()
    poll.register(sys.stdin, select.POLLIN)
    buf, last = "", time.ticks_ms()
    try:
        while time.ticks_diff(time.ticks_ms(), last) < IDLE_MS:
            if not poll.poll(50):
                continue
            ch = sys.stdin.read(1)
            if ch != "\n":
                if ch not in "\r\x03":
                    buf += ch
                if len(buf) > 8192:
                    buf = ""
                continue
            line, buf = buf, ""
            last = time.ticks_ms()
            try:
                q = json.loads(line)
            except ValueError:
                continue
            qid, t = q.get("id"), q.get("type")
            if t == "release":
                show(title, "checking the signature", 0)
                try:
                    m["release"], m["sig"] = q.get("release") or "", q.get("sig") or ""
                    version, files = check(m)
                    if m.get("version") and version != m["version"]:
                        raise ValueError("the signed list is %s, not %s" % (version, m["version"]))
                except ValueError as e:
                    W.send({"id": qid, "type": "error", "error": str(e)})
                    return
                show(title, "starting", 0)
                last = time.ticks_ms()
                W.send({"id": qid, "type": "ok", "version": version})
            elif t == "sums":
                show(title, "looking at what's on it", 0)
                v = sums(q.get("names"), q.get("exists"))
                for n in q.get("names") or []:
                    there[n] = v.get(n)
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
                if n != cur:
                    if f:
                        f.close()
                    f, h, cur = open(_tmp(n), "wb"), hashlib.sha256(), n
                b = binascii.a2b_base64((q.get("data") or "").encode())
                f.write(b)
                h.update(b)
                chunks += 1
                if chunks % 6 == 1:
                    show(title, n, (len(got) + 0.5) / max(1, len(write)))
                if q.get("end"):
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
                show(title, "restarting...", 1)
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
                for n in m.get("delete") or []:
                    try:
                        os.remove(n)
                    except OSError:
                        pass
                if m.get("apps") is not None:
                    with open("apps.json", "w") as a:
                        a.write(m["apps"])
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
            elif t == "hello":
                W.send(W.hello(qid, job=True))
    finally:
        if f:
            f.close()
        _clean(write)
