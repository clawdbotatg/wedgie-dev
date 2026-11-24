// Exercise the WalletConnect request listener with a fake WalletKit and no relay.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const replies = [], listeners = {}, asks = [], storage = new Map();
const SAFE = "0x" + "ab".repeat(20), OTHER = "0x" + "de".repeat(20), CHAIN = "eip155:8453";
const methods = ["eth_sendTransaction", "wallet_sendCalls", "wallet_getCapabilities", "personal_sign"];
const sessions = {
  paired: { acknowledged: true, peer: { metadata: { name: "Fixture" } },
    namespaces: { eip155: { accounts: [`${CHAIN}:${SAFE}`], methods } } },
};
globalThis.mockWalletKit = {
  on(event, callback) { listeners[event] = callback; },
  getActiveSessions: () => sessions,
  async respondSessionRequest({ response }) { replies.push(response); },
};
globalThis.location = { origin: "https://fixture.invalid" };
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: name => storage.get(name) ?? null,
  setItem: (name, value) => storage.set(name, value),
} });
globalThis.fetch = () => assert.fail("The request fixture must not use the network");
const mocks = {
  "@walletconnect/core": "export class Core {}",
  "@reown/walletkit": "export const WalletKit = { init: async () => globalThis.mockWalletKit };",
  "@walletconnect/utils": "export const buildApprovedNamespaces = () => {}, getSdkError = () => {};",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (Object.hasOwn(mocks, specifier)) {
    return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
} });
const wc = await import("../src/safe/walletconnect.ts");
hooks.deregister();
await wc.start({ onAsk: request => asks.push(request), onChange() {}, onError: assert.fail,
  receipt: () => assert.fail("An unpaired request reached the receipt hook") });

let id = 0;
async function request(method, args, { topic = "paired", chainId = CHAIN } = {}) {
  const current = ++id;
  await listeners.session_request({ id: current, topic, params: { chainId, request: { method, params: args } } });
  return replies.find(reply => reply.id === current);
}

test("the paired Safe on its agreed chain gets a transaction review", async () => {
  assert.equal(await request("eth_sendTransaction", [{ from: SAFE.toUpperCase().replace("0X", "0x"),
    chainId: "0x2105", to: OTHER, value: "0x1" }]), undefined);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].safe, SAFE);
  assert.equal(asks[0].chainId, 8453);
  assert.deepEqual(asks[0].calls, [{ to: OTHER, value: 1n, data: "0x" }]);
});

test("a Safe batch may omit from and can contain multiple calls", async () => {
  assert.equal(await request("wallet_sendCalls", [{ chainId: "0x2105", calls: [{ to: OTHER }, { to: SAFE }] }]), undefined);
  assert.equal(asks.length, 2);
  assert.equal(asks[1].calls.length, 2);
});

test("wrong chain, sender, unsupported methods, and disconnected topics cannot request approval", async () => {
  const call = { from: SAFE, to: OTHER };
  const wrongChain = await request("eth_sendTransaction", [call], { chainId: "eip155:1" });
  assert.equal(wrongChain.error.code, 4902);
  assert.equal((await request("eth_sendTransaction", [{ ...call, chainId: 1 }])).error.code, 4902);
  assert.equal((await request("eth_sendTransaction", [{ ...call, from: OTHER }])).error.code, 4100);
  assert.equal((await request("wallet_sendCalls", [{ from: OTHER, calls: [call] }])).error.code, 4100);
  assert.equal((await request("wallet_getCapabilities", [OTHER])).error.code, 4100);
  assert.equal((await request("personal_sign", ["0x01", SAFE])).error.code, 4200);
  assert.equal((await request("wallet_getCallsStatus", ["0x01"])).error.code, 4200);
  assert.equal((await request("eth_sendTransaction", [call], { topic: "disconnected" })).error.code, 4100);
  assert.equal((await request("eth_sendTransaction", [call, call])).error.code, 4001);
  assert.equal(asks.length, 2);
});

test("required batch capabilities are refused before queuing any call", async () => {
  const before = asks.length;
  const requestBody = { version: "2.0.0", chainId: "0x2105", atomicRequired: true, calls: [{ to: OTHER }] };
  const requiredTop = await request("wallet_sendCalls", [{
    ...requestBody, capabilities: { paymasterService: { url: "https://example.invalid" } },
  }]);
  const requiredPerCall = await request("wallet_sendCalls", [{
    ...requestBody, calls: [{ to: OTHER }, { to: SAFE, capabilities: { sponsorship: { optional: false } } }],
  }]);
  assert.equal(requiredTop.error.code, 5700);
  assert.equal(requiredPerCall.error.code, 5700);
  assert.equal(asks.length, before);
});

test("optional capabilities preserve the ordered atomic calls", async () => {
  const before = asks.length;
  const response = await request("wallet_sendCalls", [{
    version: "2.0.0", chainId: "0x2105", atomicRequired: true,
    capabilities: { paymasterService: { optional: true } },
    calls: [{ to: OTHER, value: "0x1" }, { to: SAFE, capabilities: { sponsorship: { optional: true } } }],
  }]);
  assert.equal(response, undefined);
  assert.equal(asks.length, before + 1);
  assert.deepEqual(asks.at(-1).calls, [{ to: OTHER, value: 1n, data: "0x" }, { to: SAFE, value: 0n, data: "0x" }]);
});

test("malformed capability containers cannot reach approval", async () => {
  const before = asks.length;
  assert.equal((await request("wallet_sendCalls", [{ calls: [{ to: OTHER }], capabilities: [] }])).error.code, -32602);
  assert.equal((await request("wallet_sendCalls", [{ calls: [{ to: OTHER, capabilities: { paymasterService: true } }] }])).error.code, -32602);
  assert.equal(asks.length, before);
});
