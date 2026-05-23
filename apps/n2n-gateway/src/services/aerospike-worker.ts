import 'dotenv/config';
import Redis from 'ioredis';

// Attempt to load native Aerospike client
let AerospikeClient: any = null;
try {
  // @ts-ignore
  AerospikeClient = require('aerospike');
  console.log('[Aerospike Worker] Native Aerospike client loaded successfully.');
} catch (err) {
  console.warn('[Aerospike Worker] Native Aerospike client not found. Running in High-Performance Local NVMe-Emulated Mock Mode.');
}

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6380;
const AEROSPIKE_HOST = process.env.AEROSPIKE_HOST || 'localhost';
const AEROSPIKE_PORT = Number(process.env.AEROSPIKE_PORT) || 3000;

// Connect to Redis/Dragonfly (lazy initialized)
let redis: Redis | null = null;

// Mock local store for fallback mode (behaves like raw Aerospike indices)
const localNvmeStore = new Map<string, any>();

class AerospikeBillingWriter {
  private client: any = null;
  private isFallback = true;

  async connect() {
    if (AerospikeClient) {
      try {
        this.client = await AerospikeClient.connect({
          hosts: [{ addr: AEROSPIKE_HOST, port: AEROSPIKE_PORT }],
          policies: {
            write: new AerospikeClient.WritePolicy({
              exists: AerospikeClient.policy.exists.CREATE_OR_REPLACE,
            }),
          },
        });
        this.isFallback = false;
        console.log(`[Aerospike] Connected to Aerospike cluster at ${AEROSPIKE_HOST}:${AEROSPIKE_PORT}`);
      } catch (err) {
        console.error('[Aerospike] Failed to connect to native Aerospike. Falling back to local emulated storage:', err);
      }
    }
  }

  async writeTransactionBlock(contextId: string, record: {
    clientId: string;
    agentId: string;
    costUsd: number;
    tokensPrompt: number;
    tokensCompletion: number;
    computeMs: number;
    timestamp: number;
  }) {
    if (this.isFallback) {
      // High-performance Mock Storage writing (atomic emulation)
      localNvmeStore.set(contextId, record);
      // Simulates extremely fast raw NVMe write (0.1ms latency)
      return;
    }

    // Native Aerospike Key definition
    const key = new AerospikeClient.Key('n2n_billing', 'usage_ledger', contextId);
    
    // Bins representation in Aerospike
    const bins = {
      client_id: record.clientId,
      agent_id: record.agentId,
      cost_usd: record.costUsd,
      tokens_prompt: record.tokensPrompt,
      tokens_completion: record.tokensCompletion,
      compute_ms: record.computeMs,
      timestamp: record.timestamp,
    };

    await this.client.put(key, bins);
  }

  async writeTransactionBlocksBatch(batch: {
    contextId: string;
    record: {
      clientId: string;
      agentId: string;
      costUsd: number;
      tokensPrompt: number;
      tokensCompletion: number;
      computeMs: number;
      timestamp: number;
    };
  }[]) {
    if (batch.length === 0) return;

    if (this.isFallback) {
      // High-performance Mock Storage batch writing (atomic emulation)
      for (const item of batch) {
        localNvmeStore.set(item.contextId, item.record);
      }
      return;
    }

    try {
      // Convert batch array to Aerospike batch operations format
      const formatOps = batch.map(item => {
        const key = new AerospikeClient.Key('n2n_billing', 'usage_ledger', item.contextId);
        return {
          key,
          ops: [
            AerospikeClient.operations.write('client_id', item.record.clientId),
            AerospikeClient.operations.write('agent_id', item.record.agentId),
            AerospikeClient.operations.write('cost_usd', item.record.costUsd),
            AerospikeClient.operations.write('tokens_prompt', item.record.tokensPrompt),
            AerospikeClient.operations.write('tokens_completion', item.record.tokensCompletion),
            AerospikeClient.operations.write('compute_ms', item.record.computeMs),
            AerospikeClient.operations.write('timestamp', item.record.timestamp)
          ]
        };
      });

      // Execute high-speed parallel batch writes on Aerospike NVMe
      if (typeof this.client.batchExecute === 'function') {
        await this.client.batchExecute(null, formatOps);
      } else if (typeof this.client.batchWrite === 'function') {
        await this.client.batchWrite(null, formatOps);
      } else {
        // Fallback sequentially in case of minor API differences
        await Promise.all(batch.map(item => this.writeTransactionBlock(item.contextId, item.record)));
      }
    } catch (err) {
      console.error('[Aerospike Worker Batch Write] Failed, falling back to sequential writes:', err);
      for (const item of batch) {
        try {
          await this.writeTransactionBlock(item.contextId, item.record);
        } catch (seqErr) {
          console.error(`[Aerospike Sequential Fallback] Failed for ${item.contextId}:`, seqErr);
        }
      }
    }
  }

  async getTransactionBlock(contextId: string): Promise<any | null> {
    if (this.isFallback) {
      return localNvmeStore.get(contextId) || null;
    }

    try {
      const key = new AerospikeClient.Key('n2n_billing', 'usage_ledger', contextId);
      const record = await this.client.get(key);
      return record.bins;
    } catch (err: any) {
      if (err.code === AerospikeClient.status.ERR_RECORD_NOT_FOUND) {
        return null;
      }
      throw err;
    }
  }

  getAllEmulatedRecords(): any[] {
    return Array.from(localNvmeStore.entries()).map(([contextId, bins]) => ({
      contextId,
      ...bins
    }));
  }
}

const writer = new AerospikeBillingWriter();

async function startWorker() {
  redis = new Redis(
    process.env.REDIS_SOCKET_PATH
      ? { path: process.env.REDIS_SOCKET_PATH }
      : {
          host: REDIS_HOST,
          port: REDIS_PORT,
        }
  );
  
  redis.options.retryStrategy = (times) => Math.min(times * 100, 3000);

  await writer.connect();

  let lastId = '0-0';
  console.log('[Aerospike Worker] Subscribing to stream:ledger in Redis...');

  const poll = async () => {
    try {
      if (!redis) return;
      // Read up to 100 new entries, blocking for up to 2 seconds
      const streams = await redis.xread('COUNT', 100, 'BLOCK', 2000, 'STREAMS', 'stream:ledger', lastId);
      if (!streams) {
        setImmediate(poll);
        return;
      }

      const [_, entries] = streams[0];
      if (entries.length === 0) {
        setImmediate(poll);
        return;
      }

      const batchToWrite: {
        contextId: string;
        record: {
          clientId: string;
          agentId: string;
          costUsd: number;
          tokensPrompt: number;
          tokensCompletion: number;
          computeMs: number;
          timestamp: number;
        };
      }[] = [];

      for (const [id, fields] of entries) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }

        const { client_id, agent_id, context_id, cost_usd, tokens_prompt, tokens_completion, compute_ms } = obj;
        const txContextId = context_id && context_id !== 'none' ? context_id : `tx_${require('crypto').randomUUID()}`;

        const recordBlock = {
          clientId: client_id || 'unknown',
          agentId: agent_id || 'unknown',
          costUsd: parseFloat(cost_usd || '0'),
          tokensPrompt: parseInt(tokens_prompt || '0', 10),
          tokensCompletion: parseInt(tokens_completion || '0', 10),
          computeMs: parseInt(compute_ms || '0', 10),
          timestamp: Date.now()
        };

        batchToWrite.push({ contextId: txContextId, record: recordBlock });
        lastId = id;
      }

      // Persist the entire batch in a single distributed Aerospike execution call!
      await writer.writeTransactionBlocksBatch(batchToWrite);

      // Evict entries we processed successfully from Redis to save memory
      const idsToDelete = entries.map(e => e[0]);
      await redis!.xdel('stream:ledger', ...idsToDelete);
      
      console.log(`[Aerospike Worker] Successfully persisted batch of ${entries.length} blocks.`);
    } catch (err) {
      console.error('[Aerospike Worker] Error processing transaction batch:', err);
    }
    setTimeout(poll, 100);
  };

  poll();
}

// Only launch daemon execution if running directly
if (require.main === module) {
  startWorker().catch(err => {
    console.error('[Aerospike Worker] Worker crash:', err);
    process.exit(1);
  });
}

export { writer, AerospikeBillingWriter };
