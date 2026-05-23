import 'dotenv/config';
import Redis from 'ioredis';
import { createHash } from 'crypto';

async function runApiStressTest() {
  console.log('=== STARTING HIGH-CONCURRENCY API STRESS-TEST ===');

  const TARGET_URL = 'http://127.0.0.1:4020/v1/b2a/dispatch';
  const redisHost = '127.0.0.1';
  const redisPort = 6380;
  
  console.log(`Setting up mock auth credentials in Dragonfly/Redis at ${redisHost}:${redisPort}...`);
  const redis = new Redis({
    host: redisHost,
    port: redisPort
  });

  const mockToken = 'stress-test-jwt-token-value';
  const pepper = process.env.TOKEN_PEPPER || 'default_pepper_change_in_production'; // matching gateway default
  const tokenHash = createHash('sha256').update(mockToken + pepper).digest('hex');
  
  // Register node mapping and balance in remote Redis to satisfy Auth/PreAuth checks
  const mockNodeId = 'stress-node-test-uuid';
  await redis.set(`auth:${tokenHash}`, mockNodeId);
  await redis.set(`balance:${mockNodeId}`, '50000.0');

  console.log('Mock credentials active. Verify local server is listening on port 4020...');
  
  // Quick health check to ensure server is listening
  try {
    const res = await fetch('http://127.0.0.1:4020/v1/b2a/status/nonexistent', { method: 'GET' });
    if (res.status === 404) {
      console.log('✓ Fastify Gateway server is active on port 4020.');
    }
  } catch (e) {
    console.error('ERROR: Local Fastify Gateway server is not running on port 4020. Start it using: PORT=4020 REDIS_HOST=127.0.0.1 REDIS_PORT=6380 npx ts-node apps/n2n-gateway/src/server.ts');
    await redis.del(`auth:${tokenHash}`);
    await redis.del(`balance:${mockNodeId}`);
    await redis.disconnect();
    process.exit(1);
  }

  const TOTAL_REQUESTS = 3000;
  const CONCURRENCY_LIMIT = 50;
  
  console.log(`Firing ${TOTAL_REQUESTS} parallel requests with concurrency limit of ${CONCURRENCY_LIMIT}...`);
  
  const latencies: number[] = [];
  const startTime = Date.now();
  let completed = 0;
  let successes = 0;
  let failures = 0;

  async function runBatch() {
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < CONCURRENCY_LIMIT && completed < TOTAL_REQUESTS; i++) {
      promises.push((async () => {
        const opStart = performance.now();
        try {
          const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${mockToken}`
            },
            body: JSON.stringify({
              target_node_id: 'edge_node_generic_core',
              action_id: 'query_semantic_payload',
              payload: {
                payload_id: 'BMW7E38ACT1VE1234',
                target_currency: 'EUR'
              }
            })
          });

          const opEnd = performance.now();
          latencies.push(opEnd - opStart);

          if (response.status === 202) {
            successes++;
          } else {
            failures++;
          }
        } catch (e) {
          failures++;
        }
        completed++;
      })());
    }
    
    await Promise.all(promises);
  }

  while (completed < TOTAL_REQUESTS) {
    await runBatch();
    if (completed % 500 === 0) {
      console.log(`Progress: ${completed}/${TOTAL_REQUESTS} API requests executed...`);
    }
  }

  const totalTimeMs = Date.now() - startTime;
  const rps = TOTAL_REQUESTS / (totalTimeMs / 1000);
  
  latencies.sort((a, b) => a - b);
  
  const avgLatency = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  console.log('\n=== API GATEWAY BENCHMARK TELEMETRY RESULTS ===');
  console.table({
    'Total HTTP Requests Fired': TOTAL_REQUESTS,
    'HTTP Successful (202 Accepted)': successes,
    'HTTP Failed': failures,
    'Total Execution Time (s)': (totalTimeMs / 1000).toFixed(2),
    'End-to-End Gateway Rate (RPS)': rps.toFixed(2),
    'Avg API Latency (ms)': avgLatency.toFixed(2),
    'Median Latency (p50) (ms)': p50.toFixed(2),
    '95th Percentile Latency (p95) (ms)': p95.toFixed(2),
    '99th Percentile Latency (p99) (ms)': p99.toFixed(2),
  });

  // Cleanup Redis mock credentials
  await redis.del(`auth:${tokenHash}`);
  await redis.del(`balance:${mockNodeId}`);
  await redis.disconnect();
  console.log('=== API STRESS-TEST COMPLETED ===');
}

runApiStressTest().catch(console.error);
