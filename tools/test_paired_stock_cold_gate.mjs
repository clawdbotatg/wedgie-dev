/** Failure paths are exercised only against disposable RP2040 flash images. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host } from "./rp2040/chip.mjs";

const [results] = process.argv.slice(2);
const report = {};
let id = 120;
for (const variant of ["committed", "missing-worker", "torn-serial"]) {
  const board = host({ fs: readFileSync(join(results, variant + ".img")) });
  for (const pin of [2, 3, 15, 16, 17, 18, 19, 20, 21]) board.chip.mcu.gpio[pin].setInputValue(true);
  const ready = board.until(s => /"type": "ready"|MIGRATION APP/.test(s), 14000, 20);
  if (variant === "committed") {
    assert(ready, "Committed bootstrap did not start the app: " + board.out.slice(-1200));
    const hello = board.req({ type: "hello", id: ++id }, 5000);
    assert(hello?.sealed && hello.running === "safe");
    const legacy = board.req({ type: "job", job: "Update firmware", id: ++id }, 5000);
    assert.match(legacy?.error, /uses checked paired updates/);
    const start = board.req({ type: "paired_stage_begin", release_size: 100, shelf_size: 30, sizes_size: 20,
      sig: "a".repeat(64) + " " + "b".repeat(64), id: ++id }, 5000);
    assert.equal(start?.type, "paired_stage_meta");
    const abort = board.req({ type: "paired_stage_abort", id: ++id }, 5000);
    assert.equal(abort?.type, "paired_stage_aborted");
    report[variant] = { running: true, sealed: true, stock_job_refused: true, paired_stage_available: true };
  } else {
    assert(!ready, "Incomplete activation started a running app");
    assert(!board.chip.connected, "Incomplete activation offered a live USB endpoint");
    report[variant] = { app_started: false, usb_ready: false };
  }
  console.log(JSON.stringify({ variant, ...report[variant] }));
}
writeFileSync(join(results, "cold-gate-rp2040.json"), JSON.stringify(report, null, 2) + "\n");
