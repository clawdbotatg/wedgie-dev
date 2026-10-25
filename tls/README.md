# tls: a wedgie's own TLS connection (test, not shipped)

Today `net` (firmware/net.py) is plain JSON through the computer and wedgie.dev: either one can change an
answer. With this, the wedgie runs TLS 1.3 to the site itself. The computer only carries the bytes, so it
can block or slow them, never read or change them.

Only what a wedgie can check fast: P-256 key exchange, AES-128-GCM, ECDSA P-256/P-384 certificates chained
to an ECC root in `roots.bin` (44 from the Mac's system store, 4.7 KB, read one at a time). The Trust M does ECDH and the signature
checks; cryptolib does AES; GHASH, HKDF and SHA-384 are Python.

## Results (10-25)

| | time | lowest free RAM |
|---|---|---|
| real wedgie (0.3.57, Safe loaded, Trust M), api.coinbase.com | 6.0 s | 36 KB |
| virtual RP2040, api.coinbase.com (Google CA) | 3.0 s | 165 KB (bare MicroPython) |
| virtual, api.coingecko.com (Let's Encrypt, P-384) | 4.3 s | 161 KB |
| virtual, api.github.com (Sectigo) | 3.0 s | 166 KB |
| virtual, one bit flipped by the computer | "tampered with" | |

Works: Coinbase, CoinGecko, GitHub, Cloudflare, DefiLlama, poidh. Fails: Alchemy and wedgie.dev (RSA
certificates only).

Not checked: certificate dates (no clock) and revocation.

RAM (10-25, virtual RP2040, trustm already loaded as on a wedgie with a Trust M): a fetch needs ~34 KB free
(13 KB of it is tls.mpy's code, 4 KB the record buffer); after it, drop `tls` from sys.modules and it's 0.
Tighter than ~34 KB it runs out, or garbage collection slows it till the site gives up.

## Run

```
uv run --with mpy-cross==1.29.0.post2 python3 -c "import mpy_cross,subprocess;subprocess.run([mpy_cross.mpy_cross,'-s','tls.py','-o','tls.mpy','tls.py'],check=True)"
python3 desk.py api.coinbase.com /v2/prices/ETH-USD/spot                 # the computer, Trust M played by `cryptography`
node tlschip.mjs api.coinbase.com /v2/prices/ETH-USD/spot [--tamper] [--leave <bytes free>]   # virtual RP2040 + software Trust M
uv run --with pyserial python3 tlsboard.py api.coinbase.com /v2/prices/ETH-USD/spot   # a real wedgie: press green
```

New roots: `security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > r.pem; python3 mkroots.py r.pem roots.bin`.

## To ship it

1. A pipe for the bytes: a browser can't open a TCP connection, so the page needs a relay (WebSocket in,
   TCP out) that only sees encrypted bytes. `wedgie.py net` can open TCP itself.
2. `net.get` uses this for https sites; remove the plain path.
3. Chain reads: Alchemy has no ECC certificate, and its key would sit on the wedgie. Needs another answer.
4. One handshake per fetch (~6 s): keep the connection for repeat calls.
