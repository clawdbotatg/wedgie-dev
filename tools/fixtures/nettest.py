# nettest: tools/netchip.mjs's app. Gets each site with net.get (the wedgie's own TLS) and says what came back
# on USB, then waits.
import gc
import time
import net
import ui
import wedgie as W

SITES = (
    ("https://api.coinbase.com/v2/prices/ETH-USD/spot", "data.amount"),
    ("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {"usd": "ethereum.usd"}),
    ("https://api.github.com/zen", None),
    ("https://api.kraken.com/0/public/Time", "result.unixtime"),
    ("https://mempool.space/api/blocks/tip/height", None),            # RSA (0.3.69+)
    ("https://example.com/", None),                      # not in its "net": the computer says no
    ("https://api.coinbase.com/v2/prices/ETH-USD/spot", "data.amount"),     # the computer flips a bit (netchip)
    ("price", None),                                     # net.price: Chainlink over its own TLS (0.3.70+)
    ("block", None),                                     # net.chain(1, ...): BuidlGuidl's node, the same
)


def run():
    ui.progress("Getting sites", "netchip", bar=False)
    for url, pick in SITES:
        gc.collect()
        f0, t = gc.mem_free(), time.ticks_ms()
        try:
            v = net.price() if url == "price" else net.chain(1, "eth_blockNumber") if url == "block" else net.get(url, pick)
            W.send({"type": "nettest", "url": url, "v": v, "ms": time.ticks_diff(time.ticks_ms(), t)})
        except net.Error as e:
            W.send({"type": "nettest", "url": url, "error": str(e)})
        gc.collect()
        W.send({"type": "nettest_free", "before": f0, "after": gc.mem_free()})
    W.send({"type": "nettest", "done": True})
    while True:
        time.sleep_ms(100)
