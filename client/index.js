/**
 * Redis 8 TLS + large response bug reproducer.
 *
 * Simulates the exact BullMQ getJobs() pattern that triggers the bug:
 * 1. EVALSHA (getRanges Lua script) returns N job IDs via ZRANGE/LRANGE
 * 2. N × HGETALL pipelined (auto-pipelining batches them into one pipeline)
 * 3. Redis writes ~N × 865 bytes through TLS → multi-MB response
 * 4. With network latency/backpressure, SSL_write does partial writes → corruption
 *
 * Environment variables:
 *   REDIS_HOST, REDIS_PORT, TLS_CA, TLS_CERT, TLS_KEY
 *   NUM_CONNECTIONS          - Parallel connections (default: 30)
 *   NUM_JOBS                 - Number of fake BullMQ jobs to create (default: 50000)
 *   HGETALL_BATCH            - How many HGETALLs to pipeline per round (default: 10000)
 *   TEST_DURATION_SECONDS    - Duration (default: 120)
 *   ENABLE_AUTO_PIPELINING   - Match production (default: true)
 */

const Redis = require("ioredis");
const fs = require("fs");
const crypto = require("crypto");

const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const TLS_CA = process.env.TLS_CA;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const NUM_CONNECTIONS = parseInt(process.env.NUM_CONNECTIONS || "30", 10);
const NUM_JOBS = parseInt(process.env.NUM_JOBS || "50000", 10);
const HGETALL_BATCH = parseInt(process.env.HGETALL_BATCH || "10000", 10);
const TEST_DURATION_SECONDS = parseInt(process.env.TEST_DURATION_SECONDS || "120", 10);
const ENABLE_AUTO_PIPELINING = process.env.ENABLE_AUTO_PIPELINING !== "false";

let totalReads = 0;
let totalErrors = 0;
let econnresetCount = 0;
let otherErrors = {};
let reconnections = 0;
let startTime;

function getTlsOpts() {
  if (!TLS_CA) return undefined;
  return {
    ca: fs.readFileSync(TLS_CA),
    cert: TLS_CERT ? fs.readFileSync(TLS_CERT) : undefined,
    key: TLS_KEY ? fs.readFileSync(TLS_KEY) : undefined,
    servername: REDIS_HOST,
  };
}

function createConnection(id) {
  const tlsOpts = getTlsOpts();
  const conn = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: tlsOpts,
    enableAutoPipelining: ENABLE_AUTO_PIPELINING,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      reconnections++;
      return Math.min(times * 100, 3000);
    },
    keepAlive: 15000,
    connectTimeout: 10000,
    commandTimeout: 60000,
    lazyConnect: true,
  });

  conn.on("error", (err) => {
    totalErrors++;
    const msg = err.message || "";
    if (err.code === "ECONNRESET" || msg.includes("ECONNRESET")) {
      econnresetCount++;
    } else {
      const key = err.code || msg.substring(0, 60) || "unknown";
      otherErrors[key] = (otherErrors[key] || 0) + 1;
    }
  });

  return conn;
}

async function seedJobs(conn) {
  console.log(`Seeding ${NUM_JOBS} fake BullMQ job hashes...`);
  const BATCH = 5000;
  for (let offset = 0; offset < NUM_JOBS; offset += BATCH) {
    const pipeline = conn.pipeline();
    const end = Math.min(offset + BATCH, NUM_JOBS);
    for (let i = offset; i < end; i++) {
      const jobId = `bull:scheduler-events:${i}`;
      // Realistic BullMQ job hash (~865 bytes, matching production)
      pipeline.hset(jobId, {
        processedOn: Date.now().toString(),
        data: JSON.stringify({
          videoId: crypto.randomUUID(),
          campaignId: crypto.randomUUID(),
          organisationId: crypto.randomUUID(),
          queue: "STANDARD",
          variables: {
            first_name: "Test",
            last_name: "User",
            company: "Acme Corp",
            email: `user${i}@example.com`,
            linkedin_url: `https://linkedin.com/in/user-${i}`,
          },
          status: "waiting-children",
        }),
        timestamp: Date.now().toString(),
        delay: "0",
        opts: JSON.stringify({
          de: { id: `${crypto.randomUUID()}-queue-video`, ttl: 300000 },
          backoff: { delay: 5000, type: "fixed" },
          attempts: 3,
        }),
        returnvalue: "null",
        atm: "1",
        ats: "1",
        priority: Math.floor(Math.random() * 100).toString(),
        finishedOn: Date.now().toString(),
        name: "video-complete",
        deid: `${crypto.randomUUID()}-queue-video`,
      });
      // Also add to the sorted set (simulates waiting-children state)
      pipeline.zadd("bull:scheduler-events:waiting-children", i.toString(), i.toString());
    }
    await pipeline.exec();
    process.stdout.write(`  ${end}/${NUM_JOBS}\r`);
  }
  console.log(`\nSeeded ${NUM_JOBS} jobs. Each ~865 bytes → total HGETALL response ~${((NUM_JOBS * 865) / 1024 / 1024).toFixed(0)}MB`);

  // Also seed some large individual values for LRANGE testing
  const pipeline = conn.pipeline();
  for (let i = 0; i < 10000; i++) {
    pipeline.rpush("bull:scheduler-events:biglist", crypto.randomBytes(64).toString("hex"));
  }
  await pipeline.exec();
  console.log("Seeded 10K list entries.\n");
}

async function simulateGetJobs(conn, stopSignal) {
  // This simulates exactly what BullMQ getJobs() does:
  // Step 1: ZRANGE to get job IDs (the getRanges Lua script result)
  // Step 2: HGETALL per job ID with auto-pipelining

  while (!stopSignal.stopped) {
    try {
      // Step 1: Get job IDs from sorted set (like getRanges Lua)
      // In production this is EVALSHA but the response is the same: array of IDs
      const jobIds = await conn.zrange(
        "bull:scheduler-events:waiting-children",
        0,
        HGETALL_BATCH - 1
      );
      totalReads++;

      if (jobIds.length === 0) continue;

      // Step 2: HGETALL per job — this is the killer.
      // With enableAutoPipelining, ioredis batches all these into ONE pipeline.
      // Redis responds with HGETALL_BATCH × ~865 bytes = multi-MB response.
      const promises = jobIds.map((id) =>
        conn.hgetall(`bull:scheduler-events:${id}`).then((data) => {
          totalReads++;
          data = null; // release immediately
        })
      );
      await Promise.allSettled(promises);

      // Also do an LRANGE (simulates other BullMQ operations)
      await conn.lrange("bull:scheduler-events:biglist", 0, -1).then((r) => {
        totalReads++;
        r = null;
      });
    } catch (err) {
      // errors counted by handler
    }

    // Brief pause between rounds
    await new Promise((r) => setTimeout(r, 50));
  }
}

function printStats() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(
    `[${elapsed}s] reads=${totalReads} | ECONNRESET=${econnresetCount} | reconnects=${reconnections} | other_errors=${totalErrors - econnresetCount}`
  );
}

async function main() {
  console.log("=== Redis TLS + BullMQ getJobs() Bug Reproducer ===\n");
  console.log("Config:");
  console.log(`  Redis:              ${REDIS_HOST}:${REDIS_PORT} (${TLS_CA ? "TLS" : "plaintext"})`);
  console.log(`  Connections:        ${NUM_CONNECTIONS}`);
  console.log(`  Fake jobs:          ${NUM_JOBS}`);
  console.log(`  HGETALL batch:      ${HGETALL_BATCH}`);
  console.log(`  Auto-pipelining:    ${ENABLE_AUTO_PIPELINING}`);
  console.log(`  Duration:           ${TEST_DURATION_SECONDS}s`);
  console.log(`  Expected response:  ~${((HGETALL_BATCH * 865) / 1024 / 1024).toFixed(1)}MB per round`);
  console.log();

  const connections = [];
  for (let i = 0; i < NUM_CONNECTIONS; i++) {
    connections.push(createConnection(i));
  }

  console.log(`Connecting ${NUM_CONNECTIONS} clients...`);
  await Promise.all(connections.map((c) => c.connect()));
  console.log("All connected.\n");

  await seedJobs(connections[0]);

  const info = await connections[0].info("server");
  const versionMatch = info.match(/redis_version:(\S+)/);
  const opensslMatch = info.match(/openssl:(\S+)/);
  const ioThreadsConfig = await connections[0].config("GET", "io-threads");
  console.log(`Redis version:    ${versionMatch?.[1] || "unknown"}`);
  console.log(`OpenSSL:          ${opensslMatch?.[1] || "unknown"}`);
  console.log(`io-threads:       ${ioThreadsConfig?.[1] || "unknown"}`);
  console.log();

  startTime = Date.now();
  const stopSignal = { stopped: false };

  console.log(`Starting ${NUM_CONNECTIONS} workers simulating getJobs() for ${TEST_DURATION_SECONDS}s...\n`);

  const statsInterval = setInterval(printStats, 5000);
  const workers = connections.map((conn, i) => simulateGetJobs(conn, stopSignal));

  await new Promise((r) => setTimeout(r, TEST_DURATION_SECONDS * 1000));
  stopSignal.stopped = true;
  await Promise.allSettled(workers);
  clearInterval(statsInterval);

  console.log("\n=== RESULTS ===");
  console.log(`Duration:           ${TEST_DURATION_SECONDS}s`);
  console.log(`Total reads:        ${totalReads}`);
  console.log(`ECONNRESET count:   ${econnresetCount}`);
  console.log(`Reconnections:      ${reconnections}`);
  console.log(`Total errors:       ${totalErrors}`);
  if (Object.keys(otherErrors).length > 0) {
    console.log("Other errors:");
    for (const [key, count] of Object.entries(otherErrors)) {
      console.log(`  ${key}: ${count}`);
    }
  }

  console.log();
  if (econnresetCount > 0) {
    console.log("❌ BUG REPRODUCED: ECONNRESET errors detected.");
    console.log("   Redis is corrupting TLS records during large response writes.");
    console.log("   Check Redis logs: docker compose logs redis | grep -iE 'ssl|error|bad length'");
  } else {
    console.log("✅ No ECONNRESET errors detected in this run.");
  }

  await Promise.allSettled(connections.map((c) => c.quit()));
  process.exit(econnresetCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
