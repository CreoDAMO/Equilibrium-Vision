#!/usr/bin/env bash
# validate-setup.sh — confirm all three services are up and the chain is mining.
# Exit 0 = all checks passed. Exit 1 = one or more checks failed.
set -euo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    echo "  ✓ $label"
    ((PASS++)) || true
  else
    echo "  ✗ $label"
    ((FAIL++)) || true
  fi
}

echo ""
echo "=== Equilibrium setup validation ==="
echo ""

echo "── Services ──────────────────────────────────────"
check "Postgres listening on 5432" nc -z 127.0.0.1 5432
check "API Server listening on 8080" nc -z 127.0.0.1 8080
check "Explorer listening on 5000"  nc -z 127.0.0.1 5000

echo ""
echo "── API health ────────────────────────────────────"
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/api/blocks 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
  echo "  ✓ GET /api/blocks → 200"
  ((PASS++)) || true
else
  echo "  ✗ GET /api/blocks → $STATUS (expected 200)"
  ((FAIL++)) || true
fi

HEIGHT=$(curl -sf http://127.0.0.1:8080/api/blocks 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "0")
if [ "$HEIGHT" -ge 1 ] 2>/dev/null; then
  echo "  ✓ Chain has blocks (count=$HEIGHT)"
  ((PASS++)) || true
else
  echo "  ✗ Chain has no blocks yet"
  ((FAIL++)) || true
fi

echo ""
echo "── Explorer ──────────────────────────────────────"
EX_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:5000/ 2>/dev/null || echo "000")
if [ "$EX_STATUS" = "200" ]; then
  echo "  ✓ Explorer root → 200"
  ((PASS++)) || true
else
  echo "  ✗ Explorer root → $EX_STATUS (expected 200)"
  ((FAIL++)) || true
fi

echo ""
echo "── Result ────────────────────────────────────────"
echo "  Passed: $PASS   Failed: $FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed. Project is ready."
  exit 0
else
  echo "Some checks failed. Make sure workflows are running in order: Postgres → API Server → Explorer."
  exit 1
fi
