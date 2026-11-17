#!/bin/sh
# wedgie.dev, Linux: let whoever is logged in at this computer open a wedgie from the browser and wedgie.py.
# Without it Chrome says "Access denied" / "Failed to open serial port". Run once:
#   curl -fsSL https://wedgie.dev/linux.sh | sudo sh
# It only writes /etc/udev/rules.d/60-wedgie.rules. With "bench" (the test bench, bench-linux.sh) it also
# tells Chromium / Chrome / Brave that https://wedgie.dev may use these boards without asking.
set -e
cat > /etc/udev/rules.d/60-wedgie.rules <<'R'
# RP2040 / RP2350 BOOTSEL (WebUSB), for the logged-in user
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="0003", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="000f", TAG+="uaccess"
# MicroPython serial port. ModemManager must not probe it (it holds the port for seconds: "busy")
SUBSYSTEM=="usb", ATTR{idVendor}=="2e8a", ATTR{idProduct}=="0005", ENV{ID_MM_DEVICE_IGNORE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", ATTRS{idProduct}=="0005", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1"
R
udevadm control --reload-rules && udevadm trigger --subsystem-match=usb --subsystem-match=tty
if [ "$1" != bench ]; then
  echo "Done. Unplug the wedgie, plug it back in, and restart the browser."
  exit 0
fi
POLICY='{
  "WebUsbAllowDevicesForUrls": [{"devices": [{"vendor_id": 11914, "product_id": 3}, {"vendor_id": 11914, "product_id": 15}], "urls": ["https://wedgie.dev"]}],
  "SerialAllowUsbDevicesForUrls": [{"devices": [{"vendor_id": 11914}], "urls": ["https://wedgie.dev"]}]
}'
for d in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/brave/policies/managed; do
  mkdir -p "$d" && printf '%s\n' "$POLICY" > "$d/wedgie.json"
done
echo "Done. Restart the browser, unplug and replug the Pico, open https://wedgie.dev/test"
