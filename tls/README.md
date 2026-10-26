# tls: a wedgie's own TLS connection (tests)

`net.get` (firmware/net.py, 0.3.67+) runs `firmware/tls.py`: the wedgie's own TLS 1.3 to the site. Before 0.3.67
it was plain JSON through the computer and wedgie.dev, and either one could change an answer. The computer only carries the bytes, so it
can block or slow them, never read or change them.

Only what a wedgie can check fast: P-256 key exchange, AES-128-GCM, ECDSA P-256/P-384 certificates chained
to an ECC root in `roots.bin`. The Trust M does ECDH and the signature
checks; cryptolib does AES; GHASH, HKDF and SHA-384 are Python.

## Tests (10-25)

`python3 test_tls.py` (`--live`: real sites too): a site we control (Python's ssl) and a computer in the middle
that attacks. The rule: the site's exact answer or a tls.Error, nothing else. All pass:

- **Certificates refused:** unknown CA; self-signed; a root's name with another key; another site's
  certificate; wildcards one level off; a longer host; **a leaf used as a CA to sign one for our host**; an
  intermediate with no basicConstraints or without keyCertSign; email-only and code-signing-only certificates;
  a leaf that can't sign; a bad CertificateVerify; RSA; TLS 1.2.
- **Taken:** P-384 root to P-256 intermediate; a leaf straight from a root; a P-384 leaf key; 6 KB over several
  records; chunked; no length but a close_notify.
- **The computer attacks, 0 changed answers:** one bit flipped at 588 places from the site and 134 from the
  wedgie; cut off at 274 places; each record dropped, sent twice, swapped, zeroed. An answer cut short (its
  Content-Length, last chunk, or close_notify missing) is an Error.
- **Live:** Coinbase, CoinGecko, GitHub, Cloudflare, poidh, Kraken, DefiLlama. Refused cleanly (RSA in the
  chain): Binance, Firebase, Blockstream, mempool.space, Alchemy, wedgie.dev.

Virtual RP2040 (`tlschip.mjs`): Coinbase 2.8 s, CoinGecko (P-384) 4.1 s, GitHub 2.8 s, Kraken 2.6 s; a flipped
bit: "tampered with"; Binance refused. Real wedgie (0.3.57, real Trust M, one green press): Coinbase 5.0 s, CoinGecko (P-384) 7.7 s, GitHub 5.5 s; a bit
flipped in the handshake or in the answer: "tampered with"; Binance refused. ~14 KB used on top of the code.

RAM: a fetch needs ~34 KB free (11 KB is tls.mpy's code, 4 KB the record buffer, trustm already loaded); drop
`tls` from sys.modules after and it's 0. Below ~45 KB free, garbage collection slows the emulated chip enough
that Coinbase hangs up (it closes ~12 s after connecting); a real chip runs ~5x faster than the emulator.

Roots: Mozilla's (certifi), ECC only: 38, 4 KB, read one at a time. Not checked: certificate dates (no clock),
revocation, name constraints, path lengths.

## Run

```
uv run --with mpy-cross==1.29.0.post2 python3 -c "import mpy_cross,subprocess;subprocess.run([mpy_cross.mpy_cross,'-s','tls.py','-o','tls.mpy','tls.py'],check=True)"
python3 test_tls.py [--live]                                             # attacks + real sites
python3 desk.py api.coinbase.com /v2/prices/ETH-USD/spot                 # the computer, Trust M played by `cryptography`
node tlschip.mjs api.coinbase.com /v2/prices/ETH-USD/spot [--tamper] [--leave <bytes free>]   # virtual RP2040 + software Trust M
uv run --with pyserial python3 tlsboard.py api.coinbase.com/v2/prices/ETH-USD/spot '!api.github.com/zen'   # a real wedgie: press green
```

New roots: `uv run --with certifi --with cryptography python3 mkroots.py roots.bin`.

## How it ships

- `firmware/tls.py` + `firmware/roots.bin` (core files; `net.get` imports tls and drops it after).
- The bytes: the wedgie's page (`src/serial/net.ts` answerTcp) over relay.wedgie.dev (`relay/`), or `wedgie.py
  net` straight to the site. Wire: public/usb.md, "its app's internet".
- `node tools/netchip.mjs [--relay]`: the firmware on a virtual RP2040 gets live sites through an app; a site not
  in its "net" refused; a flipped bit caught.

## Still open

1. Chain reads (`net.chain`, `net.price`) are still wedgie.dev's answers: Alchemy has no ECDSA certificate, and
   its key would sit on the wedgie.
2. A handshake per fetch (5-8 s): keep the connection for repeat calls.
3. Answers over 6 KB fail: pick while the records come in, not after.
4. RSA chains (Binance, Firebase): the Trust M can check RSA signatures too.
