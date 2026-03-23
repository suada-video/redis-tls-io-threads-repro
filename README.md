# Redis 8 TLS + io-threads Connection Reset Reproducer

Minimal reproducer for TLS record corruption in Redis 8.x when `io-threads > 1` and clients receive large responses (multi-MB).

## Bug Summary

Redis 8.2.1 with `io-threads 6` and TLS enabled corrupts TLS records when writing large responses (~1MB+). This causes:

- SSL errors in Redis logs: `bad length`, `unexpected eof while reading`, `lib(0)::reason(0)`
- Redis sends TCP RST to the affected client
- Client sees `ECONNRESET`
- Redis does **not** crash — it silently corrupts TLS records and drops the connection

The issue does **not** occur with:
- `io-threads 1` (disabled) + TLS
- `io-threads 6` + plaintext (no TLS)
- TLS + small responses (< ~100KB)

## Root Cause Hypothesis

The Redis 8 "Async IO Threads" redesign ([PR #13695](https://github.com/redis/redis/pull/13695)) moved TLS operations to IO threads. When Redis writes a large response (e.g., 16MB = ~1000 TLS records of 16KB each), there appears to be a race condition between the IO thread performing the `SSL_write` and the main thread appending to the client's output buffer, corrupting TLS record headers mid-write.

## Related Issues

- [#12540](https://github.com/redis/redis/issues/12540) — Double `freeClient()` with `io-threads-do-reads` + TLS (fixed by PR #13695)
- [#11119](https://github.com/redis/redis/issues/11119) — Threaded IO improvements (handle TLS) — the redesign tracker
- [#14249](https://github.com/redis/redis/issues/14249) — Crash with io-threads under high concurrency (Redis 7.2.10)

## Prerequisites

- Docker and Docker Compose
- ~2GB free RAM

## Quick Start

```bash
# Generate TLS certificates
./generate-certs.sh

# Start Redis with io-threads 6 + TLS (the buggy config)
docker compose up -d

# Run the reproducer
docker compose run --rm client

# Check Redis logs for SSL errors
docker compose logs redis | grep -iE "ssl|tls|error"
```

## What the Reproducer Does

1. Starts Redis 8.2.1 with `io-threads 6` and TLS enabled
2. A Node.js client (using ioredis, matching our production stack):
   - Stores large values in Redis (1MB each)
   - Opens multiple connections with `enableAutoPipelining: true`
   - Pipelines hundreds of `GET` commands to force large responses
   - Counts `ECONNRESET` errors vs successful reads
3. After the test, prints results and checks Redis logs for SSL errors

## Controlled Comparison

To confirm the bug, run with `io-threads 1`:

```bash
# Edit docker-compose.yml or use the override:
docker compose -f docker-compose.yml -f docker-compose.io-threads-1.yml up -d

# Run the same client — should see ZERO resets
docker compose run --rm client
```

## Expected Results

| Config | ECONNRESET count | SSL errors in Redis log |
|--------|-----------------|------------------------|
| `io-threads 6` + TLS | > 0 | `bad length`, `unexpected eof` |
| `io-threads 1` + TLS | 0 | None |
| `io-threads 6` + plaintext | 0 | N/A |

## Environment

- **Redis:** 8.2.1 (`bitnamilegacy/redis:8.2.1` or `redis:8.2.1`)
- **Client:** Node.js 20 + ioredis 5.7.0
- **TLS:** 1.3, AES-256-GCM-SHA384
- **OpenSSL:** 3.0.x

## Production Context

Discovered in production with:
- 3,400+ connected clients across 3 Kubernetes clusters
- 300,000+ jobs in BullMQ queues
- `client_recent_max_output_buffer: 16,444,208 bytes` (16.4 MB)
- Scheduler pods fetching unbounded job lists via `getJobs()` → 300K `HGETALL` calls auto-pipelined into single responses
- Cross-cluster connections via NodePort (TLS required) see resets; in-cluster plaintext connections do not
- Setting `io-threads 1` eliminated resets even for TLS connections
