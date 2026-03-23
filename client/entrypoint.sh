#!/bin/sh
set -e

# Apply network impairment to simulate cross-cluster/internet conditions.
# This forces TCP send buffer backpressure during large TLS responses,
# which is the key trigger for the bug.

DELAY="${NETEM_DELAY_MS:-15}"
LOSS="${NETEM_LOSS_PCT:-0.5}"
RATE="${NETEM_RATE_KBIT:-100000}"

echo "=== Applying network impairment ==="
echo "  Delay: ${DELAY}ms (±${DELAY}ms jitter)"
echo "  Loss:  ${LOSS}%"
echo "  Rate:  ${RATE} kbit/s"

# Add latency, jitter, packet loss, and bandwidth limit
# This simulates a cross-cluster connection over the internet
tc qdisc add dev eth0 root netem \
  delay ${DELAY}ms ${DELAY}ms distribution normal \
  loss ${LOSS}% \
  rate ${RATE}kbit

echo "  Applied successfully."
echo ""

# Also reduce TCP buffer sizes to force more partial writes
# (simulates what happens when send buffer fills up with 16MB response)
sysctl -w net.ipv4.tcp_wmem="4096 16384 65536" 2>/dev/null || true
sysctl -w net.ipv4.tcp_rmem="4096 16384 65536" 2>/dev/null || true

exec node --max-old-space-size=4096 index.js
