#!/bin/sh
# wedgie.dev test bench, Linux: let the browser open Raspberry Pi boards (USB vendor 2e8a), and tell
# Chromium / Chrome that https://wedgie.dev may use them without asking. Run once with sudo.
set -e
cat > /etc/udev/rules.d/60-wedgie.rules <<'R'
# Raspberry Pi RP2040/RP2350: boot mode (WebUSB) and MicroPython's serial port, for the logged-in user
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", MODE="0666", TAG+="uaccess"
R
udevadm control --reload-rules && udevadm trigger
POLICY='{
  "WebUsbAllowDevicesForUrls": [{"devices": [{"vendor_id": 11914, "product_id": 3}, {"vendor_id": 11914, "product_id": 15}], "urls": ["https://wedgie.dev"]}],
  "SerialAllowUsbDevicesForUrls": [{"devices": [{"vendor_id": 11914}], "urls": ["https://wedgie.dev"]}]
}'
for d in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/brave/policies/managed; do
  mkdir -p "$d" && printf '%s\n' "$POLICY" > "$d/wedgie.json"
done
echo "Done. Restart the browser, unplug and replug the Pico, open https://wedgie.dev/test"
