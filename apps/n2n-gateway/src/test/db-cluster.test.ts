import { test } from 'node:test';
import assert from 'node:assert';
import { AerospikeBillingWriter } from '../services/aerospike-worker';
import { PostgresArchiverService, AerospikeTxBlock } from '../services/postgres-archiver';
import { Pool } from 'pg';

test('Database Clustering - Aerospike NVMe Worker Persistence', async (t) => {
  const writer = new AerospikeBillingWriter();
  await writer.connect(); // Connects in fallback/emulated mode since native isn't installed

  await t.test('Atomically writes and retrieves transaction blocks successfully', async () => {
    const contextId = '12e45678-e89b-12d3-a456-426614174000';
    const txBlock = {
      clientId: 'client-node-1',
      agentId: 'agent-search-1',
      costUsd: 0.0255,
      tokensPrompt: 1200,
      tokensCompletion: 800,
      computeMs: 3400,
      timestamp: Date.now(),
    };

    await writer.writeTransactionBlock(contextId, txBlock);
    const retrieved = await writer.getTransactionBlock(contextId);

    assert.notStrictEqual(retrieved, null);
    assert.strictEqual(retrieved.clientId, txBlock.clientId);
    assert.strictEqual(retrieved.agentId, txBlock.agentId);
    assert.strictEqual(retrieved.costUsd, txBlock.costUsd);
    assert.strictEqual(retrieved.tokensPrompt, txBlock.tokensPrompt);
    assert.strictEqual(retrieved.tokensCompletion, txBlock.tokensCompletion);
    assert.strictEqual(retrieved.computeMs, txBlock.computeMs);
  });

  await t.test('Returns null if block record is not found', async () => {
    const retrieved = await writer.getTransactionBlock('missing-context-uuid');
    assert.strictEqual(retrieved, null);
  });
});

test('Database Clustering - Partitioned Postgres Bulk Archiver', async (t) => {
  let executedQuery = '';
  let queryParams: any[] = [];

  const mockPgPool = {
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return;
        executedQuery = sql;
        queryParams = params || [];
      },
      release: () => {}
    })
  } as unknown as Pool;

  const archiver = new PostgresArchiverService(mockPgPool);

  await t.test('Constructs valid batch insert SQL and variables array', async () => {
    const blocks: AerospikeTxBlock[] = [
      {
        contextId: '33e45678-e89b-12d3-a456-426614174011',
        clientId: 'client-a',
        agentId: 'agent-x',
        costUsd: 0.05,
        tokensPrompt: 1000,
        tokensCompletion: 2000,
        computeMs: 1500,
        timestamp: new Date('2026-05-22T10:00:00Z').getTime()
      },
      {
        contextId: '44e45678-e89b-12d3-a456-426614174022',
        clientId: 'client-b',
        agentId: 'agent-y',
        costUsd: 0.10,
        tokensPrompt: 3000,
        tokensCompletion: 4000,
        computeMs: 2500,
        timestamp: new Date('2026-05-22T12:00:00Z').getTime()
      }
    ];

    const resultCount = await archiver.archiveBlocks(blocks);

    assert.strictEqual(resultCount, 2);
    assert.match(executedQuery, /INSERT INTO partitioned_usage_ledger/);
    assert.match(executedQuery, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\), \(\$11, \$12, \$13, \$14, \$15, \$16, \$17, \$18, \$19, \$20\)/);
    assert.strictEqual(queryParams.length, 20);
    assert.strictEqual(queryParams[1], 'client-a');
    assert.strictEqual(queryParams[8], '2026-05-22');
    assert.strictEqual(queryParams[11], 'client-b');
  });

  await t.test('Returns 0 quickly when archipayload_idg empty array', async () => {
    executedQuery = '';
    const resultCount = await archiver.archiveBlocks([]);
    assert.strictEqual(resultCount, 0);
    assert.strictEqual(executedQuery, '');
  });
});
