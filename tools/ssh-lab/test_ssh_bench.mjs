/** Local RP2040 rehearsal. This script owns only the virtual board. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { p256 } from "@noble/curves/nist";

globalThis.fetch = () => { throw new Error("The SSH cartridge test is offline"); };
const [repo, build, report] = process.argv.slice(2);
const { firmware, image } = await import(pathToFileURL(join(repo, "tools/rp2040/image.mjs")));
const { boot, flashFromUf2 } = await import(pathToFileURL(join(repo, "src/chip/sim.ts")));
const { newTrustM, trustM } = await import(pathToFileURL(join(repo, "src/chip/trustm.ts")));
const app = JSON.parse(readFileSync(join(repo, "tools/ssh-lab/wedgie.json"))).apps[0];
app.files = ["ssh_bench.mpy"];
app.chipuse = true;
const F = firmware();
F.app(app, { "ssh_bench.mpy": readFileSync(build) });
const flash = flashFromUf2(readFileSync(join(repo, "public/mp/RPI_PICO.uf2")));
flash.set(image(F, app.mod), 0xa0000);
const state = newTrustM();
for (const [slot, value] of [[0xe0f1, 11], [0xe0f2, 17], [0xe0f3, 23]]) {
  state.keys[slot] = { alg: 3, priv: Buffer.from([...new Uint8Array(31), value]).toString("hex"), usage: 16 };
}
const persistent = structuredClone(state.keys);
const messages = [];
let sim, buffer = "", nextId = 10;
sim = boot({
  rom: readFileSync(join(repo, "tools/rp2040/bootrom-b1.bin")), flash,
  uid: Uint8Array.of(0xee, 0xe0, 0x53, 0x53, 0x48, 0, 0, 1),
  i2c: trustM(state, () => sim?.ms ?? 0, () => {}),
  onData(data) {
    buffer += Buffer.from(data).toString("latin1");
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line.startsWith("{")) {
        try { messages.push(JSON.parse(line)); } catch {}
      } else if (/Error|failed|^Traceback/.test(line)) {
        console.error(line.slice(0, 220));
      }
    }
  },
});
const sha = value => createHash("sha256").update(value).digest();
const hex = value => Buffer.from(value).toString("hex");

function until(check, estimate, failed) {
  const limit = sim.ms + estimate;
  while (sim.ms < limit) {
    const result = check();
    if (result) return result;
    sim.run(20);
  }
  throw new Error(failed);
}

function ready(since) {
  const greeting = until(() => messages.slice(since).find(r => r.type === "ready" && r.running === "ssh_bench"),
    35000, "SSH Bench did not start");
  assert.equal(greeting.sealed, true);
  sim.run(800);
}

function send(type, fields = {}) {
  assert(sim.connected, "USB is not connected");
  const id = ++nextId;
  sim.write(Buffer.from(JSON.stringify({ ...fields, id, type }) + "\n"));
  return id;
}
const reply = id => messages.find(r => r.id === id && r.type !== "ssh_prompt");
const result = (id, estimate = 14000) => until(() => reply(id), estimate, "No terminal USB response for " + id);
const question = id => until(() => messages.find(r => r.id === id && r.type === "ssh_prompt"), 10000, "Missing SSH prompt");

function key(letter) {
  sim.run(800);
  sim.key(letter, true);
  sim.run(180);
  sim.key(letter, false);
  sim.run(180);
}

function packet(value) {
  const data = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

const host = p256.utils.randomPrivateKey();
const paired = { host: hex(p256.getPublicKey(host, false)) };
const alg = "ecdsa-sha2-nistp256";
function proof(publicKey, username, serverKey) {
  const session = randomBytes(32);
  const requestedIdentity = Buffer.concat([packet(alg), packet("nistp256"), packet(publicKey)]);
  const payload = Buffer.concat([packet(session), Buffer.from([50]), packet(username), packet("ssh-connection"),
    packet("publickey"), Buffer.from([1]), packet(alg), packet(requestedIdentity)]);
  const auth = p256.sign(sha(session), serverKey, { prehash: false }).toCompactRawBytes();
  return { session: hex(session), payload: hex(payload), host_signature: hex(auth) };
}

if (report === "--stdio") {
  ready(0);
  console.log(JSON.stringify({ type: "ready" }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const { type, ...fields } = JSON.parse(line);
    assert(["ssh_pair", "ssh_sign"].includes(type), "Unexpected fixture request");
    const id = send(type, fields);
    const initial = until(() => messages.find(item => item.id === id), 10000, "No fixture response");
    if (initial.type === "ssh_prompt") key("A");
    console.log(JSON.stringify(result(id)));
  }
} else {
  ready(0);
  assert.equal(result(send("open", { full: true })).type, "error");
  assert.equal(result(send("press", { key: "A", ms: 1000 })).type, "error");
  assert.equal(result(send("ssh_pair", { host: "00" })).type, "error");
  const declinedPair = send("ssh_pair", paired);
  assert.equal(question(declinedPair).action, "pair");
  const virtualPress = send("press", { key: "A", ms: 1000 });
  sim.run(2200);
  assert.equal(reply(declinedPair), undefined, "USB input approved SSH pairing");
  key("Y");
  assert.equal(result(declinedPair).type, "refused");
  assert.equal(result(virtualPress).type, "error");
  assert.equal(result(send("ssh_pair", paired)).type, "error");
  console.log("Sealed board rejected Full Control and synthetic approval. Physical red declined pairing.");

  const before = messages.length;
  sim.powerCycle();
  ready(before);
  const pairing = send("ssh_pair", paired);
  assert.equal(question(pairing).action, "pair");
  key("A");
  const pairResult = result(pairing);
  assert.equal(pairResult.type, "ssh_pair");
  const publicKey = Buffer.from(pairResult.public, "hex");
  assert.equal(publicKey.length, 65);
  assert.equal(result(send("ssh_pair", paired)).type, "error", "Paired host can be replaced in the same boot");

  const wrongUser = send("ssh_sign", proof(publicKey, "admin", host));
  assert.equal(result(wrongUser).type, "error");
  assert(!messages.some(r => r.id === wrongUser && r.type === "ssh_prompt"));
  const badHost = send("ssh_sign", proof(publicKey, "wedgie-test", p256.utils.randomPrivateKey()));
  assert.equal(result(badHost).type, "error");
  assert(!messages.some(r => r.id === badHost && r.type === "ssh_prompt"));
  console.log("Wrong username and a forged host proof were rejected before asking for approval.");

  const approved = proof(publicKey, "wedgie-test", host);
  const login = send("ssh_sign", approved);
  assert.equal(question(login).action, "sign");
  assert.equal(reply(login), undefined, "Signed the login before physical approval");
  key("A");
  const signed = result(login);
  assert.equal(signed.type, "ssh_sig", signed.error);
  assert(p256.verify(Buffer.from(signed.signature, "hex"), sha(Buffer.from(approved.payload, "hex")),
    publicKey, { prehash: false, lowS: true }));
  assert.equal(result(send("ssh_sign", approved)).type, "error");
  assert.deepEqual(state.keys, persistent, "The app wrote a persistent Trust M key slot");
  assert.equal(result(send("hello")).sealed, true);
  console.log("Physical green signed the bound SSH authentication. Signature verified and replay was rejected.");

  writeFileSync(report, JSON.stringify({
    device: "RP2040 emulator with stock core and virtual Trust M", sealed: true,
    fullAccessRefused: true, usbApprovalRefused: true, pairDeclinePassed: true,
    wrongUserRejected: true, forgedHostRejected: true, physicalApprovalVerified: true,
    sshSignatureVerified: true, replayRejected: true, persistentSlotsPreserved: true,
  }, null, 2) + "\n");
}
