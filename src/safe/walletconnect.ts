// A Safe as a WalletConnect wallet (Reown WalletKit), so an app like Uniswap can use it. Ported from Instant
// Wallet's web/lib/walletconnect.ts. On a Safe's page the person pastes the app's wc: link; the session's
// one account is that Safe, on that Safe's chain. What an app can ask:
//   wallet_sendCalls (EIP-5792)  N calls -> one Safe transaction (MultiSendCallOnly batch) -> the wedgie signs
//                                -> a browser wallet executes it: approve + swap in one go
//   eth_sendTransaction          the same, one call
//   wallet_getCapabilities       atomic "supported" on the Safe's chain
//   wallet_getCallsStatus        the execution's receipt
//   wallet_switchEthereumChain   only to the Safe's own chain
// Message signing (personal_sign, typed data) is refused for now: a Safe signs messages through
// SignMessageLib, which the wedgie can't show yet. Loaded only when used (WalletKit is big).
import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";

// Scaffold-ETH 2's public project id, like Instant Wallet
const PROJECT_ID = "3a8170812b534d0ff9d794f19a901d64";
const METHODS = ["eth_sendTransaction", "wallet_sendCalls", "wallet_getCallsStatus", "wallet_showCallsStatus",
  "wallet_getCapabilities", "wallet_switchEthereumChain", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4"];
const EVENTS = ["chainChanged", "accountsChanged"];

export type Dapp = { name: string; url: string; icon?: string };
export type Call = { to: string; value: bigint; data: string };
/** A request that needs the person: calls to run from the Safe. */
export type Ask = { id: number; topic: string; chainId: number; safe: string; method: string; dapp: Dapp; calls: Call[] };
export type Session = { topic: string; dapp: Dapp; chainId: number; safe: string };

type Kit = Awaited<ReturnType<typeof WalletKit.init>>;
let kit: Promise<Kit> | null = null;
let want: { safe: string; chainId: number } | null = null;     // the Safe a pasted link connects
let hooks: { onAsk: (a: Ask) => void; onChange: () => void; onError: (m: string) => void;
  receipt: (chainId: number, hash: string) => Promise<any> } | null = null;

const hex = (n: number | bigint) => "0x" + n.toString(16);
const dappOf = (k: Kit, topic: string): Dapp => {
  const m = k.getActiveSessions()[topic]?.peer.metadata;
  return { name: m?.name || "An app", url: m?.url || "", icon: m?.icons?.[0] };
};

/** Start WalletKit (once) and listen. Sessions from earlier visits come back on their own. */
export function start(h: NonNullable<typeof hooks>) {
  hooks = h;
  if (!kit) {
    kit = WalletKit.init({
      core: new Core({ projectId: PROJECT_ID }),
      metadata: { name: "wedgie.dev Safe", description: "A Safe signed on a wedgie", url: location.origin,
        icons: [`${location.origin}/img/sticker.webp`] },
    }).then((k) => {
      k.on("session_proposal", (p) => onProposal(k, p).catch((e) => hooks?.onError(e?.message || String(e))));
      k.on("session_request", (e) => onRequest(k, e).catch((err) => answerError(e.topic, e.id, err?.message || String(err), err?.code)));
      k.on("session_delete", () => hooks?.onChange());
      return k;
    });
  }
  return kit.then(() => hooks?.onChange());
}

/** Connect an app: its wc: link, for this Safe. */
export async function pair(uri: string, safe: string, chainId: number) {
  if (!/^wc:/.test(uri.trim())) throw new Error("That isn't a WalletConnect link (it starts with wc:).");
  want = { safe, chainId };
  const k = await kit!;
  await k.pair({ uri: uri.trim() });
}

async function onProposal(k: Kit, p: WalletKitTypes.SessionProposal) {
  const w = want;
  want = null;
  if (!w) { await k.rejectSession({ id: p.id, reason: getSdkError("USER_REJECTED") }); return; }
  const chain = `eip155:${w.chainId}`;
  let namespaces;
  try {
    namespaces = buildApprovedNamespaces({ proposal: p.params,
      supportedNamespaces: { eip155: { chains: [chain], methods: METHODS, events: EVENTS, accounts: [`${chain}:${w.safe}`] } } });
  } catch {
    await k.rejectSession({ id: p.id, reason: getSdkError("UNSUPPORTED_CHAINS") });
    throw new Error(`${p.params.proposer.metadata.name || "The app"} wants a chain this Safe isn't on. Switch the app to this Safe's chain and try again.`);
  }
  await k.approveSession({ id: p.id, namespaces });
  hooks?.onChange();
}

const accountOf = (k: Kit, topic: string) => {
  const a = k.getActiveSessions()[topic]?.namespaces.eip155?.accounts?.[0] || "";
  const [, c, addr] = a.split(":");
  return { chainId: +c, safe: addr || "" };
};

async function onRequest(k: Kit, e: WalletKitTypes.SessionRequest) {
  const { topic, id } = e, { method, params } = e.params.request, p = params as any[];
  const { chainId, safe } = accountOf(k, topic);
  switch (method) {
    case "wallet_getCapabilities":
      return answer(topic, id, { [hex(chainId)]: { atomic: { status: "supported" }, atomicBatch: { supported: true } } });
    case "wallet_getCallsStatus":
      return answer(topic, id, await callsStatus(chainId, String(p[0])));
    case "wallet_showCallsStatus":
      return answer(topic, id, null);
    case "wallet_switchEthereumChain":
      if (Number(p[0]?.chainId) !== chainId) throw Object.assign(new Error("This Safe is on another chain."), { code: 4902 });
      return answer(topic, id, null);
    case "eth_sendTransaction":
    case "wallet_sendCalls": {
      const req = method === "wallet_sendCalls" ? p[0] : { calls: [p[0]] };
      if (req.chainId && Number(req.chainId) !== chainId) throw Object.assign(new Error("This Safe is on another chain."), { code: 4902 });
      const calls: Call[] = (req.calls || []).map((c: any) => {
        if (!c.to) throw new Error("Making contracts isn't supported.");
        return { to: c.to, value: c.value ? BigInt(c.value) : 0n, data: c.data || "0x" };
      });
      if (!calls.length) throw new Error("No calls.");
      hooks?.onAsk({ id, topic, chainId, safe, method, dapp: dappOf(k, topic), calls });
      return;
    }
    default:
      throw Object.assign(new Error(`${method}: a wedgie Safe can't do this yet.`), { code: 4200 });
  }
}

async function answer(topic: string, id: number, result: unknown) {
  await (await kit!).respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", result } });
}
export async function answerError(topic: string, id: number, message = "Rejected", code = 4001) {
  await (await kit!).respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", error: { code, message } } });
}
/** The calls ran: hash = the transaction that executed the Safe tx. */
export async function answerDone(a: Ask, hash: string) {
  await answer(a.topic, a.id, a.method === "wallet_sendCalls" ? { id: hash } : hash);
}

async function callsStatus(chainId: number, id: string) {
  const r = await hooks!.receipt(chainId, id).catch(() => null);
  return { version: "2.0.0", id, chainId: hex(chainId), atomic: true, status: !r ? 100 : r.status === "0x1" ? 200 : 500,
    receipts: r ? [{ logs: r.logs.map((l: any) => ({ address: l.address, data: l.data, topics: l.topics })), status: r.status,
      blockHash: r.blockHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed, transactionHash: r.transactionHash }] : [] };
}

export async function sessions(): Promise<Session[]> {
  if (!kit) return [];
  const k = await kit;
  return Object.values(k.getActiveSessions()).map((s) => ({ topic: s.topic, dapp: dappOf(k, s.topic), ...accountOf(k, s.topic) }));
}

export async function disconnect(topic: string) {
  await (await kit!).disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
  hooks?.onChange();
}
