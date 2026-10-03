# picowallet over USB. No radio. The wallet never asks for anything: the website pushes one JSON
# line down the USB serial port, the wallet shows it, the person presses A or Y, the wallet
# answers one JSON line. Protocol in USB.md. Screens, signer and EIP-712 code are the same as the
# WiFi wallet; only the transport differs.
#
# Two ways to run it. run() is for the board: it owns stdin in a loop that never returns, so the
# REPL cannot eat the host's bytes. The wedgie is sealed (main.py): a host that wants the REPL sends
# {"type": "open"} and the person answers on the screen (slot.let_in); only then does Ctrl-C work.
# Its keys are physical (lcd.Keys): a press sent over USB never signs. start() is for the emulator:
# a Timer tick, so the page and tools/emu keep working around it.
import sys, select, json, time, gc
import lcd as L
import wedgie as W
import eip712
import signer as S
import blockies
from keccak import keccak256
try:
    import secrets
except ImportError:
    secrets = None

FW = "usb-1"
NAME = getattr(secrets, "DEVICE_NAME", "wedgie wallet") if secrets else "wedgie wallet"
SOFT_OK = bool(getattr(secrets, "ALLOW_SOFT_KEY", False)) if secrets else False
MAX_LINE = 6144     # wedgie.lines(): the one buffer, made at boot (16 KB left too little to start this app)
VAULT = (getattr(secrets, "EXPECTED_VAULT", "") or "") if secrets else ""   # the account this chip controls

d = None
keys = None
sig = None
state = "boot"      # boot | home | confirm | working | provision | newkey | nochip
page = 0            # confirm: 0 summary, 1 recipient, 2 raw fields
req = None          # {"id": host message id, "r": the request dict}
prov = None         # {"id": host message id, "op": "lock-config" | "genkey"}
msg = ""
msg_until = 0
dirty = True
qx = qy = ""
address = ""
host = {}           # last `state` line from the website: balance and vault, display hints only
_poll = None
_timer = None
_last_key = 0
log = []


def _log(s):
    log.append(s)
    if len(log) > 30:
        del log[0]
    print("# " + s)          # never starts with "{": hosts treat it as a log line


def send(obj):
    print(json.dumps(obj))


def say(s, secs=4):
    global msg, msg_until, dirty
    msg, msg_until, dirty = s, time.ticks_add(time.ticks_ms(), secs * 1000), True


def hex32(n):
    return "0x%064x" % n


def short(a):
    """0x1234...5678, the way scaffold-eth shows an address."""
    return a[:6] + "..." + a[-4:] if len(a) > 14 else a


def eth_amount(wei, dec=18):
    wei = int(wei)
    whole, frac = wei // 10**dec, wei % 10**dec
    s = (("%0" + str(dec) + "d") % frac).rstrip("0") if dec else ""
    return "%d.%s" % (whole, s[:6]) if s else "%d" % whole


# Tokens whose symbol and decimals the wallet knows itself: the confirm screen shows a transfer's amount
# from the signed raw amount with these, never the host's amountFormatted/tokenSymbol (those can say
# anything). (chain id, address) -> (symbol, decimals). secrets.EXPECTED_TOKEN + EXPECTED_DECIMALS /
# EXPECTED_SYMBOL add one.
TOKENS = {
    (1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"): ("USDC", 6),
    (8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"): ("USDC", 6),
    (84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"): ("USDC", 6),
}


def token_of(r):
    """(symbol, decimals) for the request's token, or None: unknown."""
    t = str(r.get("token", "")).lower()
    if secrets and getattr(secrets, "EXPECTED_DECIMALS", None) is not None and t == str(getattr(secrets, "EXPECTED_TOKEN", "")).lower():
        return (getattr(secrets, "EXPECTED_SYMBOL", "token"), int(secrets.EXPECTED_DECIMALS))
    try:
        return TOKENS.get((int(r.get("chainId")), t))
    except (TypeError, ValueError):
        return None


# --- key and address ---------------------------------------------------------------------------

def load_key():
    """Cache the public key and its Ethereum-style address (keccak of the 64-byte key, last 20
    bytes). Empty strings when the chip has no key yet."""
    global qx, qy, address
    qx = qy = address = ""
    try:
        x, y = sig.pubkey()
    except Exception as e:
        _log("no key: %s" % e)
        return
    qx, qy = hex32(x), hex32(y)
    h = keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))
    address = "0x" + "".join("%02x" % b for b in h[12:])


def probe_chip():
    global sig, state
    sig = S.load()
    if sig.name != "atecc608" and not SOFT_OK:
        state = "nochip"
    elif state == "nochip":
        state = "home"
    load_key()


def chip_status():
    try:
        return sig.status()
    except Exception as e:
        return {"error": str(e)}


# --- the request --------------------------------------------------------------------------------

def check(r):
    """Pins from secrets.py, then the digest rebuilt from the raw fields. Returns (ok, why)."""
    try:
        kind = r.get("kind", "transfer")
        exp_chain = getattr(secrets, "EXPECTED_CHAIN_ID", None) if secrets else None
        exp_vault = getattr(secrets, "EXPECTED_VAULT", None) if secrets else None
        exp_token = getattr(secrets, "EXPECTED_TOKEN", None) if secrets else None
        if exp_chain is not None and int(r["chainId"]) != int(exp_chain):
            return False, "wrong chain"
        if exp_vault and r["account"].lower() != exp_vault.lower():
            return False, "wrong vault"
        if exp_token and kind == "transfer" and r["token"].lower() != exp_token.lower():
            return False, "wrong token"
        if kind == "setName":
            mine = eip712.set_name_digest(int(r["chainId"]), r["account"], r["name"], int(r["nonce"]), int(r["deadline"]))
        elif kind == "cancelRecovery":
            mine = eip712.cancel_recovery_digest(int(r["chainId"]), r["account"], int(r["nonce"]), int(r["deadline"]))
        elif kind == "execute":
            mine = eip712.execute_digest(int(r["chainId"]), r["account"], r["target"], int(r["value"]),
                                         bytes.fromhex(r["data"][2:]), int(r["nonce"]), int(r["deadline"]))
        else:
            mine = eip712.transfer_digest(int(r["chainId"]), r["account"], r["token"], r["to"], int(r["amount"]),
                                          int(r["nonce"]), int(r["deadline"]))
        if "0x" + "".join("%02x" % b for b in mine) != r["digest"].lower():
            return False, "digest mismatch"
        return True, ""
    except Exception as e:
        return False, "bad request: %s" % e


# --- serial ----------------------------------------------------------------------------------------

def pump():
    """Read what the host sent, one message per call. Never blocks: the poll says whether a byte
    is there (on the board) and an empty read says there is none (in the emulator). Lines come in
    through the one line reader (wedgie.lines): never a string grown a char at a time."""
    global dirty
    R = W.lines()
    line = R.pump(_poll)
    if R.intr:                  # a Ctrl-C while sealed: the red question (hatch.py), not mid-signing
        R.intr = False
        if W.SEALED and not W.is_open() and state not in ("confirm", "working", "provision"):
            try:
                import hatch
                ok = hatch.ctrl_c()
            except Exception as e:  # out of memory: nobody gets in, the wallet goes on
                sys.print_exception(e)
                ok = False
            if ok:
                raise KeyboardInterrupt
            dirty = True
    if line is False:
        send({"type": "error", "error": "line too long"})
    elif line and line.strip():
        try:
            m = json.loads(line)
        except ValueError:
            send({"type": "error", "error": "bad json"})
            return
        line = None                 # a job runs inside handle: don't keep its line alive under it
        try:
            handle(m)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as e:      # out of memory too: answer it, keep the wallet running
            import slot
            slot.failed(m.get("id") if isinstance(m, dict) else None, e)


def handle(m):
    global dirty
    if not isinstance(m, dict):
        send({"type": "error", "error": "not an object"})
        return
    mid, t = m.get("id"), m.get("type")
    if t == "ping":
        send({"id": mid, "type": "pong"})
    elif t == "hello":
        send(hello(mid))
    elif t == "sign":
        on_sign(mid, m.get("request"))
    elif t == "cancel":
        on_cancel(mid)
    elif t == "state":
        on_state(mid, m)
    elif t == "provision":
        on_provision(mid, m.get("op"))
    elif t == "open":       # the host wants the REPL: the person decides on the screen
        if state in ("confirm", "working", "provision"):
            send({"id": mid, "type": "busy"}); return
        import slot
        send({"id": mid, "type": "open" if slot.let_in(str(m.get("for") or "")[:60], bool(m.get("full"))) else "refused"})
        dirty = True
    elif t in ("job", "sums"):      # a checked install: the slot's (it asks, and never hands out the REPL)
        if state in ("confirm", "working", "provision"):
            send({"id": mid, "type": "busy"}); return
        import slot
        slot.handle(m)
        dirty = True
    elif t == "reboot":     # a clean restart from the host; mpremote's reset can wedge the Mac's port
        send({"id": mid, "type": "rebooting"})
        time.sleep_ms(100)
        import machine
        machine.reset()
    else:
        send({"id": mid, "type": "error", "error": "unknown type"})


def hello(mid):
    st = chip_status()
    import machine
    out = {"id": mid, "type": "hello", "name": NAME, "fw": FW, "backend": sig.name if sig else None,
           "uid": machine.unique_id().hex(),
           "serial": st.get("serial"), "configLocked": st.get("configLocked"),
           "dataLocked": st.get("dataLocked"), "hasKey": bool(address),
           "sealed": W.SEALED, "open": W.is_open()}
    if address:
        out["qx"], out["qy"], out["address"] = qx, qy, address
    core = W.hello(mid, running="usbwallet")    # version, jobs...: a host can send a checked install
    core.update(out)                            # (the slot runs it) instead of asking for full access
    return core


def on_sign(mid, r):
    global req, page, state, dirty
    if state == "nochip":
        send({"id": mid, "type": "error", "error": "no chip"}); return
    if state in ("confirm", "working", "provision"):
        send({"id": mid, "type": "busy"}); return
    if not isinstance(r, dict) or not r.get("digest"):
        send({"id": mid, "type": "error", "error": "bad request"}); return
    if not address:
        send({"id": mid, "type": "error", "error": "no key"}); return
    ok, why = check(r)
    if not ok:
        _log("refused: " + why)
        say("refused: " + why, 8)
        send({"id": mid, "type": "error", "error": why}); return
    req, page, state, dirty = {"id": mid, "r": r}, 0, "confirm", True


def on_state(mid, m):
    """Balance and vault from the website. Untrusted: shown small, labelled, never signed."""
    global host, dirty
    host = {"balance": str(m.get("balance", ""))[:16], "symbol": str(m.get("symbol", ""))[:8],
            "vault": str(m.get("vault", ""))[:42], "at": time.ticks_ms()}
    dirty = True
    send({"id": mid, "type": "ok"})


def on_cancel(mid):
    global state, req, dirty
    if state == "confirm":
        state, req, dirty = "home", None, True
        say("cancelled by the website", 3)
    send({"id": mid, "type": "cancelled"})


def on_provision(mid, op):
    global prov, state, dirty
    if op == "status":
        send({"id": mid, "type": "result", "ok": True, "result": chip_status()}); return
    if op not in ("setup", "lock-config", "genkey"):
        send({"id": mid, "type": "error", "error": "unknown op"}); return
    if state in ("confirm", "working", "provision"):
        send({"id": mid, "type": "busy"}); return
    prov, state, dirty = {"id": mid, "op": op}, "provision", True


# --- decisions --------------------------------------------------------------------------------------

def approve(yes):
    global state, req, dirty
    r, mid = req["r"], req["id"]
    if not yes:
        _log("rejected " + str(r.get("id")))
        send({"id": mid, "type": "rejected"})
        say("rejected", 3)
        state, req, dirty = "home", None, True
        return
    state, dirty = "working", True
    draw()
    try:
        digest = bytes.fromhex(r["digest"][2:])
        t0 = time.ticks_ms()
        r_, s_ = sig.sign(digest)
        _log("signed in %d ms" % time.ticks_diff(time.ticks_ms(), t0))
        send({"id": mid, "type": "signature", "r": hex32(r_), "s": hex32(s_), "digest": r["digest"]})
        say("signed", 4)
    except Exception as e:
        _log("sign failed: %r" % e)
        send({"id": mid, "type": "error", "error": "sign failed: %s" % e})
        say("sign failed", 6)
    state, req, dirty = "home", None, True
    gc.collect()


def do_provision(yes):
    global state, prov, dirty
    mid, op = prov["id"], prov["op"]
    if not yes:
        send({"id": mid, "type": "result", "ok": False, "error": "cancelled on the wallet"})
        say("cancelled", 3)
        state, prov, dirty = "home", None, True
        return
    state, dirty = "working", True
    draw()
    made_key = False
    try:
        if op == "lock-config":
            note = sig.lock_config()
        elif op == "genkey":
            sig.genkey()
            note, made_key = "key generated", True
        else:   # setup: lock if needed, then make the key. One press, one new wallet.
            if not chip_status().get("configLocked"):
                sig.lock_config()
            sig.genkey()
            note, made_key = "new wallet", True
        load_key()
        out = {"op": op, "note": note, "status": chip_status(), "hasKey": bool(address)}
        if address:
            out["qx"], out["qy"], out["address"] = qx, qy, address
        send({"id": mid, "type": "result", "ok": True, "result": out})
        say(note[:30], 5)
    except Exception as e:
        _log("%s failed: %r" % (op, e))
        send({"id": mid, "type": "result", "ok": False, "error": str(e)})
        say("failed: " + str(e)[:20], 8)
    state, prov, dirty = ("newkey" if made_key and address else "home"), None, True


def handle_key(k):
    global page, dirty, state
    if state == "nochip":
        if k == "A":
            probe_chip(); dirty = True
    elif state == "confirm":
        if k == "A":
            approve(True)
        elif k == "Y":
            approve(False)
        elif k == "down":
            page, dirty = min(page + 1, 2), True
        elif k == "up":
            page, dirty = max(page - 1, 0), True
    elif state == "provision":
        if k == "A":
            do_provision(True)
        elif k == "Y":
            do_provision(False)
    elif state == "newkey":
        if k == "A":
            state, dirty = "home", True


# --- screens ---------------------------------------------------------------------------------------

def tri_right(x, y, h, c):
    for i in range(h // 2):
        d.vline(x + i, y + i, h - 2 * i, c)


def bar(y, h, label, color, scale):
    d.fill_rect(0, y, 240, h, color)
    d.center_text(label, y + (h - 8 * scale) // 2, L.WHITE, scale)
    tri_right(222, y + (h - 16) // 2, 16, L.WHITE)


def addr_lines(a):
    """0x + 40 hex as four lines of ten, the first carrying the 0x."""
    h = a[2:] if a.startswith("0x") else a
    return ["0x" + h[0:10], h[10:20], h[20:30], h[30:40]]


def draw_home():
    d.fill(L.BLACK)
    if not address:
        d.fill_rect(0, 0, 240, 26, L.YELLOW)
        d.center_text("NO KEY", 5, L.BLACK, 2)
        st = chip_status()
        y = 50
        for line in (NAME, "", "chip: " + str(sig.name), "serial " + str(st.get("serial", "?"))[:18],
                     "config locked: " + ("yes" if st.get("configLocked") else "no"), "",
                     "plug into the website", "and use its Setup page"):
            d.center_text(line, y, L.WHITE if line else L.BLACK)
            y += 16
    else:
        st = chip_status()
        if VAULT:
            # the vault holds the money; this chip is its only signer
            blockies.draw(d, VAULT.lower(), 80, 6, 10)
            d.center_text(short(VAULT), 90, L.WHITE, 2)
            fresh = host and host.get("vault", "").lower() == VAULT.lower()
            if fresh:
                bal = host["balance"]
                whole, _, frac = bal.partition(".")
                d.center_text("$" + whole + "." + (frac + "00")[:2], 114, L.WHITE, 3)
                d.center_text((host["symbol"] + ", per the website")[:30], 142, L.GREY)
            else:
                d.center_text("balance: plug into the website", 122, L.GREY)
            d.center_text("chip " + short(address), 160, L.GREY)
        else:
            blockies.draw(d, address, 72, 16, 12)
            d.center_text(short(address), 122, L.WHITE, 2)
            d.center_text("no vault pinned in secrets.py", 146, L.GREY)
        d.center_text(NAME[:30], 176, L.GREY)
        d.center_text("%s %s" % (sig.name, "locked" if st.get("configLocked") else "UNLOCKED"), 190, L.GREY)
    if msg and time.ticks_diff(msg_until, time.ticks_ms()) > 0:
        d.fill_rect(0, 224, 240, 16, L.DARK)
        d.center_text(msg[:30], 228, L.YELLOW)
    else:
        d.center_text("USB wallet, no radio", 228, L.DARK)
    d.show()


def draw_confirm():
    r = req["r"]
    kind = r.get("kind", "transfer")
    d.fill(L.BLACK)
    if page == 0:
        bar(0, 60, "SIGN", L.GREEN, 3)
        if kind == "setName":
            d.center_text("SET ENS NAME", 66, L.WHITE, 2)
            d.center_text(str(r.get("name", ""))[:14], 90, L.YELLOW, 2)
        elif kind == "cancelRecovery":
            d.center_text("CANCEL", 66, L.WHITE, 2)
            d.center_text("RECOVERY", 90, L.WHITE, 2)
        elif kind == "execute":
            sel = str(r.get("data", ""))[:10]
            title = "TOKEN TRANSFER" if sel == "0xa9059cbb" else "TOKEN APPROVAL" if sel == "0x095ea7b3" else "GENERAL CALL"
            d.center_text(title, 66, L.WHITE, 2)
            data = str(r.get("data", ""))
            if title != "GENERAL CALL" and len(data) >= 138:     # the call's own words: who and how much
                who, n = "0x" + data[34:74], int(data[74:138], 16)
                tk = token_of({"chainId": r.get("chainId"), "token": r.get("target", "")})
                amt = "UNLIMITED" if n >= 2**255 else (eth_amount(n, tk[1]) + " " + tk[0]) if tk else str(n) + " raw"
                d.center_text(amt[:28], 86, L.YELLOW)
                d.center_text(("to " if sel == "0xa9059cbb" else "for ") + short(who), 98, L.YELLOW)
                d.center_text(("of " + short(str(r.get("target", ""))))[:28], 110, L.GREY)
            else:
                d.center_text((eth_amount(r.get("value", 0)) + " ETH to " + short(r.get("target", "")))[:30], 92, L.YELLOW)
        else:                           # from the signed fields only (check): never the host's hints
            tk = token_of(r)
            amt = eth_amount(r.get("amount", 0), tk[1]) if tk else str(r.get("amount", ""))
            d.center_text(amt[:14], 64, L.WHITE, 3 if len(amt) <= 9 else 2)
            d.center_text(((tk[0] + " to") if tk else "UNKNOWN TOKEN, raw units, to")[:30], 92, L.GREY if tk else L.YELLOW)
            d.center_text(short(str(r.get("to", ""))), 104, L.YELLOW, 2)
        # the fingerprint: the digest this wallet computed, as a blockie and 8 hex
        blockies.draw(d, r["digest"].lower(), 8, 122, 8)
        d.text("digest", 90, 124, L.GREY)
        d.big_text(r["digest"][2:10], 90, 136, L.WHITE, 2)
        d.text("must match the", 90, 160, L.GREY)
        d.text("website's", 90, 172, L.GREY)
        bar(190, 50, "REJECT", L.RED, 3)
    elif page == 1:
        bar(0, 22, "SIGN", L.GREEN, 1)
        if kind == "transfer" or kind == "execute":
            to = r.get("to") if kind == "transfer" else r.get("target")
            d.center_text("to" if kind == "transfer" else "target", 30, L.GREY)
            y = 44
            for line in addr_lines(str(to)):
                d.center_text(line, y, L.WHITE, 2)
                y += 18
            if r.get("toName"):
                d.center_text("name (unchecked hint):", 120, L.GREY)
                d.center_text(str(r["toName"])[:28], 132, L.YELLOW)
            if kind == "transfer":
                d.center_text("amount " + str(r.get("amount", ""))[:22], 152, L.WHITE)
                d.center_text("token", 168, L.GREY)
                d.center_text(str(r.get("token", ""))[:22], 180, L.WHITE)
                d.center_text("  " + str(r.get("token", ""))[22:], 192, L.WHITE)
        else:
            d.center_text("no recipient", 100, L.GREY)
        d.center_text("down: more", 206, L.DARK)
        bar(218, 22, "REJECT", L.RED, 1)
    else:
        bar(0, 22, "SIGN", L.GREEN, 1)
        lines = ["chain %s  nonce %s" % (r.get("chainId"), r.get("nonce")),
                 "deadline %s" % r.get("deadline"), "vault", str(r.get("account", ""))[:22],
                 "  " + str(r.get("account", ""))[22:], "digest",
                 r["digest"][2:24], r["digest"][24:46], r["digest"][46:]]
        if kind == "execute":
            lines += ["calldata %d bytes" % ((len(str(r.get("data", ""))) - 2) // 2)]
        y = 28
        for line in lines:
            d.text(line[:30], 4, y, L.GREEN if line.startswith("digest") else L.WHITE)
            y += 14
        d.center_text("up: back", 206, L.DARK)
        bar(218, 22, "REJECT", L.RED, 1)
    d.show()


PROVISION_TEXT = {
    # 30 characters a line, 8 lines. What the person reads before pressing A.
    "setup": ("NEW KEY", L.BLUE, (
        "This wallet has no key yet.",
        "",
        "Press A: the chip makes one",
        "right now, in front of you.",
        "Nobody else ever sees it.",
        "Not the factory, not the",
        "website, not this screen.",
        "",
        "The chip locks to this key",
        "for good.",
    )),
    "lock-config": ("LOCK CHIP", L.RED, (
        "Locks the chip's settings",
        "so it can hold a key.",
        "",
        "Cannot be undone.",
    )),
    "genkey": ("REPLACE KEY", L.RED, (
        "Makes a NEW key in the chip.",
        "",
        "The old key and its wallet",
        "are gone for good.",
    )),
}


def draw_provision():
    title, color, lines = PROVISION_TEXT[prov["op"]]
    d.fill(L.BLACK)
    d.fill_rect(0, 0, 240, 26, color)
    d.center_text(title, 5, L.WHITE, 2)
    y = 34
    for line in lines:
        d.text(line[:30], 4, y, L.WHITE)
        y += 14
    bar(196, 20, "A = make my key" if prov["op"] == "setup" else "A = do it", L.GREEN, 1)
    bar(220, 20, "Y = not now", L.RED, 1)
    d.show()


def draw_newkey():
    """The wallet just came into being: its blockie and address, once, big."""
    d.fill(L.BLACK)
    d.fill_rect(0, 0, 240, 26, L.GREEN)
    d.center_text("YOUR NEW WALLET", 5, L.WHITE, 2)
    blockies.draw(d, address, 72, 36, 12)
    d.center_text(short(address), 142, L.WHITE, 2)
    d.center_text("made in this chip just now", 182, L.GREY)
    d.center_text("the website shows the same", 196, L.GREY)
    d.center_text("A = ok", 220, L.GREY)
    d.show()


def draw_msg(title, color, body):
    d.fill(L.BLACK)
    d.fill_rect(0, 0, 240, 26, color)
    d.center_text(title, 5, L.WHITE, 2)
    d.center_text(body[:30], 100, L.WHITE)
    d.show()


def draw_nochip():
    import atecc
    d.fill(L.BLACK)
    d.fill_rect(0, 0, 240, 26, L.RED)
    d.center_text("NO CHIP", 5, L.WHITE, 2)
    y = 50
    for line in ("the Wallet needs an", "ATECC608, and none answered", "on I2C (GP%d SDA, GP%d SCL)" % (atecc.SDA, atecc.SCL), "",
                 "the account is the", "chip's key, so there", "is no account here", "",
                 "wire the chip, then", "press A to look again"):
        d.center_text(line, y, L.WHITE if line else L.BLACK)
        y += 16
    d.show()


def draw():
    if state == "nochip":
        draw_nochip()
    elif state == "confirm":
        draw_confirm()
    elif state == "provision":
        draw_provision()
    elif state == "newkey":
        draw_newkey()
    elif state == "working":
        draw_msg("WORKING", L.BLUE, "signing on " + str(sig.name) if req else "the chip is making your key")
    else:
        draw_home()


# --- loop ----------------------------------------------------------------------------------------------

def tick():
    global dirty
    try:
        for k in keys.pressed():
            handle_key(k)
        pump()
        if state == "home" and msg and time.ticks_diff(msg_until, time.ticks_ms()) <= 0:
            say("", 0); dirty = True
        if dirty:
            draw()
            dirty = False
    except Exception as e:
        _log("tick: %r" % e)


def init():
    global d, keys, state, _poll, dirty
    d = L.LCD()
    keys = L.Keys(physical=True)
    _poll = select.poll()
    _poll.register(sys.stdin, select.POLLIN)
    state = "home"
    probe_chip()
    dirty = True
    draw()
    send({"type": "ready", "name": NAME, "fw": FW})


def run():
    """The board: own stdin until Ctrl-C (which works only once the person let the computer in)."""
    init()
    while True:
        tick()
        time.sleep_ms(20)


def start():
    """The emulator: a Timer tick, the page stays responsive."""
    global _timer
    from machine import Timer
    init()
    _timer = Timer(period=30, mode=Timer.PERIODIC, callback=lambda t: tick())


def stop():
    if _timer:
        _timer.deinit()
