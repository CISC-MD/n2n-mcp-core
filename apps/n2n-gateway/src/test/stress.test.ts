import Redis from 'ioredis';
import { Pool } from 'pg';
import { BillingService } from '../services/billing';

async function runStressTest() {
  console.log('=== STARTING HIGH-THROUGHPUT LUA STRESS-TEST ===');
  
  // Connect to the remote production Redis Billing instance on the VPS
  const redisHost = '127.0.0.1';
  const redisPort = 6380;
  
  console.log(`Connecting to Dragonfly/Redis at ${redisHost}:${redisPort}...`);
  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1
  });

  // Minimal Postgres mock as we are testing Lua/Redis raw speeds
  const mockPg = {
    query: async () => ({ rows: [] })
  } as unknown as Pool;

  try {
    await redis.ping();
    console.log('✓ Successfully connected to remote Redis.');
  } catch (err) {
    console.error('Failed to connect to remote Redis. Ensure port 6380 is open and accessible.', err);
    process.exit(1);
  }

  const billing = new BillingService(redis, mockPg);

  const mockClientId = 'stress-node-test-uuid';
  const balanceKey = `balance:${mockClientId}`;
  const holdKey = `hold:${mockClientId}`;
  
  // Reset and pre-populate mock client balance in Redis
  await redis.set(balanceKey, '10000.0');
  await redis.del(holdKey);
  
  const TOTAL_OPERATIONS = 10000;
  const CONCURRENCY_LIMIT = 200; // Batch parallel requests to simulate concurrent active clients
  
  console.log(`Running stress test: ${TOTAL_OPERATIONS} operations with parallel concurrency limit of ${CONCURRENCY_LIMIT}...`);
  
  const latencies: number[] = [];
  const startTime = Date.now();
  
  let completed = 0;
  
  async function runBatch() {
    const promises: Promise<void>[] = [];
    
    for (let i = 0; i < CONCURRENCY_LIMIT && completed < TOTAL_OPERATIONS; i++) {
      promises.push((async () => {
        const opStart = performance.now();
        
        // 1. PreAuth (Hold) operation
        const hasFunds = await billing.preAuth(mockClientId, 0.05);
        if (!hasFunds) {
          throw new Error('PreAuth failed during stress test');
        }
        
        // 2. Capture operation
        await billing.capture({
          clientId: mockClientId,
          agentId: 'agent-stress-uuid',
          contextId: 'context-stress-uuid',
          tokensPrompt: 1500,
          tokensCompletion: 800,
          computeMs: 2500,
          holdUsd: 0.05
        });
        
        const opEnd = performance.now();
        latencies.push(opEnd - opStart);
        completed++;
      })());
    }
    
    await Promise.all(promises);
  }

  while (completed < TOTAL_OPERATIONS) {
    await runBatch();
    if (completed % 2000 === 0) {
      console.log(`Progress: ${completed}/${TOTAL_OPERATIONS} operations completed...`);
    }
  }

  const totalTimeMs = Date.now() - startTime;
  const rps = (TOTAL_OPERATIONS * 2) / (totalTimeMs / 1000); // 1 operation = 1 PreAuth + 1 Capture (2 Lua transactions)
  
  // Sort latencies to compute percentiles
  latencies.sort((a, b) => a - b);
  
  const avgLatency = latencies.reduce((sum, val) => sum + val, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  
  console.log('\n=== BENCHMARK TELEMETRY RESULTS ===');
  console.table({
    'Total Operations (PreAuth + Capture)': TOTAL_OPERATIONS,
    'Total Redis Transactions': TOTAL_OPERATIONS * 2,
    'Total Execution Time (s)': (totalTimeMs / 1000).toFixed(2),
    'Dragonfly Transaction Rate (TPS)': rps.toFixed(2),
    'Avg Operation Latency (ms)': avgLatency.toFixed(2),
    'Median Latency (p50) (ms)': p50.toFixed(2),
    '95th Percentile Latency (p95) (ms)': p95.toFixed(2),
    '99th Percentile Latency (p99) (ms)': p99.toFixed(2),
  });

  // Cleanup Redis mock keys
  await redis.del(balanceKey);
  await redis.del(holdKey);
  await redis.disconnect();
  console.log('=== STRESS-TEST COMPLETED ===');
}

runStressTest().catch(console.error);
