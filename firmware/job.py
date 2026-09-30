# Checked installs: the wedgie puts software on itself, so the computer never gets the REPL.
#
#   {"type":"job","job":"Install Buttons","release":<release.txt>,"sig":"<r> <s>",
#    "write":[names],"delete":[names],"apps":<apps.json text or null>}
#
# The release list must be signed with our key (wedgie.release_ok) and name every file to write.
# Then the person is asked on the screen ("Install Buttons?"; the list is checked, so a yes gives
# nothing but those files). Yes answers {"type":"go"}, and until the job ends nothing else runs:
#   {"type":"put","name":n,"data":<base64>,"end":bool}  -> {"type":"ok"}   (chunks, in order)
#   {"type":"commit"}                                    -> {"type":"done"}, then a soft reset
#   {"type":"abort"}, a bad file, or 30 s of nothing     -> the job ends, nothing changed
# Each file goes to a temp file, hashed as it comes; on commit every one must match its line in the
# list, then they're renamed into place (main.py last), the deletes happen and apps.json is written.
# Saves (/saves) and the core's own boot files can't be deleted. Also {"type":"sums","names":[..]}:
# the sha256 of files on it, so a host sends only what differs. Only the slot (and the Wallet,
# which forwards these) calls this.
import sys, os, json, time, gc, select, hashlib, binascii
import wedgie as W

KEEP = ("main.py", "boot.py", "wedgie.py", "slot.py", "lcd.py", "job.py", "p256.py", "loader.py")
IDLE_MS = 30000


def sums(names):
    out = {}
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


def check(m):
    """The job's files against its signed list: (version, {name: sha}) or raises ValueError."""
    rel = m.get("release") or ""
    if not W.RELEASE_KEY[0] or not W.release_ok(rel.encode(), m.get("sig") or ""):
        raise ValueError("not signed by wedgie.dev")
    version, files = W.release_files(rel)
    for n in m.get("write") or []:
        if n not in files:
            raise ValueError("%s isn't in the signed list" % n)
    for n in m.get("delete") or []:
        if n in KEEP or n.startswith("/") or n.startswith("saves"):
            raise ValueError("can't delete %s" % n)
    if m.get("apps") is not None:
        json.loads(m["apps"])
    return version, files


def run(mid, m, ask, show=None):
    """Check, ask, then take the files. ask(job, note) -> bool is the slot's yes/no screen; show(title,
    what, p) draws the progress screen (the moment A is pressed, then as files arrive)."""
    show = show or (lambda *a: None)
    try:
        version, files = check(m)
    except ValueError as e:
        W.send({"id": mid, "type": "error", "error": str(e)})
        return
    write = list(m.get("write") or [])
    title = str(m.get("job") or "Update")[:60]
    if not ask(title, "checked: wedgie.dev release " + version):
        W.send({"id": mid, "type": "refused"})
        return
    title = title.replace("Install", "Installing").replace("Update", "Updating") + "..."
    show(title, "starting", 0)
    W.send({"id": mid, "type": "go"})
    chunks = 0
    got = {}                                # name -> sha256 of what arrived
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
            if t == "put":
                n = q.get("name")
                if n not in write:
                    W.send({"id": qid, "type": "error", "error": "%s isn't in this job" % n})
                    return
                if n != cur:
                    if f:
                        f.close()
                    f, h, cur = open(_tmp(n), "wb"), hashlib.sha256(), n
                b = binascii.a2b_base64(q.get("data") or "")
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
                show(title, "restarting...", 1)
                missing = [n for n in write if n not in got]
                if missing:
                    W.send({"id": qid, "type": "error", "error": "not sent: " + " ".join(missing)})
                    return
                for n in sorted(write, key=lambda n: n == "main.py"):     # main.py last
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
            elif t == "abort":
                W.send({"id": qid, "type": "ok"})
                return
            elif t == "hello":
                W.send(W.hello(qid, job=True))
    finally:
        if f:
            f.close()
        _clean(write)
