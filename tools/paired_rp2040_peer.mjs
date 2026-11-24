/** Stdio adapter for a disposable RP2040 emulator. It never opens host serial. */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [repo, image, mode] = process.argv.slice(2);
const signer = mode?.startsWith("actual-signer");
let board;
if (signer) {
  const { boot, flashFromUf2 } = await import(pathToFileURL(join(repo, "src/chip/sim.ts")));
  const { newTrustM, trustM } = await import(pathToFileURL(join(repo, "src/chip/trustm.ts")));
  const flash = flashFromUf2(readFileSync(join(repo, "public/mp/RPI_PICO.uf2")));
  flash.set(readFileSync(image), 0xa0000);
  const state = newTrustM();
  const scalar = n => Buffer.from([...Buffer.alloc(31), n]);
  for (const [slot, value] of [[0xe0f1, 17], [0xe0f3, 19], [0xe0f2, 23]]) {
    state.keys[slot] = { alg: 3, priv: scalar(value).toString("hex"), usage: 16 };
  }
  const ethKey = createECDH("prime256v1");
  ethKey.setPrivateKey(scalar(17));
  const eth = ethKey.getPublicKey().subarray(1);
  state.data[0xf1db] = Buffer.concat([Buffer.from("wsafe1"), eth]).toString("hex");
  state.meta[0xe0f1] = {192: "07"};
  state.meta[0xf1db] = {192: "07"};
  let output = "", chip;
  chip = boot({
    flash, rom: readFileSync(join(repo, "tools/rp2040/bootrom-b1.bin")),
    uid: Uint8Array.of(0xee,0xe0,0,0,0,0,0,3),
    i2c: trustM(state, () => chip?.ms ?? 0, () => {}),
    onData: data => { output += Buffer.from(data).toString("latin1"); }
  });
  function until(check, budget = 25000, step = 8) {
    const end = chip.ms + budget;
    do {
      if (check(output)) return true;
      chip.run(step);
    } while (chip.ms < end);
    return check(output);
  }
  board = { chip, until, get out() { return output; }, take() { output = ""; },
    req(message, budget) {
      assert(chip.connected, "Virtual signer USB disconnected");
      chip.write(Buffer.from(JSON.stringify(message) + "\n"));
      assert(until(() => got(message.id).length, budget), "No signer reply: " + output.slice(-180));
      return got(message.id).at(-1);
    }};
} else {
  const { host } = await import(pathToFileURL(join(repo, "tools/rp2040/chip.mjs")));
  board = host({ fs: readFileSync(image) });
  for (const pin of [2, 3, 15, 16, 17, 18, 19, 20, 21]) board.chip.mcu.gpio[pin].setInputValue(true);
}
const oldReady = signer ? /"type": "ready"/ : /PAIR APP OLD/;
assert(board.until(text => oldReady.test(text), 28000, 20), "Old test app did not boot");
let seq = 100, reviewId = null, previous = board.chip.mcu, resets = 0;
const emit = object => console.log(JSON.stringify(object));
const got = id => board.out.split("\n").flatMap(line => {
  if (!line.startsWith("{") || !line.includes('"id"')) return [];
  try {
    const reply = JSON.parse(line.trim());
    return reply.id === id ? [reply] : [];
  } catch {
    return [];
  }
});

for await (const line of createInterface({ input: process.stdin })) {
  const action = JSON.parse(line);
  if (action.request) {
    const message = { ...action.request, id: ++seq };
    if (message.type === "paired_update") reviewId = message.id;
    board.take();
    const reply = board.req(message, 25000);
    assert(reply, "No virtual USB reply to " + message.type);
    if (reply.type === "error") console.error(board.out.slice(-1800));
    emit(reply);
  } else if (action.fixture === "green") {
    assert(reviewId !== null && got(reviewId).some(r => r.type === "paired_ready"), "No ready fixture prompt");
    board.chip.run(950);
    const pin = board.chip.mcu.gpio[15];
    if (signer) board.chip.key("A", true);
    else pin.setInputValue(false);
    board.chip.run(175);
    if (signer) board.chip.key("A", false);
    else pin.setInputValue(true);
    board.chip.run(55);
    assert(board.until(() => got(reviewId).some(r => r.type === "paired_accepted"), 25000, 10), "No acceptance receipt: " + board.out.slice(-1200));
    emit(got(reviewId).find(r => r.type === "paired_accepted"));
    reviewId = null;
  } else if (action.fixture === "wait_boot") {
    assert(board.until(text => {
      if (board.chip.mcu !== previous) {
        previous = board.chip.mcu;
        resets += 1;
      }
      return signer ? /"type": "ready"/.test(text) && text.includes("safe-78")
        : text.includes("PAIR APP b'paired core update fixture'");
    }, 45000, 8), "Approved pair failed to boot after recovery");
    emit({ resets });
  } else if (action.fixture === "cold_boot") {
    assert(signer, "Cold boot is available only with disposable Trust M fixtures");
    board.take();
    board.chip.powerCycle();
    assert(board.until(text => /"type": "ready"/.test(text) && text.includes("safe-78"), 45000, 8),
      "Fresh virtual board did not boot from the committed flash and chip state");
    emit({ cold_boot: true });
  } else {
    throw new Error("Unexpected emulator fixture command");
  }
}
