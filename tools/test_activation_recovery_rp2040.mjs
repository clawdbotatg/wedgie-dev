/** Test a composed activation snapshot and diagnostics on the virtual Pico. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, root] = process.argv.slice(2);
const { host } = await import(pathToFileURL(join(repo, "tools/rp2040/chip.mjs")));
const report = {};
let sequence = 13;
for (const kind of ["dormant", "active", "missing-worker", "pending-stock-job", "wrong-main"]) {
  const image = readFileSync(join(root, kind + ".img"));
  const board = host({ fs: image });
  for (const pin of [2, 3, 15, 16, 17, 18, 19, 20, 21]) board.chip.mcu.gpio[pin].setInputValue(true);
  const req = (type, fields = {}) => board.req({ id: ++sequence, type, ...fields }, 5000);
  if (kind === "dormant" || kind === "active") {
    assert(board.until(text => text.includes("MEASURED APP READY"), 25000, 20), board.out);
    const hello = req("hello");
    assert(hello?.sealed && hello.running === "safe", board.out);
    const stage = req("paired_stage_begin", { release_size: 100, shelf_size: 30, sizes_size: 20,
      sig: "a".repeat(64) + " " + "b".repeat(64) });
    if (kind === "active") {
      assert.equal(stage?.type, "paired_stage_meta");
      assert.equal(req("paired_stage_abort")?.type, "paired_stage_aborted");
    } else {
      assert.match(stage?.error, /unknown type/);
    }
    report[kind] = { app_running: true, sealed: true, paired_staging_available: kind === "active" };
  } else if (kind === "missing-worker" || kind === "pending-stock-job") {
    assert(board.until(() => board.chip.connected, 15000, 10), board.out);
    assert.equal(req("hello")?.type, "paired_recovery_status");
    const diagnostic = req("paired_recovery_status");
    assert.deepEqual(diagnostic, { id: sequence, type: "paired_recovery_status", sealed: true, open: false,
      writes: false, reason: "integrity_check_failed" });
    for (const type of ["job", "open", "reboot", "press", "safe_sign", "paired_stage_begin", "paired_update"]) {
      assert.deepEqual(req(type), { id: sequence, type: "error", error: "read-only paired recovery" });
    }
    const rawOffset = board.out.length;
    board.chip.write("\x03\x03\x01\n");
    assert(board.until(text => text.slice(rawOffset).includes('{"type":"error","error":"read-only paired recovery"}'),
      3500), board.out);
    assert.equal(req("hello")?.type, "paired_recovery_status");
    assert(!board.out.includes("raw REPL") && !board.out.includes("MEASURED APP READY"));
    assert.deepEqual(Buffer.from(board.chip.mcu.flash.subarray(0xa0000, 0xa0000 + image.length)), image);
    report[kind] = { status_reachable: true, app_started: false, mutations_refused: true, flash_unchanged: true };
  } else {
    board.chip.run(18000);
    assert(!board.chip.connected && !board.out.includes("WRONG MAIN RAN"), board.out);
    report[kind] = { app_started: false, usb_ready: false };
  }
  console.log(JSON.stringify({ kind, ...report[kind] }));
}
writeFileSync(join(root, "activation-recovery-snapshots.json"), JSON.stringify(report, null, 2) + "\n");
