# wedgie for iPhone

wedgie.dev in an app, plus the WEDGIE drive: an iPhone can't open a wedgie's serial port, but it
mounts the WEDGIE drive, so the app talks to the wedgie through files on it. The plan and the
unknowns: `docs/PLAN-IPHONE-APP.md`.

- The underwear button (bottom right) opens the drive panel. Green dot = a wedgie is plugged in.
- Pick the WEDGIE drive once (a security-scoped bookmark is kept), then Hello / Ask to connect /
  any JSON request. Each send is a new `REQ-<n>.TXT`; old ones (5 s+) are deleted first.
- After a send the app reads `ANSWER.TXT` every second for 60 s (the firmware doesn't write it yet).
- The page gets `window.wedgieDrive` (status, send, list, read, panel), only on wedgie.dev.
- Needs the `drive-inbox` firmware for the wedgie to read the files.

## Build and install

```
cd ios/WedgieDrive
xcodegen generate
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project Wedgie.xcodeproj -scheme Wedgie -destination 'id=<device id>' \
  -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl list devices
xcrun devicectl device install app --device <device id> build/Build/Products/Debug-iphoneos/Wedgie.app
```
