# tls.py on the computer: a real socket to the site, the Trust M played by `cryptography` (soft.py).
#   python3 desk.py api.coinbase.com /v2/prices/ETH-USD/spot
import socket, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware"))
import tls
from soft import Soft
tls.ROOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware", "roots.bin")

host, path = sys.argv[1], sys.argv[2]
s = socket.create_connection((host, 443))
t = time.time()
c = tls.Conn(host, s.sendall, lambda: s.recv(4096), chip=Soft(), log=lambda m: print(" ", m, round(time.time() - t, 2)))
print(c.get(path)[:300], c.status)
