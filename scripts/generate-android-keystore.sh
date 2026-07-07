#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-android-keystore.sh — Create a self-signed PKCS12 keystore for
# signing release APKs of the Equilibrium mobile miner.
#
# Produces a long-lived (30-year) signing identity suitable for direct
# sideloading distribution (no Play Store submission).
#
# Strategy:
#   1. Use `keytool` (ships with any JDK) — always produces Java-compatible
#      PKCS12 that Android Gradle Plugin can read without issues.
#   2. Fall back to `openssl pkcs12 -export -legacy` if keytool is not found.
#      The `-legacy` flag forces 3DES/RC2 encryption (PBE-SHA1-3DES for keys,
#      RC2_CBC for certs) instead of the OpenSSL 3.x default of AES-256-CBC,
#      which Android Gradle Plugin cannot decrypt.
#
# ⚠️  If you previously generated a keystore with openssl WITHOUT -legacy
#     (the old default in OpenSSL 3.x), the APK signing step will fail with
#     "Given final block not properly padded" even with correct passwords.
#     Re-run this script and update all four GitHub secrets.
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
# After running, update these four GitHub repo secrets
# (Settings → Secrets and variables → Actions):
#   ANDROID_KEYSTORE_BASE64   = contents of keystore_base64.txt
#   ANDROID_KEYSTORE_PASSWORD = store password from credentials.txt
#   ANDROID_KEY_ALIAS         = alias from credentials.txt
#   ANDROID_KEY_PASSWORD      = key password from credentials.txt
#
# IMPORTANT: Losing this keystore means you can never publish an update that
# Android treats as "the same app" for existing sideloaded installs.
# Back up release-keystore.p12 somewhere safe (password manager / vault),
# outside of git.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

OUT_DIR="${1:-/tmp/equilibrium-keystore}"
mkdir -p "${OUT_DIR}"
cd "${OUT_DIR}"

ALIAS="equilibrium-release"
# Same password for store and key — simplest and required for some toolchains.
STORE_PASS="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-32)"
KEY_PASS="${STORE_PASS}"

if command -v keytool > /dev/null 2>&1; then
  echo "Using keytool (Java-native PKCS12, guaranteed Android-compatible)…"
  keytool -genkeypair \
    -keystore release-keystore.p12 \
    -storetype PKCS12 \
    -alias "${ALIAS}" \
    -keyalg RSA \
    -keysize 4096 \
    -validity 10950 \
    -storepass "${STORE_PASS}" \
    -keypass "${KEY_PASS}" \
    -dname "CN=Equilibrium Miner, O=Equilibrium, OU=Mobile, C=US"
  echo "✓ Keystore generated with keytool."
else
  echo "keytool not found — using openssl with -legacy flag (3DES/RC2 for Java compatibility)…"
  # -legacy: forces PBE-SHA1-3DES for keys and RC2_CBC for certs.
  # OpenSSL 3.x default (AES-256-CBC) is NOT readable by Android Gradle Plugin.
  openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
    -days 10950 -nodes \
    -subj "/CN=Equilibrium Miner/O=Equilibrium/OU=Mobile/C=US" 2>/dev/null

  openssl pkcs12 -export \
    -in cert.pem -inkey key.pem \
    -out release-keystore.p12 \
    -name "${ALIAS}" \
    -passout pass:"${STORE_PASS}" \
    -legacy

  rm -f key.pem cert.pem
  echo "✓ Keystore generated with openssl -legacy."
fi

base64 -w0 release-keystore.p12 > keystore_base64.txt

cat > credentials.txt <<EOF
ANDROID_KEY_ALIAS=${ALIAS}
ANDROID_KEYSTORE_PASSWORD=${STORE_PASS}
ANDROID_KEY_PASSWORD=${KEY_PASS}
EOF

echo ""
echo "✓ Files written to ${OUT_DIR}/"
echo "  release-keystore.p12  ← back this up privately, do NOT commit"
echo "  keystore_base64.txt   ← paste into ANDROID_KEYSTORE_BASE64 secret"
echo "  credentials.txt       ← paste alias/passwords into GitHub secrets"
echo ""
echo "Update all four GitHub secrets, then re-run the Android APK workflow."
