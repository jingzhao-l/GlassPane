#!/usr/bin/env bash
# glasspane-preflight.sh — check the build environment BEFORE `bun run build`.
#
# Why: `script/build.ts` internally runs `bun add ghostty-web@github:…`. On a
# machine whose network presents an intercepting TLS root for
# objects.githubusercontent.com, that resolution fails — but only after the ~10
# minute Vite phase, with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and no hint that the
# fix is a trust anchor. Worse, the answer "just use the npm copy" is wrong here:
# upstream pins a git commit, and npm `ghostty-web@0.4.0` is a different,
# unverified artifact, so swapping the source would be an unreviewed dependency
# change inside a fork that promises byte-traceable divergence.
#
# So this verifies the thing that actually decides bun's success: can the CA
# bundle we hand to subprocesses validate the chain that host really serves?
# It never disables verification; it reports whether trust exists.
set -uo pipefail

DEP_HOST=objects.githubusercontent.com
DEP_URL_HINT="github:anomalyco/ghostty-web (pinned by upstream packages/app/package.json)"
fail=0
say() { printf '%-26s %s\n' "$1" "$2"; }

echo "=== glasspane build preflight (host: $(hostname))"

if ! command -v openssl >/dev/null 2>&1; then
  say "openssl" "MISSING — cannot measure the trust chain"
  exit 2
fi

chain=$(echo | openssl s_client -connect "$DEP_HOST:443" -servername "$DEP_HOST" -showcerts 2>/dev/null)
if [ -z "$chain" ]; then
  say "$DEP_HOST" "unreachable — build will fail regardless; fix network first"
  exit 1
fi
issuer=$(printf '%s' "$chain" | grep -m1 -E "^ *1 s:|^ *i:" | sed -E 's/.*CN=//' | head -1)
leaf_issuer=$(echo | openssl s_client -connect "$DEP_HOST:443" -servername "$DEP_HOST" 2>/dev/null | grep -m1 "i:" | sed 's/.*CN=//')
say "leaf issued by" "${leaf_issuer:-unknown}"

bundle="${NODE_EXTRA_CA_CERTS:-}"
if [ -z "$bundle" ]; then
  say "NODE_EXTRA_CA_CERTS" "NOT SET"
  cat >&2 <<EOF

  This host's TLS trust for $DEP_HOST comes from a locally installed root
  (issuer above), which bun does not read from the macOS keychain. Without the
  bundle, '$DEP_URL_HINT' fails after the 10-minute Vite phase.

  Remedy (does NOT disable verification — it hands bun the roots this machine
  already trusts):
    mkdir -p /var/tmp/glasspane-harness
    security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain \\
      >  /var/tmp/glasspane-harness/ca-bundle.pem
    security find-certificate -a -p /Library/Keychains/System.keychain          \\
      >> /var/tmp/glasspane-harness/ca-bundle.pem
    export NODE_EXTRA_CA_CERTS=/var/tmp/glasspane-harness/ca-bundle.pem
  Then re-run this preflight, then 'bun run build'.
EOF
  exit 1
fi
[ -r "$bundle" ] || { say "bundle" "unreadable: $bundle"; exit 1; }
count=$(grep -c "BEGIN CERTIFICATE" "$bundle")
say "bundle" "$bundle ($count certs)"

# Prove the bundle can validate the chain bun will see — leaf + intermediates.
tmp=$(mktemp -d)
printf '%s' "$chain" | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' > "$tmp/chain.pem"
if openssl verify -CAfile "$bundle" "$tmp/chain.pem" > "$tmp/verify.out" 2>&1; then
  say "verification" "OK — bundle validates $DEP_HOST"
else
  say "verification" "FAILED — bundle does not contain the needed root"
  sed 's/^/    /' "$tmp/verify.out" | head -4
  echo "  Remedy: rebuild the bundle so it includes /Library/Keychains/System.keychain" >&2
  echo "  (that is where an intercepting root lives); do NOT add a TLS-bypass flag." >&2
  fail=1
fi
rm -rf "$tmp"

if [ "$fail" = "0" ]; then
  echo "preflight OK — safe to run: bun run build  (Vite ~3-10 min, then bun add of the git dep)"
  exit 0
fi
echo "preflight FAILED — fix trust before building, not after 10 minutes of Vite." >&2
exit 1
