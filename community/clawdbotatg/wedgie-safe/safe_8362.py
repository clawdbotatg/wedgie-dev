# Safe Signer: the ERC-8362 draft (Custom Encoding Layout for ERC-7730, ERCs PR #1925): customEncoding (param 13)
# and switch (param 14) in a descriptor, as wedgie-dev wire/from7730.py binds them to the wire format. Loaded by
# safe_7730 only for a field that has one (the RP2040's heap can't compile it in safe_7730).
import safe_wire as w
from safe_7730 import Bad, _addr, _sub, _values, _pick, _field, _fieldat


def field(ctx, call, label, param, v, i, out):
    if param[0] == 14:
        _switch(ctx, call, label, param, v, i, out)
        return
    sub = []
    n = _enc(ctx, call, param[2], v, 0, sub)[1]
    if n != len(v):
        sub.append(("", "%d bytes it didn't read" % (len(v) - n), "warn"))
    if sub and param[3]:
        out.append((param[3], None, "label"))
    out.extend(sub)


MAX_SEQ = 64            # elements of a sequence


def _enc(ctx, call, node, b, i, out):
    """Decode node from b at i: (value, where it ends). An object shows its own entries into out."""
    t = node[0]
    if t in (0, 2, 3):                  # uint, address, bool: their bytes (address 32: the low 20, the rest zero)
        n = node[1] if t != 3 else 1
        if i + n > len(b):
            raise Bad("encoding: past the end")
        v = bytes(b[i:i + n])
        if t == 2 and n == 32:
            _addr(v)
        return v, i + n
    if t == 1:                          # bytes
        if node[1] == 0:
            n = node[2]
        elif node[1] == 2:
            n = len(b) - i
        else:
            n = int.from_bytes(call.env[node[2]], "big")
        if n < 0 or i + n > len(b):
            raise Bad("encoding: past the end")
        return bytes(b[i:i + n]), i + n
    if t == 4:                          # object: every entry, then the ones it shows (they may name later ones)
        env = []
        here = _sub(call, env=env)
        for e in node[1]:
            v, i = _enc(ctx, here, e[1], b, i + e[0], out)
            env.append(v)
        for e in node[1]:
            if e[2] is not None:
                _field(ctx, here, e[2], out)
        return None, i
    if t == 5:                          # sequence: count, or until the bytes run out
        vals = []
        while (len(vals) < node[2]) if node[2] is not None else (i < len(b)):
            if len(vals) >= MAX_SEQ:
                raise Bad("encoding: sequence too long")
            v, i = _enc(ctx, call, node[1], b, i, out)
            vals.append(v)
        return vals, i
    raise Bad("encoding: node %r" % (t,))


def switch_at(ctx, call, fi, out):
    """A switch field at ctx.b[fi], read in place: its value, then for each of its values the one case it takes."""
    b = ctx.b
    label, pj = w.load(b, w.at(b, fi, 0)), w.at(b, fi, 1)
    if w.load(b, w.at(b, fi, 2)) is not None:
        raise Bad("switch: visible")
    ex = w.load(b, w.at(b, pj, 2))
    for i, v in enumerate(_values(ctx, call, w.load(b, w.at(b, pj, 1)))):
        n = _key(ctx, call, ex, i)
        ci = None
        for c in w.elements(b, w.at(b, pj, 3)):
            if w.load(b, w.at(b, c, 0)) == n:
                ci = w.at(b, c, 1)
                break
        if ci is None:
            ci = w.at(b, pj, 4)
        _case(ctx, call, label, n, ci, v, out)


def _key(ctx, call, ex, i):
    ev, size, mask = ex
    x = _pick(_values(ctx, call, ev), i)
    if size:                            # "x[$index]": the i-th element of the sequence x
        if (i + 1) * size > len(x):
            raise Bad("switch: no element %d" % i)
        x = x[i * size:(i + 1) * size]
    n = int.from_bytes(x, "big")
    return n & mask if mask is not None else n


def _case(ctx, call, label, n, ci, v, out):
    b = ctx.b
    if b[ci] == 0xf6:                   # null: reject
        raise Bad("%s: case 0x%02x it can't read" % (label or "switch", n))
    sub = []
    if w.load(b, w.at(b, ci, 0)) == 0:  # a tuple: the payload is its ABI encoding
        here = _sub(call, cd=v)
        for f in w.elements(b, w.at(b, ci, 2)):
            _fieldat(ctx, here, f, sub)
        out.append((label, ("call", w.load(b, w.at(b, ci, 1)), None, sub, None), "call"))
    else:
        _enc(ctx, call, w.load(b, w.at(b, ci, 1)), v, 0, sub)
        out.append((label, ("call", None, None, sub, None), "call"))


def _switch(ctx, call, label, param, v, i, out):
    """A switch already loaded (inside a group): the same, from lists."""
    n = _key(ctx, call, param[2], i)
    case = param[4]
    for k, c in param[3]:
        if k == n:
            case = c
            break
    if case is None:
        raise Bad("%s: case 0x%02x it can't read" % (label or "switch", n))
    sub = []
    if case[0] == 0:                    # a tuple: the payload is its ABI encoding
        here = _sub(call, cd=v)
        for f in case[2]:
            _field(ctx, here, f, sub)
        out.append((label, ("call", case[1], None, sub, None), "call"))
    else:
        _enc(ctx, call, case[1], v, 0, sub)
        out.append((label, ("call", None, None, sub, None), "call"))
