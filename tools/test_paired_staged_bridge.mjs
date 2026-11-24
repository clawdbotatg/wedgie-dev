/** Real sealed dispatch, UI, GPIO and LittleFS on the simulated RP2040. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { host } from "./rp2040/chip.mjs";

const tools = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "paired-bridge-"));
let seq = 10;
const errors = new Map([
  ["disabled", /unknown type/],
  ["damaged", /approved content is missing or changed/],
  ["low-space", /insufficient free flash/],
  ["wrong-core", /keeps the installed core version/],
]);
function ready(board, version, core = "0.3.91") {
  assert(board.until((text) => text.includes(version === "70" ? "PAIR APP OLD" : "PAIR APP b'paired core update fixture'"), 20_000), board.out);
  const hello = board.req({ id: ++seq, type: "hello" }, 8_000);
  assert(hello?.sealed && !hello?.open, board.out);
  assert.equal(hello.version, core);
  assert.deepEqual(hello.carts, [{ mod: "safe", v: version }]);
}

function press(board, key) {
  const pin = board.chip.mcu.gpio[key];
  pin.setInputValue(false);
  board.chip.run(175);
  pin.setInputValue(true);
  board.chip.run(55);
}

function upload(req, fixture, filenames, mismatch = false) {
  const parts = [fixture.release, fixture.shelf, fixture.sizes].map((s) => Buffer.from(s));
  const metadata = Buffer.concat(parts);
  const digest = (body) => createHash("sha256").update(body).digest("hex");
  const offer = { release_size: parts[0].length, shelf_size: parts[1].length,
    sizes_size: parts[2].length, sig: fixture.sig };
  let chunkSize = 1024;
  const begin = () => {
    const reply = req("paired_stage_begin", offer);
    if (reply?.type === "paired_stage_meta") chunkSize = reply.chunk ?? 1024;
    return reply;
  };
  const transfer = (type, bytes, offset, fields = {}) => req(type, {
    ...fields, offset, data: bytes.subarray(offset, offset + chunkSize).toString("base64"),
  });

  assert.equal(begin()?.type, "paired_stage_meta");
  assert.match(begin()?.error, /already pending/);
  assert.match(req("paired_stage_put", { name: "pair_stamp.bin", offset: 0, data: "YWJj" })?.error, /manifest and reserve/);
  assert.equal(begin()?.type, "paired_stage_meta");
  assert.match(transfer("paired_stage_meta", metadata, 1)?.error, /out-of-order/);
  let cursor = begin();
  for (let offset = 0; offset < metadata.length; offset += chunkSize) {
    assert.equal(cursor?.type, "paired_stage_meta", JSON.stringify(cursor));
    assert.equal(cursor.offset, offset);
    cursor = transfer("paired_stage_meta", metadata, offset);
  }
  for (const name of filenames) {
    const data = Buffer.from(fixture.payload[name], "base64");
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      assert.deepEqual({ type: cursor?.type, name: cursor?.name, offset: cursor?.offset,
        size: cursor?.size, digest: cursor?.digest },
      { type: "paired_stage_put", name, offset, size: data.length, digest: digest(data) });
      cursor = transfer("paired_stage_put", data, offset, { name });
    }
  }
  if (mismatch) {
    assert.equal(cursor?.type, "error");
    assert.match(cursor.error, /signed runtime version mismatch/);
    return null;
  }
  assert.equal(cursor?.type, "paired_staged", JSON.stringify(cursor));
  assert.equal(cursor.digest, digest(parts[0]));
  assert.match(begin()?.error, /already pending/);
  return cursor.digest;
}

try {
  const versionModes = ["upload-core", "upload-core-mismatch", "upload-same-core-receipt-lost"];
  for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ["decline", "recover", "upload-recover", ...versionModes, ...errors.keys()]) {
    assert(["decline", "recover", "upload-recover", ...versionModes].includes(mode) || errors.has(mode));
    const file = join(directory, mode + ".img");
    execFileSync("uv", ["run", "--offline", "--with", "littlefs-python", "--with", "mpy-cross==1.29.0.post2",
      "python3", "-B", join(tools, "test_paired_staged_bridge_image.py"), mode, file], { stdio: "inherit" });
    const trace = process.env.WEDGIE_PAIRED_TRACE ? (b) => process.stderr.write(Buffer.from(b)) : undefined;
    const board = host({ fs: readFileSync(file), onData: trace });
    for (const pin of [2, 3, 15, 16, 17, 18, 19, 20, 21]) board.chip.mcu.gpio[pin].setInputValue(true);
    ready(board, "70");
    const recv = (expected, ms = 20_000) => assert(board.until(expected, ms, 10), board.out);
    const req = (type, fields = {}) => board.req({ id: ++seq, type, ...fields }, 20_000);

    if (errors.has(mode)) {
      const denied = req("paired_update");
      assert.equal(denied?.type, "error", board.out);
      assert.match(denied.error, errors.get(mode));
      assert(!board.out.includes('"type": "paired_ready"'));
      ready(board, "70");
      console.log(mode + ": " + denied.error);
      continue;
    }

    const invalid = req("paired_update", { approved: true });
    assert.equal(invalid?.type, "error", board.out);
    assert.match(invalid.error, /no arguments/);
    assert.match(req("press", { key: "A" })?.error, /locked/);

    const versioned = versionModes.includes(mode);
    if (versioned) {
      const legacy = req("job", { job: "Update core" });
      assert.equal(legacy?.type, "error");
      assert.match(legacy.error, /uses checked paired updates/);
      assert.equal(req("ping")?.type, "pong");
    }
    const mismatch = mode === "upload-core-mismatch";
    const receiptLost = mode === "upload-same-core-receipt-lost";
    const pins = ["boot.py", "main.py", "wedgie.mpy", "slot.mpy"];
    const baseline = versioned ? req("sums", { names: pins })?.sums : null;
    const stagedDigest = mode.startsWith("upload-") ? upload(req, JSON.parse(readFileSync(file + ".host.json")),
      versioned ? ["pair_core.py", "pair_stamp.bin", "safe.py"] : ["pair_stamp.bin", "safe.py"], mismatch) : null;
    if (mismatch) {
      assert.match(req("paired_update")?.error, /no staged pair available/);
      ready(board, "70");
      assert(!board.out.includes("PAIR EXECUTABLE"));
      console.log("upload-core-mismatch: signed but inconsistent runtime refused before physical review");
      continue;
    }

    const pairId = ++seq;
    board.chip.write(JSON.stringify({ id: pairId, type: "paired_update" }) + "\n");
    recv((text) => /"type": "paired_ready".*?\r?\n/.test(text));
    const preview = board.out.split("\n").filter((line) => line.includes('"type": "paired_ready"')).map((line) => JSON.parse(line.trim())).at(-1);
    assert.equal(preview.id, pairId);
    assert.equal(preview.app, "Safe Signer");
    assert.equal(preview.v, "77");
    const expectedCore = versioned && !receiptLost ? "0.3.92" : "0.3.91";
    assert.equal(preview.core, expectedCore);
    if (stagedDigest) assert.equal(preview.digest, stagedDigest);

    board.chip.write(JSON.stringify({ id: ++seq, type: "press", key: "A" }) + "\n");
    board.chip.run(950);
    assert(!board.out.includes('"type": "paired_accepted"'), board.out);
    if (mode === "decline") {
      press(board, 21);
      recv((text) => text.includes('"type": "refused"'));
      assert(!board.out.includes('"type": "paired_accepted"'));
      recv((text) => text.match(/PAIR APP OLD/g)?.length === 2);
      ready(board, "70");
      assert.match(req("paired_update")?.error, /no staged pair available/);
      console.log("decline: sealed GPIO Y refused, USB A did not approve, app v70 remained");
    } else {
      let mcu = board.chip.mcu;
      let resets = 0;
      const track = (predicate) => (text) => {
        if (mcu !== board.chip.mcu) {
          mcu = board.chip.mcu;
          resets += 1;
        }
        return predicate(text);
      };
      press(board, 15);
      recv(track((text) => /"type": "paired_accepted".*?\r?\n/.test(text)));
      const accepted = board.out.split("\n").filter((line) => line.includes('"type": "paired_accepted"')).map((line) => JSON.parse(line.trim()));
      assert.deepEqual(accepted, [{ id: pairId, type: "paired_accepted", digest: preview.digest }]);
      // MicroPython sets up USB after boot.py. Count the actual MCU resets
      // and read back the result from the app once CDC is ready again.
      recv(track((text) => text.includes("PAIR APP b'paired core update fixture'")), 45_000);
      assert.equal(resets, receiptLost ? 1 : 2, board.out);
      ready(board, "77", expectedCore);
      const sums = req("sums", { names: ["pair_stamp.bin", "serial"] });
      assert.equal(sums?.type, "sums");
      assert.equal(sums.sums.serial, "e7f6c011776e8db7cd330b54174fd76f7d0216b612387a5ffcfb81e6f0919683");
      assert.match(req("paired_update")?.error, /no staged pair available/);
      const save = req("get", { path: "/saves/safe/pair-fixture.json" });
      assert.equal(Buffer.from(save?.data || "", "base64").toString(), "fixture: leave intact");
      if (receiptLost) {
        recv((text) => text.includes("PAIR TEST RECEIPT LOST"));
        const prior = board.chip.mcu;
        assert.equal(req("reboot")?.type, "rebooting");
        recv(() => board.chip.mcu !== prior, 4_000);
        board.chip.run(2_000);
        assert.equal(board.chip.connected, false, board.out);
        assert.equal(board.out.match(/PAIR EXECUTABLE executed new core 0\.3\.91/g)?.length, 1, board.out);
        console.log("upload-same-core-receipt-lost: same-core activation booted once after physical A; receipt loss then withheld USB and app startup");
        continue;
      }
      if (versioned) {
        assert.equal(Object.keys(baseline || {}).length, pins.length);
        assert.deepEqual(req("sums", { names: pins })?.sums, baseline);
        for (const [name, wallet] of [["solana_profile.json", "fixture-local"], ["solana_devnet_profile.json", "fixture-devnet"]]) {
          const profile = req("get", { path: "/saves/safe/" + name });
          assert.equal(Buffer.from(profile?.data || "", "base64").toString(), JSON.stringify({ wallet }));
        }
        const witness = /PAIR EXECUTABLE executed new core 0\.3\.92/g;
        assert.equal(board.out.match(witness)?.length, 1);
        assert.equal(req("reboot")?.type, "rebooting");
        recv((text) => text.match(witness)?.length === 2, 55_000);
        ready(board, "77", "0.3.92");
        console.log("upload-core: changed executable core 0.3.92 ran after recovery and cold reboot; pinned boot and both profiles unchanged");
      }
      console.log(mode + ": one physical A, matching preview digest, watchdog cut, sealed v77 + core marker, save intact");
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
