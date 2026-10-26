# relay: the pipe for a wedgie's own TLS

A wedgie runs TLS to a site itself (`tls/`). A browser page can't open a TCP connection, so the wedgie's page
sends its encrypted bytes over a WebSocket to `wss://relay.wedgie.dev/?host=<site>`, and this copies them to
the site's port 443 and back. It only ever sees encrypted bytes: it can block them, never read or change them.

`server.mjs` (Node + ws). Limits: port 443 only; a public site name that resolves to a public address, and it
connects to that address (no reaching this box's own services); `Origin` must be wedgie.dev (or localhost);
1 MB and 60 s a connection; 8 at once and 60 a minute per IP.

## Where it runs

The zkllmapi box (`ssh zkllmapi`, 174.129.67.164): `~/wedgie-relay`, systemd `wedgie-relay` on 127.0.0.1:8796,
nginx `/etc/nginx/sites-available/relay.wedgie.dev` with a certbot certificate. DNS: an A record in Route 53
(wedgie.dev's zone). Not Vercel (a function can't hold a socket) and not Cloudflare Workers (they can't
connect to sites hosted on Cloudflare: Coinbase, CoinGecko, Kraken, poidh).

Update: `scp relay/server.mjs relay/package.json zkllmapi:wedgie-relay/ && ssh zkllmapi 'cd ~/wedgie-relay && npm install --omit=dev && sudo systemctl restart wedgie-relay'`

Test: `uv run --with websockets --with cryptography python3 tls/relaytest.py api.coinbase.com /v2/prices/ETH-USD/spot`
