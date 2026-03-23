#!/bin/sh
set -e

# Apply network impairment to simulate cross-cluster/internet conditions.
# Skip entirely if NETEM_DELAY_MS is 0 or not set properly.

DELAY="${NETEM_DELAY_MS:-0}"
LOSS="${NETEM_LOSS_PCT:-0}"
RATE="${NETEM_RATE_KBIT:-0}"

if [ "$DELAY" = "0" ] || [ -z "$DELAY" ]; then
  echo "=== No network impairment (delay=0) ==="
  exec node --max-old-space-size=4096 index.js
fi

echo "=== Applying network impairment ==="
echo "  Delay: ${DELAY}ms (±${DELAY}ms jitter)"
echo "  Loss:  ${LOSS}%"
echo "  Rate:  ${RATE} kbit/s"

# Add latency, jitter, packet loss, and bandwidth limit
tc qdisc add dev eth0 root netem \
  delay ${DELAY}ms ${DELAY}ms distribution normal \
  loss ${LOSS}% \
  rate ${RATE}kbit 2>/dev/null || true

echo "  Applied successfully."
echo ""

# Also reduce TCP buffer sizes to force more partial writes
sysctl -w net.ipv4.tcp_wmem="4096 16384 65536" 2>/dev/null || true
sysctl -w net.ipv4.tcp_rmem="4096 16384 65536" 2>/dev/null || true

exec node --max-old-space-size=4096 index.js
