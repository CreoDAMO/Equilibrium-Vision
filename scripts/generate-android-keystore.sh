#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-android-keystore.sh — Create a self-signed PKCS12 keystore for
# signing release APKs of the Equilibrium mobile miner.
#
# Produces a long-lived (30-year) signing identity suitable for direct
# sideloading distribution (no Play Store submission). Uses openssl instead
# of `keytool` so it runs without a JDK installed.
#
# Usage:
#   ./scripts/generate-android-keystore.sh [output-dir]
#
# Output (in output-dir, default /tmp/equilibrium-keystore):
#   release-keystore.p12   — the keystore itself (KEEP PRIVATE, back it up)
#   keystore_base64.txt    — base64-encoded keystore for the
#                             ANDROID_KEYSTORE_BASE64 GitHub secret
#   credentials.txt        — alias + passwords generated for this run
#
# After running, copy these into your GitHub repo's
# Settings → Secrets and variables → Actions:
#   ANDROID_KEYSTORE_BASE64   = contents of keystore_base64.txt
#   ANDROID_KEYSTORE_PASSWORD = store password from credentials.txt
#   ANDROID_KEY_ALIAS         = alias from credentials.txt
#   ANDROID_KEY_PASSWORD      = key password from credentials.txt
#
# IMPORTANT: Losing this keystore means you can never publish an update that
# Android will treat as "the same app" for existing sideloaded installs —
# back up release-keystore.p12 somewhere safe (password manager / vault),
# outside of git.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

OUT_DIR="${1:-/tmp/equilibrium-keystore}"
mkdir -p "${OUT_DIR}"
cd "${OUT_DIR}"

ALIAS="equilibrium-release"
STORE_PASS="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-32)"
KEY_PASS="${STORE_PASS}"

openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 10950 -nodes \
  -subj "/CN=Equilibrium Miner/O=Equilibrium/OU=Mobile/C=US" 2>/dev/null

openssl pkcs12 -export \
  -in cert.pem -inkey key.pem \
  -out release-keystore.p12 \
  -name "${ALIAS}" \
  -passout pass:"${STORE_PASS}"

rm -f key.pem cert.pem

base64 -w0 release-keystore.p12 > keystore_base64.txt

cat > credentials.txt <<EOF
ANDROID_KEY_ALIAS=${ALIAS}
ANDROID_KEYSTORE_PASSWORD=${STORE_PASS}
ANDROID_KEY_PASSWORD=${KEY_PASS}
EOF

echo "✓ Keystore generated in ${OUT_DIR}/"
echo "  release-keystore.p12  (back this up privately, do NOT commit it)"
echo "  keystore_base64.txt   (paste into ANDROID_KEYSTORE_BASE64 secret)"
echo "  credentials.txt       (paste alias/passwords into GitHub secrets)"
