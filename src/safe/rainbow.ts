// RainbowKit's Connect wallet: /safe's only way to a wallet, so you always pick (a browser wallet, or any other
// over WalletConnect: a phone wallet, Safe{Wallet}); the last one used is on top. The site has no React: this module (React, wagmi, RainbowKit) is loaded only when needed and mounts one hidden root.
// It hands back the connected wallet's EIP-1193 provider, which safe.ts uses like window.ethereum.
// Wallets as in Scaffold-ETH (wagmiConnectors): Rainbow, MetaMask, Coinbase, WalletConnect (any other), plus
// whatever other wallet this browser has (injected). Reads go through /api/rpc (Alchemy), never a public RPC.
import { createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider, createConfig, http, useAccount } from "wagmi";
import { getAccount, reconnect, disconnect as wDisconnect } from "wagmi/actions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, connectorsForWallets, useConnectModal, lightTheme } from "@rainbow-me/rainbowkit";
import { rainbowWallet, metaMaskWallet, coinbaseWallet, walletConnectWallet, safeWallet, injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { base, mainnet, optimism, arbitrum, polygon, avalanche, bsc, gnosis, celo, sonic, arc, robinhood, baseSepolia, sepolia } from "wagmi/chains";
import "@rainbow-me/rainbowkit/styles.css";

const projectId = "3a8170812b534d0ff9d794f19a901d64";
const chains = [base, mainnet, optimism, arbitrum, polygon, avalanche, bsc, gnosis, celo, sonic, arc, robinhood, baseSepolia, sepolia] as const;
const connectors = connectorsForWallets(
  [{ groupName: "Wallets", wallets: [rainbowWallet, metaMaskWallet, coinbaseWallet, walletConnectWallet, safeWallet, injectedWallet] }],
  { appName: "wedgie", projectId },
);
const config = createConfig({ chains, connectors, transports: Object.fromEntries(chains.map((c) => [c.id, http(`${location.origin}/api/rpc?chain=${c.id}`)])) as any, ssr: false });

let open: (() => void) | undefined;
let waiting: { res: (p: any) => void; rej: (e: Error) => void } | null = null;
let onChange: (p: any | null) => void = () => {};

// after a reload the connector can come back half made (a wallet that forgot this site): no provider, not a throw
const provider = async () => { const c: any = getAccount(config).connector; const p: any = typeof c?.getProvider === "function" ? await c.getProvider().catch(() => null) : null; if (p) lateLink(p); return p; };

// WalletConnect opens the wallet (rainbow://) at the same moment it sends the request. On a phone the page then
// stops behind the wallet with the request half sent, and the wallet sat for minutes before it could sign
// (Austin, 10-10). So: take the wallet link away from it, and open the wallet ourselves once the request is out.
const LINK = "WALLETCONNECT_DEEPLINK_CHOICE";
const linked = new WeakSet<object>();
function lateLink(p: any) {
  const ev = p?.signer?.client?.events;
  if (!ev || linked.has(p)) return;
  linked.add(p);
  const take = () => { try { const v = localStorage.getItem(LINK); if (v) { localStorage.setItem(LINK + ".late", v); localStorage.removeItem(LINK); } } catch {} };
  take();
  ev.on("session_request_sent", ({ id, topic }: { id: number; topic: string }) => {
    take();
    let href = "";
    try { href = JSON.parse(localStorage.getItem(LINK + ".late") || "null")?.href || ""; } catch {}
    if (!href) return;
    const u = `${href.replace(/\/$/, "")}/wc?requestId=${id}&sessionTopic=${topic}`;
    window.open(u, /^https?:/.test(u) ? "_blank" : "_self", "noreferrer noopener");
  });
}

function Bridge() {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { isConnected } = useAccount();
  useEffect(() => { open = openConnectModal; }, [openConnectModal]);
  useEffect(() => {
    provider().then((p) => {
      if (isConnected && p && waiting) { waiting.res(p); waiting = null; }
      onChange(isConnected ? p : null);
    });
  }, [isConnected]);
  useEffect(() => {       // closed without connecting
    if (!connectModalOpen && waiting && !getAccount(config).isConnected) { waiting.rej(new Error("No wallet connected.")); waiting = null; }
  }, [connectModalOpen]);
  return null;
}

let mounted = false;
function mount() {
  if (mounted) return;
  mounted = true;
  const el = document.body.appendChild(document.createElement("div"));
  createRoot(el).render(h(WagmiProvider, { config, reconnectOnMount: false },   // start() reconnects, only when wanted
    h(QueryClientProvider, { client: new QueryClient() },
      h(RainbowKitProvider, { theme: lightTheme({ accentColor: "#2e9e4f" }), modalSize: "compact", children: h(Bridge) }))));
}

/** Watch the connected wallet's provider (null: none). Restores the last session. */
export async function start(cb: (p: any | null) => void) {
  onChange = cb;
  mount();
  await reconnect(config).catch(() => {});
  cb(getAccount(config).isConnected ? await provider() : null);
}

/** Open RainbowKit's modal; resolves with the provider once a wallet is connected. Always the picker (you chose to
 * connect: you choose the wallet; the last one used is on top), never a silent reconnect to the remembered one. */
export async function connect(): Promise<any> {
  mount();
  // a remembered connection (wagmi.store) being restored keeps RainbowKit's openConnectModal undefined: the click
  // did nothing (Austin, 10-21). Drop it first, then wait for the modal to be openable.
  await wDisconnect(config).catch(() => {});
  for (let i = 0; !open && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
  if (!open) throw new Error("The wallet list didn't open. Reload and try again.");
  return new Promise((res, rej) => { waiting = { res, rej }; open!(); });
}

export const disconnect = () => { try { localStorage.removeItem(LINK + ".late"); } catch {} return wDisconnect(config).catch(() => {}); };
