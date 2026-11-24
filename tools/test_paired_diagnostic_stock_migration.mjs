/** Two normal, signed stock jobs against a sealed disposable RP2040 image. */
import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist";
import { boot, flashFromUf2 } from "../src/chip/sim.ts";
import { newTrustM, trustM } from "../src/chip/trustm.ts";

const [image, report, flag] = process.argv.slice(2);
assert(image && report && (flag === undefined || flag === "--faults"));
const faults = flag === "--faults";
const fixture = JSON.parse(readFileSync(image + ".host.json", "utf8"));
const flash = flashFromUf2(readFileSync(join(import.meta.dirname, "../public/mp/RPI_PICO.uf2")));
flash.set(readFileSync(image), 0xa0000);
const hash = data => createHash("sha256").update(data).digest("hex");
const replies = [];
let trace = "", partial = "", seq = 400;
let i2c, sim;
if (fixture.actual) {
  const state = newTrustM();
  const scalar = n => Buffer.from([...Buffer.alloc(31), n]);
  for (const [slot, value] of [[0xe0f1, 17], [0xe0f3, 19], [0xe0f2, 23]]) {
    state.keys[slot] = { alg: 3, priv: scalar(value).toString("hex"), usage: 16 };
  }
  const key = createECDH("prime256v1");
  key.setPrivateKey(scalar(17));
  state.data[0xf1db] = Buffer.concat([Buffer.from("wsafe1"), key.getPublicKey().subarray(1)]).toString("hex");
  state.meta[0xe0f1] = state.meta[0xf1db] = {192: "07"};
  i2c = trustM(state, () => sim?.ms ?? 0, () => {});
}
sim = boot({
  flash, rom: readFileSync(join(import.meta.dirname, "rp2040/bootrom-b1.bin")),
  uid: Uint8Array.of(0xee, 0xe0, 0, 0, 0, 0, 0, 13),
  i2c,
  onData(data) {
    const incoming = Buffer.from(data).toString("latin1");
    trace += incoming;
    partial += incoming;
    let at;
    while ((at = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, at).trim();
      partial = partial.slice(at + 1);
      if (!line.startsWith("{")) continue;
      try { replies.push(JSON.parse(line)); } catch {}
    }
  },
});

function until(what, budget, error) {
  const end = sim.ms + budget;
  do {
    const value = what();
    if (value) return value;
    sim.run(20);
  } while (sim.ms < end);
  throw new Error(error + "\n" + trace.slice(-2800));
}

function emit(body, raw) {
  assert(sim.connected, "Lost virtual USB before sending " + body.type);
  const line = Buffer.from(JSON.stringify(body) + "\n");
  sim.write(raw ? Buffer.concat([line, raw]) : line);
}

function send(type, fields = {}, raw) {
  const id = ++seq;
  emit({ id, type, ...fields }, raw);
  return id;
}

function reply(id, type) {
  return replies.find(row => row.id === id && (type ? row.type === type : !["list", "go"].includes(row.type)));
}

function request(type, fields, raw) {
  const id = send(type, fields, raw);
  return until(() => reply(id), 32000, "No reply for " + type);
}

function key(name) {
  sim.key(name, true);
  sim.run(175);
  sim.key(name, false);
  sim.run(90);
}

function booted(since) {
  return until(() => sim.connected && replies.slice(since).find(row => row.type === "ready" && row.running === "safe"),
    42000, "The old fixture app did not boot");
}

let fixtureSigner;
function health(upgraded = false) {
  const h = request("hello");
  assert(h.sealed && !h.open && h.version === (upgraded ? "0.3.92" : "0.3.91"), JSON.stringify(h));
  assert.deepEqual(h.carts, [upgraded ? fixture.new_cart : fixture.old_cart ?? { mod: "safe", v: "70" }]);
  assert.equal(request("get", { path: "/saves/safe/migration.json" }).data, fixture.save);
  if (fixture.actual) {
    assert.equal(h.app, "safe-" + (upgraded ? fixture.new_app_version : fixture.old_app_version));
    assert.equal(h.safe_state, "ok");
    assert(h.signer);
    fixtureSigner ??= h.signer;
    assert.equal(h.signer, fixtureSigner);
    for (const [network, profile] of Object.entries(fixture.profiles)) {
      assert.deepEqual(request("sol_status", { network }).profile, profile);
    }
    for (const [name, encoded] of Object.entries(fixture.saves)) {
      assert.equal(request("get", { path: "/saves/safe/" + name }).data, encoded);
    }
    if (upgraded) {
      assert.equal(h.bench_runtime, "executed signed core 0.3.92");
      for (const type of ["sol_status", "sol_enroll", "sol_sign"]) {
        const denied = request(type, { network: "mainnet" });
        assert.equal(denied.type, "error");
        assert.match(denied.error, /unknown Solana network/);
      }
    }
  }
  return h.uid;
}

function sums(expected) {
  const names = Object.keys(expected).sort();
  for (let at = 0; at < names.length; at += 8) {
    const group = names.slice(at, at + 8);
    const found = request("sums", { names: group });
    assert.equal(found.type, "sums");
    assert.deepEqual(found.sums, Object.fromEntries(group.map(n => [n, expected[n]])));
  }
}

function phase(plan) {
  sums({ ...plan.hashes, ...fixture.old_cartridge, serial: hash(String(plan.serial)) });
  assert.equal(health(), fixtureUid);
}

function dormantOnly() {
  const response = request("paired_stage_begin");
  assert.equal(response.type, "error");
  assert.match(response.error, /unknown type/);
}

function pieces(text) {
  const parts = [];
  let part = "";
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g)) {
    if (part && part.length + line.length > 512) {
      parts.push(part);
      part = "";
    }
    part += line;
  }
  if (part) parts.push(part);
  return parts;
}

function stock(plan, contents, outcome) {
  const names = Object.keys(contents).sort();
  const id = send("job", { job: "Update firmware", version: "0.3.91", write: names, delete: [],
    apps: null, raw: true, list: 1 });
  until(() => reply(id, "list"), 25000, "Stock installer did not ask for its signed list");
  const beginning = trace.length;
  for (const t of pieces(plan.release)) emit({ type: "rel", t });
  emit({ type: "rel", sig: plan.sig });
  until(() => /slot: signed True \d+/.test(trace.slice(beginning)), 35000, "Stock signer did not accept the preflight signature");
  sim.run(750);
  const before = replies.length;
  key(outcome === "decline" ? "Y" : "A");
  if (outcome === "decline") {
    until(() => reply(id, "refused"), 12000, "Physical Y did not refuse stock install");
    booted(before);
    return;
  }
  until(() => reply(id, "go"), 25000, "Stock installer did not enter its checked write mode");
  for (const t of pieces(plan.shelf)) assert.equal(request("apps", { t }).type, "ok");
  assert.equal(request("release", { release: plan.release, sig: plan.sig }).type, "ok");
  for (const name of names) {
    const bytes = Buffer.from(contents[name], "base64");
    assert.equal(hash(bytes), plan.hashes[name]);
    for (let offset = 0; offset < Math.max(bytes.length, 1); offset += 4096) {
      const data = bytes.subarray(offset, offset + 4096);
      const result = request("put", { name, n: data.length, end: offset + data.length === bytes.length }, data);
      assert.equal(result.type, "ok", JSON.stringify(result));
    }
  }
  if (outcome === "cut") {
    const before = replies.length;
    sim.powerCycle();
    booted(before);
    return;
  }
  const beforeCommit = replies.length;
  const done = request("commit");
  assert.equal(done.type, "done", JSON.stringify(done));
  booted(beforeCommit);
}

function checkStockDisabled() {
  const blocked = request("job", { job: "Update firmware", version: "0.3.91", write: [], delete: [] });
  assert.equal(blocked.type, "error");
  assert.match(blocked.error, /stock|legacy|paired/i);
}

function stagePair() {
  checkStockDisabled();
  const probe = fixture.probe;
  const parts = [probe.release, probe.shelf, probe.sizes].map(s => Buffer.from(s));
  const metadata = Buffer.concat(parts);
  let next = request("paired_stage_begin", {
    release_size: parts[0].length, shelf_size: parts[1].length, sizes_size: parts[2].length, sig: probe.sig,
  });
  const chunk = next.chunk ?? 1024;
  for (let at = 0; at < metadata.length; at += chunk) {
    assert.equal(next.type, "paired_stage_meta", JSON.stringify(next));
    assert.equal(next.offset, at);
    next = request("paired_stage_meta", { offset: at, data: metadata.subarray(at, at + chunk).toString("base64") });
  }
  const payload = fixture.actual ? probe.payload : { "pair_core.py": probe.payload };
  for (const [name, encoded] of Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const code = Buffer.from(encoded, "base64");
    for (let at = 0; at < code.length; at += chunk) {
      assert.equal(next.type, "paired_stage_put", JSON.stringify(next));
      assert.deepEqual([next.name, next.offset, next.size, next.digest], [name, at, code.length, hash(code)]);
      next = request("paired_stage_put", { name, offset: at, data: code.subarray(at, at + chunk).toString("base64") });
    }
  }
  assert.equal(next.type, "paired_staged", JSON.stringify(next));
  assert.equal(next.digest, hash(parts[0]));
  return next.digest;
}

function pairedCommit(digest) {
  const id = send("paired_update");
  const ready = until(() => reply(id, "paired_ready") || reply(id, "error") || reply(id, "refused"),
    34000, "The exact pair never reached physical review");
  assert.equal(ready.type, "paired_ready", trace.slice(-2200));
  assert.deepEqual([ready.digest, ready.core, ready.app, ready.v], [digest, "0.3.92", "Safe Signer", fixture.new_cart.v]);
  sim.run(750);
  const before = replies.length;
  let previous = sim.mcu, resets = 0;
  key("A");
  const accepted = until(() => reply(id, "paired_accepted") || reply(id, "error") || reply(id, "refused"),
    34000, "The update did not accept physical GPIO A");
  assert.equal(accepted.type, "paired_accepted", JSON.stringify(accepted));
  assert.equal(accepted.digest, digest);
  until(() => {
    if (sim.mcu !== previous) {
      previous = sim.mcu;
      resets += 1;
    }
    return sim.connected && replies.slice(before).find(row => row.type === "ready" && row.app === "safe-" + fixture.new_app_version);
  }, 50000, "The expected reviewed app did not boot after paired recovery");
  assert.equal(resets, 2, "Expected the approval reset and the injected watchdog cut");
  return resets;
}

function finalPair() {
  sums({ ...fixture.probe.hashes, ...fixture.pinned, serial: hash(String(fixture.probe.serial)) });
  assert.equal(health(true), fixtureUid);
  checkStockDisabled();
}

function checkWalletApprovals() {
  const sha256 = data => createHash("sha256").update(data).digest();
  const eth = request("hello").safe;
  const ethKey = Buffer.from("04" + eth.x.slice(2) + eth.y.slice(2), "hex");
  const text = "Local updater QA";
  const safeMessageHash = "5dea276c880998492ab2ccbe0a46218cfa15f7e189ea65de138944e97695b36e";
  const messageFields = {
    chainId: 84532, safe: "0x1234567890123456789012345678901234567890", hex: Buffer.from(text).toString("hex"),
  };
  let ethereumReviewFrame;

  function review(type, fields, button) {
    assert(request("hello").sealed);
    const before = hash(sim.frame);
    const id = send(type, fields);
    const terminal = () => replies.find(row => row.id === id && row.type !== "sol_prompt");
    if (type === "sol_sign") {
      until(() => reply(id, "sol_prompt"), 14000, "Solana approval did not open");
    } else if (ethereumReviewFrame) {
      assert.notEqual(before, ethereumReviewFrame, "Previous Ethereum review did not clear");
      until(() => hash(sim.frame) === ethereumReviewFrame, 14000, "Ethereum approval did not return");
    } else {
      until(() => hash(sim.frame) !== before, 14000, "Ethereum approval was not displayed");
    }
    sim.run(1100);
    if (type === "safe_message" && !ethereumReviewFrame) ethereumReviewFrame = hash(sim.frame);
    assert.equal(terminal(), undefined, "An update approval must not authorize a wallet request");
    key(button);
    return until(terminal, 18000, "Wallet review did not respond to its own GPIO input");
  }

  const rejectedMessage = review("safe_message", messageFields, "Y");
  assert.equal(rejectedMessage.type, "refused");
  assert.equal(rejectedMessage.r, undefined);
  assert.equal(rejectedMessage.s, undefined);
  sim.run(1200);
  const signed = review("safe_message", messageFields, "A");
  assert.equal(signed.type, "safe_sig");
  assert.equal(signed.messageHash, "0x91d50e348e9bfff41f1722f852adc103955b9c19ba6e82c106aef0c7da4cdf49");
  assert.equal(signed.safeMessageHash, "0x" + safeMessageHash);
  assert.equal(signed.x, eth.x);
  assert.equal(signed.y, eth.y);
  const clientFields = '"origin":"https://wedgie.dev"';
  const auth = Buffer.concat([sha256("wedgie.dev"), Buffer.from([5, 0, 0, 0, 0])]);
  assert.equal(signed.authenticatorData, "0x" + auth.toString("hex"));
  assert.equal(signed.clientDataFields, clientFields);
  const challenge = Buffer.from(safeMessageHash, "hex").toString("base64url");
  const client = sha256(`{"type":"webauthn.get","challenge":"${challenge}",${clientFields}}`);
  const ethSignature = Buffer.from(signed.r.slice(2) + signed.s.slice(2), "hex");
  assert(p256.verify(ethSignature, sha256(Buffer.concat([auth, client])), ethKey, { prehash: false, lowS: true }));

  // Golden SignV2 digests for the fixed public profiles made by the fixture builder.
  const cases = [
    { network: "local", kind: "sol", expected: "caed1725a65ff3da9228d71dd1ffb4e2354686b44a4595dcc3cb0ef7f54f249e" },
    { network: "devnet", kind: "token", expected: "19c4e85a84390478e21d8abd3dd1fa2352f390a3a4ff7049dba02e23f180055a" },
  ];
  for (const { network, kind, expected } of cases) {
    const profile = fixture.profiles[network];
    const fields = { network, kind, swig: profile.swig, wallet: profile.wallet,
      recipient: "7MFRphJW7sMR6PmN9KEpi8ReJTakP6KMDibiM5DpZx7W", amount: 100000,
      slot: 123456, counter: 1, expected, prompt_events: 1 };
    if (kind === "token") {
      fields.source = "4d3mJSf83fVWk2vYkNYajG3hw2T4m65v4JT9d67vamST";
      fields.mint = profile.mint;
    }
    const denied = review("sol_sign", fields, "Y");
    assert.equal(denied.type, "refused");
    assert.equal(denied.reason, "declined");
    assert.equal(denied.signature, undefined);
    sim.run(950);
    const result = review("sol_sign", fields, "A");
    assert.equal(result.type, "sol_ok");
    assert.equal(result.message, expected);
    assert(p256.verify(Buffer.from(result.signature, "hex"), sha256(Buffer.from(expected, "hex")),
      Buffer.from(profile.key, "hex"), { prehash: false, lowS: true }));
  }
  return { ethereumText: true, localSol: true, devnetSpl: true,
    rejectedWithoutSignature: 3, signedOnlyAfterFreshApproval: 3 };
}

booted(0);
const fixtureUid = health();
phase(fixture.initial);
dormantOnly();
if (fixture.start === "partial") {
  assert(!faults, "The partial fixture starts at the second stock job");
  console.log("The synthesized early gate at the dormant serial used the sealed stock boot path.");
} else {
  console.log("Starting sealed stock 0.3.91 with no paired USB handler.");
  if (faults) {
    stock(fixture.dormant, fixture.dormant_payload, "decline");
    phase(fixture.initial);
    dormantOnly();
    console.log("Physical Y refused the first job. Stock files and serial are intact.");
  }
  stock(fixture.dormant, fixture.dormant_payload, "commit");
  phase(fixture.dormant);
  dormantOnly();
  console.log("Signed stock job installed the dormant workers and pinned diagnostic main. Boot/app remain unchanged; paired USB is inactive.");
  if (faults) {
    stock(fixture.active, fixture.activation_payload, "cut");
    phase(fixture.dormant);
    dormantOnly();
    console.log("Power cut after USB staging and before stock commit preserved the dormant boot and serial.");
  }
}
stock(fixture.active, fixture.activation_payload, "commit");
phase(fixture.active);
console.log("The second stock job activated the paired policy without changing the cartridge or saves.");
const pairedDigest = stagePair();
let pairedResets = 0;
let walletApprovals;
if (fixture.actual) {
  assert.equal(health(), fixtureUid);
  console.log(`Staged exact v${fixture.new_app_version} and signed executable core; live v${fixture.old_app_version} remains sealed.`);
  pairedResets = pairedCommit(pairedDigest);
  finalPair();
  console.log("One paired green and two resets restored sealed v78, 0.3.92, all profiles, and mainnet refusal.");
  walletApprovals = checkWalletApprovals();
  console.log("Ethereum, local SOL, and Devnet SPL each required separate GPIO approval after the paired update.");
} else {
  assert.equal(request("paired_stage_abort").type, "paired_stage_aborted");
}
const restarted = replies.length;
sim.powerCycle();
booted(restarted);
if (fixture.actual) finalPair();
else {
  phase(fixture.active);
  stagePair();
  assert.equal(request("paired_stage_abort").type, "paired_stage_aborted");
}
console.log("A fresh power cycle preserved sealed state, app and saves.");
const commits = fixture.start === "partial" ? 1 : 2;
writeFileSync(report, JSON.stringify({
  scope: "Local stock checked migration against a disposable RP2040 and signed bench roots",
  start: fixture.start,
  starting_core: "0.3.91", serials: [...new Set([fixture.initial.serial, fixture.dormant.serial, fixture.active.serial])],
  committed_stock_jobs: commits, physical_commit_approvals: commits, dormant_modules: Object.keys(fixture.dormant_payload),
  dormant_serial_reused: fixture.start !== "partial" && fixture.initial.serial === fixture.dormant.serial,
  active_stock_core_hashes: Object.keys(fixture.active.hashes).length,
  stable_app_version: fixture.actual ? fixture.old_app_version : "70", save_preserved: true, paired_stage_after_activation: true,
  stock_job_locked_after_activation: true, cold_boot_persists_activation: true,
  physical_red_preserved_initial: faults, precommit_power_cut_preserved_dormant: faults,
  synthesized_partial_boot_kept_stock_fallback: fixture.start === "partial",
  ...(fixture.actual ? { reviewed_app_version: fixture.new_app_version, core_after_pair: "0.3.92", paired_green_count: 1,
    paired_reset_count: pairedResets, paired_release: pairedDigest, paired_serial: fixture.probe.serial,
    exact_app_bytes_preserved_across_pair: JSON.stringify(fixture.old_cartridge) === JSON.stringify(fixture.new_cartridge), verified_paired_files: Object.keys(fixture.probe.hashes).length,
    ethereum_signer_preserved: true, solana_profiles_preserved: true, fixture_saves_preserved: Object.keys(fixture.saves).length,
    mainnet_status_enroll_sign_refused: true, signed_executable_core_exercised: true,
    cold_boot_preserves_paired_release: true, post_update_wallet_approvals: walletApprovals } : {}),
}, null, 2) + "\n");
