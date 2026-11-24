/** Exercise the paired boot worker in stock MicroPython on an emulated Pico. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { host } from "./rp2040/chip.mjs";

const tools = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "paired-boot-"));
try {
  const files = process.env.WEDGIE_PAIRED_V77_FIXTURE ? 47 : 4;
  for (const scenario of process.argv.slice(2).length ? process.argv.slice(2) : ["reset", "damaged"]) {
    assert(["reset", "damaged"].includes(scenario));
    const path = join(output, scenario + ".img");
    execFileSync("uv", ["run", "--offline", "--with", "littlefs-python", "python3", "-B",
      join(tools, "test_paired_update_boot_image.py"), scenario, path], { stdio: "inherit" });
    const board = host({ fs: readFileSync(path), onData: process.env.WEDGIE_PAIRED_TRACE ?
      (bytes) => process.stderr.write(Buffer.from(bytes)) : undefined });
    const expected = scenario === "reset" ? "PAIR READY 0.3.91 77 " + files : "PAIR HOLD approved content is missing or changed: safe.mpy";
    const terminal = (text) => /PAIR (?:READY|HOLD|ERROR) .+\r?\n/.test(text);
    assert(board.until(terminal, 45_000, 25), JSON.stringify(board.out));
    if (scenario === "reset") {
      assert(board.out.includes("PAIR RESET safe.mpy"), board.out);
      assert.match(board.out, new RegExp("PAIR READY 0\\.3\\.91 77 " + files + "\\b"));
      assert.equal(board.out.match(/PAIR PREBOOT/g)?.length, 2);
    } else {
      assert(board.out.includes(expected), board.out);
      assert(!board.out.includes("PAIR READY"), board.out);
    }
    assert(!board.out.includes("PAIR ERROR"), board.out);
    console.log(board.out.split("\n").filter((line) => line.includes("PAIR ")).join("\n").trim());
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
