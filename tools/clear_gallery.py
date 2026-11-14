#!/usr/bin/env python3
# wedgie.dev/clear, all of it: every test transaction in the public ERC-7730 registry (testsv2: real mainnet txs), run
# on a virtual RP2040 (tools/safechip.mjs: the real firmware, the shelf's Safe Signer and its clear-signing data), every
# page saved. No dapp is added by hand.
#   python3 tools/clear_gallery.py run <registry checkout> <work dir> [--jobs 12] [--only <text in the test file's path>]
#                                      [--usage usage.json]     the most used first, so a stopped run has the top ones
#       the registry at the commit the shelf's data was made from (community/clawdbotatg/wedgie-safe/safe_roots.py
#       names it). ~12 s of one core a transaction; a second run does only what's missing. Writes <work>/txs.json,
#       <work>/shots/<id>-<n>.png, <work>/log/<part>.txt
#   python3 tools/clear_gallery.py publish <work dir> [results.json] [usage.json]
#       public/clear/screens/all/<id>-<page>.png and public/clear/screens/all.json, which public/clear/clear.js draws.
#       results.json: tools/test_clear.py's verdict a transaction (RESULTS=<file>); usage.json: mainnet txs a week a
#       function (the usage command). Without them: no badge, no ranking. With usage: screens/missing.json too,
#       the busiest mainnet calls the shelf's data has no descriptor for.
#   python3 tools/clear_gallery.py usage <usage.json>
#       mainnet use a function over the last 7 days, the top 10,000 contracts, from Kaan's dashboard
#       (erc7730.sourcify.dev): {"window", "tx": {"1:<address>:<selector>": txs}, "sig": {...: "name(types)"},
#       "name": {"<address>": contract name}, "who": {"<address>": "users" | ...}}
#   python3 tools/clear_gallery.py refresh <dir> [--jobs 8] [--usage-only]
#       all of it for what's on the shelf now, in one go: the registry at the shelf's commit, wedgie-safe at the
#       shelf's commit, usage, run, verdicts (tools/test_clear.py, needs uv), publish. <dir> is kept between runs
#       (hours the first time for a Safe Signer or data; a rerun does what's missing). --usage-only: fresh usage on
#       the screens <dir> already has (minutes). Then commit public/clear/screens and push. docs/CLEAR-GALLERY.md
#   python3 tools/clear_gallery.py stale
#       is public/clear/screens made from the shelf's Safe Signer and data, and its usage under 10 days old? Exit 1
#       if not. tools/test_docs.py asks the same, so the gate does.
import glob, json, os, re, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, "..")
PART = 40           # transactions a virtual chip (one boot, ~35 s)


def shelf():
    """What a wedgie gets today: {"app": Safe Signer's version, "data": its clear-signing data, "registry": the
    registry commit that data was made from, "sha": wedgie-safe's commit}."""
    d = os.path.join(root, "community", "clawdbotatg", "wedgie-safe")
    roots = open(os.path.join(d, "safe_roots.py")).read()
    repo = next(r for r in json.load(open(os.path.join(root, "community.json")))["repos"] if r["repo"] == "clawdbotatg/wedgie-safe")
    return {"app": repo["version"]["safe"],
            "data": re.search(r'TAG = "(\w+)"', roots).group(1), "registry": re.search(r"Registry (\w+)", roots).group(1), "sha": repo["sha"]}


def stale(usage=True):
    """Why public/clear/screens isn't what the shelf shows, or "" (docs/CLEAR-GALLERY.md)."""
    f = os.path.join(root, "public", "clear", "screens", "meta.json")
    if not os.path.exists(f):
        return "public/clear/screens has no meta.json"
    m, s = json.load(open(f)), shelf()
    for k, what in (("app", "Safe Signer"), ("data", "clear-signing data")):
        if m.get(k) != s[k]:
            return "wedgie.dev/clear's screens are from %s %s, the shelf has %s" % (what, m.get(k), s[k])
    days = (time.time() - time.mktime(time.strptime(m["usage"]["to"], "%Y-%m-%d"))) / 86400 if m.get("usage") else 99
    if usage and days > 10:
        return "wedgie.dev/clear's mainnet use is %d days old (refresh --usage-only)" % days
    return ""


def rlp(b, i=0):
    p = b[i]
    if p < 0x80:
        return b[i:i + 1], i + 1
    if p < 0xb8:
        return b[i + 1:i + 1 + p - 0x80], i + 1 + p - 0x80
    if p < 0xc0:
        n = int.from_bytes(b[i + 1:i + p - 0xb6], "big")
        return b[i + p - 0xb6:i + p - 0xb6 + n], i + p - 0xb6 + n
    if p < 0xf8:
        n, j = p - 0xc0, i + 1
    else:
        n, j = int.from_bytes(b[i + 1:i + p - 0xf6], "big"), i + p - 0xf6
    out, end = [], j + n
    while j < end:
        x, j = rlp(b, j)
        out.append(x)
    return out, end


def decode(raw):
    """(chain, to, value, data) of a signed or unsigned raw transaction: tools/clear_txs.py's."""
    b = bytes.fromhex(raw[2:])
    num = lambda x: int.from_bytes(x, "big")
    if b[0] in (1, 2, 4):
        f = rlp(b[1:])[0]
        i = {1: 4, 2: 5, 4: 5}[b[0]]
        return num(f[0]), f[i], num(f[i + 1]), f[i + 2]
    f = rlp(b)[0]
    chain = num(f[6]) if len(f) > 6 else 1
    if len(f) == 9 and num(f[6]) > 36 and (num(f[7]) or num(f[8])):
        chain = (num(f[6]) - 35) // 2
    return chain, f[3], num(f[4]), f[5]


def collect(reg, only):
    txs = []
    for tf in sorted(glob.glob(reg + "/registry/**/testsv2/calldata-*.tests.json", recursive=True)
                     + glob.glob(reg + "/ercs/**/testsv2/calldata-*.tests.json", recursive=True)):
        rel = os.path.relpath(tf, reg)
        if only and only not in rel:
            continue
        for k, t in enumerate(json.load(open(tf))["tests"]):
            if "rawTx" not in t:
                continue
            chain, to, value, data = decode(t["rawTx"])
            txs.append({"id": "t%05d" % len(txs), "file": rel, "k": k, "name": t["description"], "chainId": chain,
                        "to": "0x" + to.hex(), "value": str(value), "data": "0x" + data.hex(),
                        "safe": t.get("from", "0x" + "5a" * 20).lower()})
    return txs


def run(reg, work, jobs, only, usage):
    os.makedirs(os.path.join(work, "shots"), exist_ok=True)
    os.makedirs(os.path.join(work, "log"), exist_ok=True)
    txs = collect(reg, only)
    mf, s = os.path.join(work, "meta.json"), shelf()
    if os.path.exists(mf) and json.load(open(mf)) != s:
        sys.exit("%s has another Safe Signer's or data's screens (%s): use a new work dir" % (work, json.load(open(mf))))
    json.dump(s, open(mf, "w"))
    json.dump(txs, open(os.path.join(work, "txs.json"), "w"))
    done = results(work)
    todo = [t for t in txs if t["id"] not in done]
    if usage:
        use = json.load(open(usage))["tx"]
        todo.sort(key=lambda t: -(use.get("1:%s:%s" % (t["to"], t["data"][:10]), 0) if t["chainId"] == 1 else 0))
    parts = [todo[i:i + PART] for i in range(0, len(todo), PART)]
    print("%d transactions, %d to run, %d chips at a time" % (len(txs), len(todo), jobs))

    def one(n):
        f = os.path.join(work, "part-%s.json" % parts[n][0]["id"])
        json.dump([{**t, "name": t["id"]} for t in parts[n]], open(f, "w"))
        with open(os.path.join(work, "log", "%s.txt" % parts[n][0]["id"]), "w") as log:
            subprocess.run(["node", os.path.join(here, "safechip.mjs"), "--txs", f, "--shots", os.path.join(work, "shots")],
                           stdout=log, stderr=subprocess.STDOUT, cwd=root)
        os.remove(f)
        print("part %d of %d done" % (n + 1, len(parts)), flush=True)
        sys.stdout.flush()

    with ThreadPoolExecutor(jobs) as ex:
        list(ex.map(one, range(len(parts))))
    done = results(work)
    print("%d of %d answered; %d left (run again)" % (len(done), len(txs), len(txs) - len(done)))


def usage(out):
    import urllib.request
    tx, sig, name, who, meta = {}, {}, {}, {}, None
    for p in range(10):
        d = json.load(urllib.request.urlopen("https://erc7730.sourcify.dev/api/live/ranking?window=7d&limit=1000&offset=%d" % (p * 1000), timeout=120))
        meta = meta or d["window"]
        for c in d["contracts"]:
            a = c["toAddress"].lower()
            name[a] = c.get("sourcifyName") or c.get("entity") or ""
            who[a] = (c.get("callers") or {}).get("verdict") or ""
            for x in c["topSelectors"]:
                tx["1:%s:%s" % (a, x["selector"])] = x["txCount"]
                sig["1:%s:%s" % (a, x["selector"])] = x.get("functionSig") or ""
    json.dump({"window": meta, "tx": tx, "sig": sig, "name": name, "who": who}, open(out, "w"))
    print("%d functions of %d contracts, %s to %s" % (len(tx), len(name), meta["fromIso"][:10], meta["toIso"][:10]))


def missing(u):
    """The busiest mainnet calls the shelf's clear-signing data has no descriptor for."""
    tag = re.search(r'TAG = "(\w+)"', open(os.path.join(root, "community", "clawdbotatg", "wedgie-safe", "safe_roots.py")).read()).group(1)
    base = os.path.join(root, "public", "clear", tag, "1")
    have = lambda a: set(json.load(open(os.path.join(base, a + ".json")))) if os.path.exists(os.path.join(base, a + ".json")) else set()
    anyone = have("0x7730773077307730773077307730773077307730")       # wire/release.py's ANY: every ERC-20
    out, memo = [], {}
    for k, n in sorted(u["tx"].items(), key=lambda kv: -kv[1]):
        _, a, sel = k.split(":")
        if a not in memo:
            memo[a] = have(a)
        if sel in memo[a] or sel in anyone or len(sel) != 10 or u["who"].get(a) == "bots":     # bots don't read screens
            continue
        out.append({"to": a, "contract": u["name"].get(a, ""), "sel": sel, "sig": u["sig"].get(k, ""), "use": n})
        if len(out) == 200:
            break
    return out


def is_page(f):
    """A page to sign: the dark header on top, the red "no" bar at the bottom. Not the "Reading" splash, not the
    Safe tx hash bar drawn over a page. safechip's PNGs: RGB, 240 x 240, no filter."""
    import zlib, struct
    b, i, idat = open(f, "rb").read(), 8, b""
    while i < len(b):
        n, t = struct.unpack(">I4s", b[i:i + 8])
        if t == b"IDAT":
            idat += b[i + 8:i + 8 + n]
        i += 12 + n
    raw = zlib.decompress(idat)
    at = lambda x, y: tuple(raw[y * 721 + 1 + x * 3:y * 721 + 4 + x * 3])
    return at(120, 2) == (24, 24, 24) and at(20, 232) == (224, 48, 40)


def results(work):
    """{id: ("ok" | "fail" | "none", the line)} from the chips' logs. none: the page had no descriptor to send."""
    out = {}
    for f in glob.glob(os.path.join(work, "log", "*.txt")):
        for line in open(f, errors="replace"):
            m = re.match(r"(ok  |FAIL) (t\d{5}): (.*)", line)
            if m:
                out[m.group(2)] = ("none" if "no bundle" in m.group(3) else "ok" if m.group(1) == "ok  " else "fail", m.group(3).strip())
    return out


def publish(work, verdicts, usage):
    txs = json.load(open(os.path.join(work, "txs.json")))
    res = results(work)
    verdicts = json.load(open(verdicts)) if verdicts else {}
    u = json.load(open(usage)) if usage else {}
    use = u.get("tx", {})
    dst = os.path.join(root, "public", "clear", "screens", "all")
    shutil.rmtree(dst, ignore_errors=True)
    os.makedirs(dst)
    files = {}
    for t in txs:
        if t["id"] not in res:                  # not run yet: left out
            continue
        st, line = res[t["id"]]
        shots, n = [], 1
        while os.path.exists(os.path.join(work, "shots", "%s-%d.png" % (t["id"], n))):
            shots.append(os.path.join(work, "shots", "%s-%d.png" % (t["id"], n)))
            n += 1
        pages = []
        for src in [x for x in shots if is_page(x)] or shots[1:]:     # none looks like a page: all but the first
            f = "%s-%d.png" % (t["id"][1:], len(pages) + 1)
            shutil.copy(src, os.path.join(dst, f))
            pages.append(f)
        sel = t["data"][:10]
        c = {"name": re.sub(r" - chain \d+$", "", t["name"]), "chainId": t["chainId"], "to": t["to"], "sel": sel,
             "pages": pages, "chip": st, "says": verdicts.get("%s#%d" % (t["file"], t["k"]), ""),
             "use": use.get("1:%s:%s" % (t["to"], sel), 0) if t["chainId"] == 1 else 0}
        if st == "fail":
            c["why"] = line[:300]
        files.setdefault(t["file"], []).append(c)
    out = []
    for f, cases in files.items():
        parts = f.split("/")                    # registry/<dapp>/testsv2/calldata-<Name>.tests.json
        seen = {}
        for c in cases:                         # a function's use counted once, however many tests it has
            seen[(c["to"], c["sel"])] = c["use"]
        cases.sort(key=lambda c: -c["use"])
        out.append({"dapp": parts[1], "file": f.replace("/testsv2/", "/").replace(".tests.json", ".json"),
                    "title": parts[-1].replace("calldata-", "").replace(".tests.json", ""), "use": sum(seen.values()),
                    "cases": cases})
    out.sort(key=lambda s: (-s["use"], s["dapp"], s["title"]))
    json.dump(out, open(os.path.join(dst, "..", "all.json"), "w"), separators=(",", ":"))
    if u.get("sig"):
        json.dump({"window": u["window"], "calls": missing(u)}, open(os.path.join(dst, "..", "missing.json"), "w"), separators=(",", ":"))
    made = json.load(open(os.path.join(work, "meta.json")))       # what the screens were made with (run wrote it)
    w = u.get("window") or {}
    json.dump({"app": made["app"], "data": made["data"], "registry": made["registry"], "date": time.strftime("%Y-%m-%d"),
               "usage": {"from": w["fromIso"][:10], "to": w["toIso"][:10]} if w else None},
              open(os.path.join(dst, "..", "meta.json"), "w"))
    n = sum(len(s["cases"]) for s in out)
    by = {}
    for s in out:
        for c in s["cases"]:
            by[c["chip"]] = by.get(c["chip"], 0) + 1
    print("%d files, %d transactions, %d screens: %s" % (len(out), n, sum(len(c["pages"]) for s in out for c in s["cases"]), by))


def refresh(base, jobs, usage_only):
    s = shelf()
    sh = lambda *c, **k: subprocess.run(c, check=True, **k)
    os.makedirs(base, exist_ok=True)
    reg, app = os.path.join(base, "registry"), os.path.join(base, "wedgie-safe")
    for d, url, at in ((reg, "https://github.com/ethereum/clear-signing-erc7730-registry", s["registry"]),
                       (app, "https://github.com/clawdbotatg/wedgie-safe", s["sha"])):
        if not os.path.isdir(d):
            sh("git", "clone", "-q", url, d)
        if subprocess.run(["git", "-C", d, "cat-file", "-e", at + "^{commit}"], capture_output=True).returncode:
            sh("git", "-C", d, "fetch", "-q", "origin")
        sh("git", "-C", d, "checkout", "-q", "--detach", at)
    key = "%s-%s" % (s["app"], s["data"])
    work, verdicts, use = os.path.join(base, "work-" + key), os.path.join(base, "verdicts-%s.json" % key), os.path.join(base, "usage.json")
    if usage_only and not (os.path.exists(os.path.join(work, "txs.json")) and os.path.exists(verdicts)):
        sys.exit("no screens for Safe Signer %s, data %s in %s yet: run without --usage-only" % (s["app"], s["data"], base))
    usage(use)
    if not usage_only:
        run(reg, work, jobs, None, use)
        left = len(json.load(open(os.path.join(work, "txs.json")))) - len(results(work))
        if left:
            sys.exit("%d transactions got no answer: run it again (it does only those)" % left)
        r = subprocess.run(["uv", "run", "-q", "-p", "3.13", "--with", "clearsig", "--with", "eth-account", "--with", "pycryptodome",
                            "--with", "cryptography", "python3", os.path.join(here, "test_clear.py"), reg, app],
                           env={**os.environ, "RESULTS": verdicts, "DUMP": os.path.join(base, "why-%s.json" % key)}, capture_output=True, text=True)
        print("\n".join(r.stdout.splitlines()[-4:]))
        if r.returncode:
            sys.exit("tools/test_clear.py didn't end all ok: look before publishing (its DUMP: %s)" % os.path.join(base, "why-%s.json" % key))
    old = os.path.join(root, "public", "clear", "screens", "all.json")
    before = {(s_["file"], c["name"]): (c["says"], c["chip"], len(c["pages"])) for s_ in json.load(open(old)) for c in s_["cases"]} if os.path.exists(old) else {}
    publish(work, verdicts, use)
    after = {(s_["file"], c["name"]): (c["says"], c["chip"], len(c["pages"])) for s_ in json.load(open(old)) for c in s_["cases"]}
    moved = [(k, before[k], v) for k, v in after.items() if k in before and before[k] != v]
    print("%d new, %d gone, %d with another verdict or page count:" % (len(set(after) - set(before)), len(set(before) - set(after)), len(moved)))
    for k, a, b in moved[:40]:
        print("  %s: %s -> %s  (%s)" % (k[1][:60], a, b, k[0]))
    print("Now: git add -A public/clear/screens, commit (Safe Signer %s, data %s), push, node tools/loadprobe.mjs https://wedgie.dev" % (s["app"], s["data"]))


if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
    if a and a[0] == "run":
        run(a[1], a[2], int(opt("--jobs", 12)), opt("--only"), opt("--usage"))
    elif a and a[0] == "usage":
        usage(a[1])
    elif a and a[0] == "refresh":
        refresh(a[1], int(opt("--jobs", 8)), "--usage-only" in a)
    elif a and a[0] == "stale":
        why = stale()
        sys.exit(why + ": python3 tools/clear_gallery.py refresh <dir> (docs/CLEAR-GALLERY.md)" if why else print("wedgie.dev/clear is made from what's on the shelf: %s" % shelf()))
    elif a and a[0] == "publish":
        publish(a[1], a[2] if len(a) > 2 else None, a[3] if len(a) > 3 else None)
    else:
        sys.exit(__doc__ or "run | publish (see the top of this file)")
