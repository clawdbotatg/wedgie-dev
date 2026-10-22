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
// the Safe a pasted link connects, and how that ends: the app confirmed the session, or it didn't
let want: { safe: string; chainId: number; done: (e?: Error) => void } | null = null;
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

/** Connect an app: its wc: link, for this Safe. Resolves only once the app has confirmed the session. */
export async function pair(uri: string, safe: string, chainId: number) {
  if (!/^wc:/.test(uri.trim())) throw new Error("That isn't a WalletConnect link (it starts with wc:).");
  const k = await kit!;
  const ended = new Promise<void>((ok, no) => { want = { safe, chainId, done: (e) => (e ? no(e) : ok()) }; });
  const slow = setTimeout(() => want?.done(new Error("The app never asked to connect. Copy a fresh link from it and paste that.")), 30_000);
  try {
    await k.pair({ uri: uri.trim() });
    await ended;
  } finally { clearTimeout(slow); want = null; }
}

async function onProposal(k: Kit, p: WalletKitTypes.SessionProposal) {
  const w = want;
  want = null;
  if (!w) { await k.rejectSession({ id: p.id, reason: getSdkError("USER_REJECTED") }); return; }
  try { await approve(k, p, w); w.done(); } catch (e: any) { w.done(e); }
}

async function approve(k: Kit, p: WalletKitTypes.SessionProposal, w: { safe: string; chainId: number }) {
  // A link the app has already replaced (its QR refreshes every few minutes) gets a session nobody answers.
  if (p.params.expiryTimestamp && p.params.expiryTimestamp * 1000 < Date.now()) {
    await k.rejectSession({ id: p.id, reason: getSdkError("USER_REJECTED") }).catch(() => {});
    throw new Error("That link is old. Copy a fresh one from the app.");
  }
  const chain = `eip155:${w.chainId}`;
  let namespaces;
  try {
    namespaces = buildApprovedNamespaces({ proposal: p.params,
      supportedNamespaces: { eip155: { chains: [chain], methods: METHODS, events: EVENTS, accounts: [`${chain}:${w.safe}`] } } });
  } catch {
    await k.rejectSession({ id: p.id, reason: getSdkError("UNSUPPORTED_CHAINS") });
    throw new Error(`${p.params.proposer.metadata.name || "The app"} wants a chain this Safe isn't on. Switch the app to this Safe's chain and try again.`);
  }
  const s = await k.approveSession({ id: p.id, namespaces });
  // Approved isn't connected: wait for the app to confirm, or say so and drop the session.
  let ack = false;
  for (let i = 0; i < 40 && !ack; i++) { await new Promise((r) => setTimeout(r, 500)); ack = !!k.getActiveSessions()[s.topic]?.acknowledged; }
  if (!ack) {
    await k.disconnectSession({ topic: s.topic, reason: getSdkError("USER_DISCONNECTED") }).catch(() => {});
    hooks?.onChange();
    throw new Error(`${p.params.proposer.metadata.name || "The app"} didn't answer. Keep its window open, copy a fresh link, and paste that.`);
  }
  hooks?.onChange();
}

const accountOf = (k: Kit, topic: string) => {
  const a = k.getActiveSessions()[topic]?.namespaces.eip155?.accounts?.[0] || "";
  const [, c, addr] = a.split(":");
  return { chainId: +c, safe: addr || "" };
};

// Every answer is saved before it's sent. WalletKit keeps a request until an answer reaches the app and
// replays it on the next page load, so an answer lost on the way (relay dropped mid-sign) brought the
// same swap back to sign and run again. A replayed request now just gets its saved answer again.
const SENT = "wedgie.wc.sent";
type Response = { result: unknown } | { error: { code: number; message: string } };
const sent = (): Record<string, Response & { at: number }> => { try { return JSON.parse(localStorage.getItem(SENT) || "{}"); } catch { return {}; } };
function save(topic: string, id: number, r: Response) {
  const all = { ...sent(), [`${topic}:${id}`]: { ...r, at: Date.now() } };
  const keep = Object.entries(all).sort((x, y) => y[1].at - x[1].at).slice(0, 100);
  try { localStorage.setItem(SENT, JSON.stringify(Object.fromEntries(keep))); } catch {}
}
async function respond(topic: string, id: number, r: Response) {
  save(topic, id, r);
  const k = await kit!;
  for (let i = 0; ; i++) {
    try { return await k.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", ...r } as any }); }
    catch (e) { if (i >= 2 || !k.getPendingSessionRequests().some((x) => x.id === id)) throw e; await new Promise((ok) => setTimeout(ok, 2000)); }
  }
}

async function onRequest(k: Kit, e: WalletKitTypes.SessionRequest) {
  const { topic, id } = e, { method, params } = e.params.request, p = params as any[];
  const old = sent()[`${topic}:${id}`];
  if (old) return respond(topic, id, "error" in old ? { error: old.error } : { result: old.result });
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
  await respond(topic, id, { result });
}
export async function answerError(topic: string, id: number, message = "Rejected", code = 4001) {
  await respond(topic, id, { error: { code, message } });
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
  return Object.values(k.getActiveSessions()).filter((s) => s.acknowledged).map((s) => ({ topic: s.topic, dapp: dappOf(k, s.topic), ...accountOf(k, s.topic) }));
}

export async function disconnect(topic: string) {
  await (await kit!).disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
  hooks?.onChange();
}
