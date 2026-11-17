#!/bin/sh
# wedgie.dev test bench, Linux: linux.sh (the udev rules), plus the Chromium / Chrome / Brave policy that lets
# https://wedgie.dev use Raspberry Pi boards without asking. Run once with sudo. Not the bench? Use linux.sh.
set -e
curl -fsSL https://wedgie.dev/linux.sh | sh -s bench
