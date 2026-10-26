# tls.py through the relay (relay/worker.js), the way a wedgie's page will carry it.
#   uv run --with websockets --with cryptography python3 relaytest.py api.coinbase.com /v2/prices/ETH-USD/spot [relay url]
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tls
from soft import Soft
from websockets.sync.client import connect
tls.ROOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roots.bin")
host, path = sys.argv[1], sys.argv[2]
relay = sys.argv[3] if len(sys.argv) > 3 else "wss://relay.wedgie.dev"
t = time.time()
ws = connect(relay + "/?host=" + host, origin="https://wedgie.dev")

def recv():
    try:
        return ws.recv(timeout=15)
    except Exception:
        return b""
c = tls.Conn(host, lambda b: ws.send(bytes(b)), recv, chip=Soft())
b = c.get(path)
print(round(time.time() - t, 2), "s", c.status, b[:120])
