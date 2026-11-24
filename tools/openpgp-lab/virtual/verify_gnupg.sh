#!/bin/sh
set -eu
umask 077

fixture=$(mktemp -d /tmp/pgp-virtual.XXXXXXXX)
verification=$(mktemp -d /tmp/pgp-check.XXXXXXXX)
socket=$(gpgconf --homedir "$fixture" --list-dirs agent-socket)
perl /fixture/assuan-virtual-fixture.pl "$socket" > "$fixture/bridge.log" 2>&1 &
bridge=$!
trap 'kill "$bridge" 2>/dev/null || true; wait "$bridge" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$socket" ] && break
    sleep 0.1
done
test -S "$socket"
client() { gpg --no-options --homedir "$fixture" --batch --no-tty --no-autostart "$@"; }
verify() { gpg --no-options --homedir "$verification" --batch --no-tty --no-autostart "$@"; }
if ! client --pinentry-mode loopback --passphrase '' --quick-gen-key 'Virtual OpenPGP test fixture' nistp256 sign 1d > "$fixture/gen.log" 2>&1; then
    cat "$fixture/bridge.log" "$fixture/gen.log" >&2
    exit 1
fi
client --with-colons --with-keygrip --list-keys > "$fixture/identity"
fingerprint=$(awk -F: '$1 == "fpr" {print $10; exit}' "$fixture/identity")
grip=$(awk -F: '$1 == "grp" {print $10; exit}' "$fixture/identity")
test -n "$fingerprint"
test -n "$grip"
test -z "$(find "$fixture" -name '*.key' -print)"
printf '%s\n' 'Detached message from the virtual RP2040 OpenPGP fixture' > "$fixture/message"
if ! client --local-user "$fingerprint" --digest-algo SHA256 \
        --output "$fixture/detached.sig" --detach-sign "$fixture/message" > "$fixture/sig.log" 2>&1; then
    cat "$fixture/bridge.log" "$fixture/sig.log" >&2
    exit 1
fi
client --output "$fixture/pub.gpg" --export "$fingerprint"
verify --import "$fixture/pub.gpg" > /dev/null 2>&1
verify --status-fd 1 --verify "$fixture/detached.sig" "$fixture/message" > "$fixture/verified" 2>/dev/null
grep -q "^\[GNUPG:\] VALIDSIG $fingerprint " "$fixture/verified"
printf '%s\n' 'Altered fixture message' > "$fixture/tampered"
if verify --verify "$fixture/detached.sig" "$fixture/tampered" >/dev/null 2>&1; then
    echo 'Unexpected signature acceptance after modification' >&2
    exit 1
fi
if client --local-user "$fingerprint" --digest-algo SHA256 --output "$fixture/second.sig" \
        --detach-sign "$fixture/message" >/dev/null 2>&1; then
    echo 'Unexpected additional approval-free signature' >&2
    exit 1
fi
test ! -s "$fixture/second.sig"
test -z "$(find "$fixture" "$verification" -name '*.key' -print)"
printf '%s\n' 'PASS: GnuPG certified an RP2040-generated Trust M key and verified its detached signature in a fresh public-only keyring.'
printf '%s\n' 'PASS: A changed message and a fourth signing operation were refused.'
