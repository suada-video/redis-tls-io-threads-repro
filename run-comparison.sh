#!/usr/bin/env bash
set -euo pipefail

# Runs the reproducer with both io-threads=6 and io-threads=1 and compares results.

echo "============================================"
echo "Redis TLS + io-threads A/B Comparison Test"
echo "============================================"
echo ""

# Generate certs if needed
if [ ! -f certs/ca.crt ]; then
  echo "Generating TLS certificates..."
  ./generate-certs.sh
  echo ""
fi

# Test 1: io-threads 6 (buggy)
echo "=== TEST 1: io-threads 6 + TLS (expect ECONNRESET) ==="
echo ""
docker compose down -v 2>/dev/null || true
docker compose up -d redis
echo "Waiting for Redis to be healthy..."
sleep 5
docker compose run --rm client 2>&1 | tee /tmp/repro-io6.log
echo ""
echo "Redis SSL errors (io-threads 6):"
docker compose logs redis 2>&1 | grep -ciE "ssl error|bad length|unexpected eof" || echo "  (none)"
docker compose down -v

echo ""
echo "=== TEST 2: io-threads 1 + TLS (expect NO ECONNRESET) ==="
echo ""
docker compose -f docker-compose.yml -f docker-compose.io-threads-1.yml up -d redis
echo "Waiting for Redis to be healthy..."
sleep 5
docker compose -f docker-compose.yml -f docker-compose.io-threads-1.yml run --rm client 2>&1 | tee /tmp/repro-io1.log
echo ""
echo "Redis SSL errors (io-threads 1):"
docker compose -f docker-compose.yml -f docker-compose.io-threads-1.yml logs redis 2>&1 | grep -ciE "ssl error|bad length|unexpected eof" || echo "  (none)"
docker compose -f docker-compose.yml -f docker-compose.io-threads-1.yml down -v

echo ""
echo "============================================"
echo "COMPARISON SUMMARY"
echo "============================================"
echo ""
echo "io-threads 6:"
grep -E "ECONNRESET count:|RESULTS" /tmp/repro-io6.log | tail -5
echo ""
echo "io-threads 1:"
grep -E "ECONNRESET count:|RESULTS" /tmp/repro-io1.log | tail -5
