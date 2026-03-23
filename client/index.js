/**
 * Redis 8 TLS + io-threads bug reproducer.
 *
 * Creates multiple TLS connections to Redis with auto-pipelining enabled,
 * stores large values, and then hammers GET requests to force Redis to
 * write multi-MB responses through its IO threads. With io-threads > 1,
 * this triggers TLS record corruption → SSL errors → connection resets.
 *
 * Environment variables:
 *   REDIS_HOST              - Redis hostname (default: redis)
 *   REDIS_PORT              - Redis port (default: 6379)
 *   TLS_CA                  - Path to CA cert
 *   TLS_CERT                - Path to client cert
 *   TLS_KEY                 - Path to client key
 *   NUM_CONNECTIONS          - Number of parallel connections (default: 50)
 *   VALUE_SIZE_BYTES         - Size of each test value in bytes (default: 1MB)
 *   NUM_KEYS                - Number of large keys to create (default: 20)
 *   PIPELINE_BATCH           - Number of GETs to pipeline per batch (default: 200)
 *   TEST_DURATION_SECONDS    - How long to run the test (default: 120)
 *   ENABLE_AUTO_PIPELINING   - Enable ioredis auto-pipelining (default: true)
 */

const Redis = require("ioredis");
const fs = require("fs");
const crypto = require("crypto");

// Config from environment
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const TLS_CA = process.env.TLS_CA || "/tls/ca.crt";
const TLS_CERT = process.env.TLS_CERT || "/tls/client.crt";
const TLS_KEY = process.env.TLS_KEY || "/tls/client.key";
const NUM_CONNECTIONS = parseInt(process.env.NUM_CONNECTIONS || "50", 10);
const VALUE_SIZE_BYTES = parseInt(process.env.VALUE_SIZE_BYTES || "1048576", 10);
const NUM_KEYS = parseInt(process.env.NUM_KEYS || "20", 10);
const PIPELINE_BATCH = parseInt(process.env.PIPELINE_BATCH || "200", 10);
const TEST_DURATION_SECONDS = parseInt(process.env.TEST_DURATION_SECONDS || "120", 10);
const ENABLE_AUTO_PIPELINING = process.env.ENABLE_AUTO_PIPELINING !== "false";

// Counters
let totalReads = 0;
let totalErrors = 0;
let econnresetCount = 0;
let otherErrors = {};
let reconnections = 0;

function createConnection(id) {
  const conn = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: {
      ca: fs.readFileSync(TLS_CA),
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      servername: REDIS_HOST,
    },
    enableAutoPipelining: ENABLE_AUTO_PIPELINING,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      reconnections++;
      return Math.min(times * 100, 3000);
    },
    keepAlive: 15000,
    connectTimeout: 10000,
    commandTimeout: 30000,
    lazyConnect: true,
  });

  conn.on("error", (err) => {
    totalErrors++;
    if (err.code === "ECONNRESET" || err.message?.includes("ECONNRESET")) {
      econnresetCount++;
    } else {
      const key = err.code || err.message?.substring(0, 60) || "unknown";
      otherErrors[key] = (otherErrors[key] || 0) + 1;
    }
  });

  conn.on("reconnecting", () => {
    reconnections++;
  });

  return conn;
}

async function seedData(conn) {
  console.log(`Seeding ${NUM_KEYS} keys of ${(VALUE_SIZE_BYTES / 1024 / 1024).toFixed(1)}MB each...`);
  for (let i = 0; i < NUM_KEYS; i++) {
    const value = crypto.randomBytes(VALUE_SIZE_BYTES).toString("base64");
    await conn.set(`bigkey:${i}`, value);
  }

  // Also create a large list (simulates BullMQ queue with many job IDs)
  console.log("Seeding large list with 10,000 entries...");
  const pipeline = conn.pipeline();
  for (let i = 0; i < 10000; i++) {
    pipeline.rpush("biglist", crypto.randomBytes(64).toString("hex"));
  }
  await pipeline.exec();

  // And large hashes (simulates BullMQ job data)
  console.log("Seeding 5,000 hashes (simulating job objects)...");
  const pipeline2 = conn.pipeline();
  for (let i = 0; i < 5000; i++) {
    pipeline2.hset(`job:${i}`, {
      id: `job-${i}`,
      data: JSON.stringify({
        videoId: crypto.randomUUID(),
        campaignId: crypto.randomUUID(),
        organisationId: crypto.randomUUID(),
        status: "waiting-children",
        createdAt: Date.now(),
        payload: crypto.randomBytes(200).toString("base64"),
      }),
      name: "video-complete",
      timestamp: Date.now().toString(),
      delay: "0",
      priority: Math.floor(Math.random() * 100).toString(),
    });
  }
  await pipeline2.exec();

  console.log("Data seeded.\n");
}

async function hammerReads(conn, id, stopSignal) {
  const keys = Array.from({ length: NUM_KEYS }, (_, i) => `bigkey:${i}`);

  while (!stopSignal.stopped) {
    try {
      // Strategy 1: Pipeline many GETs for large values
      // This forces Redis to write NUM_KEYS * VALUE_SIZE_BYTES through TLS
      const promises = [];
      for (let batch = 0; batch < PIPELINE_BATCH; batch++) {
        const key = keys[batch % keys.length];
        promises.push(
          conn.get(key).then(() => {
            totalReads++;
          })
        );
      }

      // Strategy 2: LRANGE the entire large list
      promises.push(
        conn.lrange("biglist", 0, -1).then(() => {
          totalReads++;
        })
      );

      // Strategy 3: Pipeline HGETALL across many hashes
      // (simulates BullMQ's getJobs() which does HGETALL per job)
      for (let i = 0; i < 500; i++) {
        promises.push(
          conn.hgetall(`job:${i}`).then(() => {
            totalReads++;
          })
        );
      }

      await Promise.allSettled(promises);
    } catch (err) {
      // Errors are already counted by the error handler
    }

    // Small delay to avoid tight loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

function printStats() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(
    `[${elapsed}s] reads=${totalReads} | ECONNRESET=${econnresetCount} | reconnects=${reconnections} | other_errors=${totalErrors - econnresetCount}`
  );
}

let startTime;

async function main() {
  console.log("=== Redis TLS + io-threads Bug Reproducer ===\n");
  console.log("Config:");
  console.log(`  Redis:              ${REDIS_HOST}:${REDIS_PORT} (TLS)`);
  console.log(`  Connections:        ${NUM_CONNECTIONS}`);
  console.log(`  Value size:         ${(VALUE_SIZE_BYTES / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  Keys:               ${NUM_KEYS}`);
  console.log(`  Pipeline batch:     ${PIPELINE_BATCH}`);
  console.log(`  Auto-pipelining:    ${ENABLE_AUTO_PIPELINING}`);
  console.log(`  Duration:           ${TEST_DURATION_SECONDS}s`);
  console.log();

  // Create connections
  const connections = [];
  for (let i = 0; i < NUM_CONNECTIONS; i++) {
    connections.push(createConnection(i));
  }

  // Connect all
  console.log(`Connecting ${NUM_CONNECTIONS} clients...`);
  await Promise.all(connections.map((c) => c.connect()));
  console.log("All connected.\n");

  // Seed data using first connection
  await seedData(connections[0]);

  // Get Redis info for the report
  const info = await connections[0].info("server");
  const versionMatch = info.match(/redis_version:(\S+)/);
  const opensslMatch = info.match(/openssl:(\S+)/);
  const ioThreadsConfig = await connections[0].config("GET", "io-threads");
  console.log(`Redis version:    ${versionMatch?.[1] || "unknown"}`);
  console.log(`OpenSSL:          ${opensslMatch?.[1] || "unknown"}`);
  console.log(`io-threads:       ${ioThreadsConfig?.[1] || "unknown"}`);
  console.log();

  // Start hammering
  startTime = Date.now();
  const stopSignal = { stopped: false };

  console.log(`Starting ${NUM_CONNECTIONS} parallel read workers for ${TEST_DURATION_SECONDS}s...\n`);

  // Print stats every 5 seconds
  const statsInterval = setInterval(printStats, 5000);

  // Launch all workers
  const workers = connections.map((conn, i) => hammerReads(conn, i, stopSignal));

  // Wait for duration
  await new Promise((r) => setTimeout(r, TEST_DURATION_SECONDS * 1000));
  stopSignal.stopped = true;

  // Wait for workers to finish current batch
  await Promise.allSettled(workers);
  clearInterval(statsInterval);

  // Final stats
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
    console.log("   This indicates TLS record corruption by Redis io-threads.");
    console.log("   Check Redis logs: docker compose logs redis | grep -iE 'ssl|error|bad length'");
  } else {
    console.log("✅ No ECONNRESET errors detected.");
    console.log("   If running with io-threads 1, this is expected (bug not triggered).");
  }

  // Cleanup
  await Promise.allSettled(connections.map((c) => c.quit()));
  process.exit(econnresetCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
