#!/bin/sh
set -eu
umask 077

fixture=$(mktemp -d /tmp/pgp-bench.XXXXXXXX)
client_home="$fixture/client"
token_home="$fixture/token"
bridge_pid=
cleanup() {
    if [ -n "$bridge_pid" ]; then
        kill "$bridge_pid" 2>/dev/null || true
        wait "$bridge_pid" 2>/dev/null || true
    fi
    gpgconf --homedir "$token_home" --kill gpg-agent 2>/dev/null || true
    rm -rf "$fixture"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$client_home" "$token_home"

token_gpg() { gpg --no-options --homedir "$token_home" --batch --no-tty "$@"; }
client_gpg() { gpg --no-options --homedir "$client_home" --batch --no-tty --no-autostart "$@"; }
token_gpg --pinentry-mode loopback --passphrase '' --quick-gen-key 'OpenPGP external fixture' nistp256 sign 1d >/dev/null 2>&1
token_gpg --with-colons --with-keygrip --list-secret-keys > "$fixture/identity" 2>/dev/null
fingerprint=$(awk -F: '$1 == "fpr" {print $10; exit}' "$fixture/identity")
keygrip=$(awk -F: '$1 == "grp" {print $10; exit}' "$fixture/identity")
test -n "$fingerprint"
test -n "$keygrip"
token_gpg --export --output "$fixture/token-public.gpg" "$fingerprint"
client_gpg --import "$fixture/token-public.gpg" >/dev/null 2>&1
test -z "$(find "$client_home" -name '*.key' -print)"

token_socket=$(gpgconf --homedir "$token_home" --list-dirs agent-socket)
client_socket=$(gpgconf --homedir "$client_home" --list-dirs agent-socket)
agent_version=$(gpg-agent --version | awk 'NR == 1 {print $NF}')
perl /fixture/assuan-sign-fixture.pl "$client_socket" "$token_socket" "$keygrip" "$agent_version" \
    </dev/null > "$fixture/bridge.log" 2>&1 &
bridge_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$client_socket" ] && break
    sleep 0.1
done
test -S "$client_socket"

digest=$(printf '%064d' 0)
other_grip=$(printf '%040d' 0)
gpg-connect-agent --raw-socket "$client_socket" \
    "SIGKEY $other_grip" "SIGKEY $keygrip" "SETHASH 8 $digest" 'SETHASH 8 1234' PKSIGN /bye > "$fixture/rejections"
grep -q '^ERR .*Unknown keygrip' "$fixture/rejections"
grep -q '^ERR .*Unsupported fixture request' "$fixture/rejections"
grep -q '^ERR .*Fixture approval unavailable' "$fixture/rejections"
test "$(grep -c '^D ' "$fixture/rejections" || true)" -eq 0

printf '%s\n' 'Disposable GnuPG external signing fixture' > "$fixture/message"
if ! client_gpg --local-user "$fingerprint" --digest-algo SHA256 \
        --output "$fixture/signature" --detach-sign "$fixture/message" > "$fixture/signing.log" 2>&1; then
    cat "$fixture/bridge.log" >&2
    cat "$fixture/signing.log" >&2
    exit 1
fi
client_gpg --status-fd 1 --verify "$fixture/signature" "$fixture/message" > "$fixture/verification" 2>/dev/null
grep -q "^\[GNUPG:\] VALIDSIG $fingerprint " "$fixture/verification"
printf '%s\n' 'Changed fixture text' > "$fixture/modified"
if client_gpg --verify "$fixture/signature" "$fixture/modified" >/dev/null 2>&1; then
    echo 'Unexpected acceptance of an altered message' >&2
    exit 1
fi
if client_gpg --local-user "$fingerprint" --digest-algo SHA256 \
        --output "$fixture/second-signature" --detach-sign "$fixture/message" >/dev/null 2>&1; then
    echo 'Unexpected second signature without approval' >&2
    exit 1
fi
test ! -s "$fixture/second-signature"
test "$(grep -c '^AUTHORIZED_P256_SIGNATURE$' "$fixture/bridge.log")" -eq 1
test -z "$(find "$client_home" -name '*.key' -print)"
printf '%s\n' 'PASS: GnuPG emitted and verified a detached NIST P-256 signature through an isolated Assuan mock token.'
printf '%s\n' 'PASS: Wrong keygrip, invalid digest, stale digest reuse, a second approval-free signature, and modified message were rejected.'
