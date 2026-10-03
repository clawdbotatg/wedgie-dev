#!/usr/bin/env python3
"""The RP2040's heap rules (CLAUDE.md landmine 13, firmware/wedgie.py Lines). It has ~75 KB once the
framebuffer is taken, and MicroPython never moves a block: memory gets chopped into pieces, and then a
1.3 KB string has nowhere to go. 0.3.6 and 0.3.11 both died of it on a real board ("memory allocation
failed") while the emulator, with twice the heap, passed. So, in every firmware file:
 - only wedgie.py reads USB (sys.stdin.read / readinto / readline): everything else uses wedgie.lines();
 - a str or bytes grown with += says why it stays small, on that line: `# small: <why>`.
                                                                     python3 tools/test_memory.py"""
import ast, os, re, sys

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
fw = os.path.join(root, "firmware")
bad = []


def strish(v):
    """An expression that makes a str or bytes."""
    if isinstance(v, ast.Constant) and isinstance(v.value, (str, bytes)):
        return True
    if isinstance(v, ast.JoinedStr):
        return True
    if isinstance(v, ast.BinOp) and isinstance(v.op, (ast.Add, ast.Mod)):
        return strish(v.left) or strish(v.right)
    if isinstance(v, ast.Call):
        f = v.func
        if isinstance(f, ast.Name) and f.id in ("str", "bytes"):
            return True
        if isinstance(f, ast.Attribute) and f.attr in ("encode", "decode", "join", "read", "hexlify", "to_bytes", "format"):
            return True
    if isinstance(v, ast.Tuple):
        return False
    return False


def key(t):
    if isinstance(t, ast.Name):
        return t.id
    if isinstance(t, ast.Attribute):
        return "." + t.attr
    return None


for n in sorted(os.listdir(fw)):
    if not n.endswith(".py"):
        continue
    src = open(os.path.join(fw, n)).read()
    lines = src.split("\n")
    tree = ast.parse(src, n)
    if n != "wedgie.py":
        for i, l in enumerate(lines, 1):
            if re.search(r"sys\.stdin(\.buffer)?\.(read|readinto|readline)\b", l.split("#")[0]):
                bad.append("%s:%d reads USB itself: use wedgie.lines() (one buffer, no growing strings)" % (n, i))
    # per function (and the module): names that ever hold a str/bytes there, then += on them
    scopes = [tree] + [x for x in ast.walk(tree) if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef))]

    def own(scope):
        """The scope's nodes, not those of the functions inside it."""
        todo = list(ast.iter_child_nodes(scope))
        while todo:
            x = todo.pop()
            if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            yield x
            todo.extend(ast.iter_child_nodes(x))

    def held(nodes):
        out = set()
        for node in nodes:
            if not isinstance(node, ast.Assign):
                continue
            for t in node.targets:
                if isinstance(t, ast.Tuple) and isinstance(node.value, ast.Tuple):
                    pairs = zip(t.elts, node.value.elts)
                else:
                    pairs = [(t, node.value)]
                for e, v in pairs:
                    if strish(v) and key(e):
                        out.add(key(e))
        return out

    top = held(list(own(tree)))                                     # module globals
    attrs = {k for k in held(list(ast.walk(tree))) if k.startswith(".")}  # self.x anywhere in the file
    for sc in scopes:
        nodes = list(own(sc))
        glob = {g for x in nodes if isinstance(x, ast.Global) for g in x.names}
        strs = held(nodes) | (top & glob) | attrs
        for node in nodes:
            if isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Add):
                k = key(node.target)
                if (k in strs or strish(node.value)) and "# small:" not in lines[node.lineno - 1]:
                    bad.append("%s:%d grows a str/bytes with +=: say why it stays small (# small: ...) or use a bytearray / list + join"
                               % (n, node.lineno))
for b in bad:
    print("FAIL", b)
print("%s" % ("%d FAILED" % len(bad) if bad else "memory rules: all ok"))
sys.exit(1 if bad else 0)
