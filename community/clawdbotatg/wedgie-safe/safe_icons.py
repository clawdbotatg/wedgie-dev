# Safe Signer: pictures of the main tokens, beside their amounts. Only a token built into the app (TOKENS below,
# matched by its address on its chain) or the chain's own ETH gets one, so no token can borrow USDC's picture by
# naming itself USDC. safe_icons.bin (made by tools/icons.py): per icon 24 px then 16 px, 4 bits a pixel.

NAMES = ("eth", "usdc", "usdt", "wbtc", "cbbtc", "dai")
OF = {"ETH": 0, "WETH": 0, "USDC": 1, "USDT": 2, "WBTC": 3, "cbBTC": 4, "DAI": 5}
KEY = 2             # the clear around the circle (a slot the icons never draw with)


# tokens the wedgie knows itself: (chain, address) -> (symbol, decimals). Others show their raw amount.
TOKENS = {
    (1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"): ("USDC", 6),
    (1, "0xdac17f958d2ee523a2206206994597c13d831ec7"): ("USDT", 6),
    (1, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"): ("WETH", 18),
    (1, "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"): ("WBTC", 8),
    (1, "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"): ("cbBTC", 8),
    (1, "0x6b175474e89094c44da98b954eedeac495271d0f"): ("DAI", 18),
    (8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"): ("USDC", 6),
    (8453, "0x4200000000000000000000000000000000000006"): ("WETH", 18),
    (8453, "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"): ("cbBTC", 8),
    (8453, "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"): ("DAI", 18),
    (8453, "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"): ("USDT", 6),
    (84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"): ("USDC", 6),
    (10, "0x0b2c639c533813f4aa9d7837caf62653d097ff85"): ("USDC", 6),
    (42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"): ("USDC", 6),
    (11155111, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"): ("USDC", 6),
}


def at(chain, a):
    """The icon of the token at address a ("0x..", lowercase) on chain, if it's one of TOKENS; else None."""
    t = TOKENS.get((chain, a))
    return OF.get(t[0]) if t else None


def of(coin):
    """The icon of a chain's own coin (safe.coin: built in, never from the host), or None."""
    return OF.get(coin)


def draw(d, i, x, y, n):
    """Icon i, n px (24 or 16), at x, y."""
    import framebuf
    b = bytearray(n * n // 2)
    with open("safe_icons.bin", "rb") as f:
        f.seek(i * 416 + (0 if n == 24 else 288))
        f.readinto(b)
    d.blit(framebuf.FrameBuffer(b, n, n, framebuf.GS4_HMSB), x, y, KEY)
