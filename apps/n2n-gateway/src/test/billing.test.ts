import { test } from 'node:test';
import assert from 'node:assert';
import { BillingService } from '../services/billing';
import Redis from 'ioredis';
import { Pool } from 'pg';

// Create minimal mocks for Redis and PostgreSQL Pool
const mockRedis = {
  defineCommand: () => {},
  get: async (key: string) => null,
  set: async (key: string, value: string, mode?: string, duration?: number) => 'OK',
  exists: async (key: string) => 1,
  xadd: async (...args: any[]) => '1-0',
  preAuth: async () => 1,
  capture: async () => 1,
} as unknown as Redis;

const mockPg = {
  query: async (sql: string, params?: any[]) => {
    if (sql.includes('nodes')) {
      return { rows: [{ id: 'test-node-uuid' }] };
    }
    if (sql.includes('client_balances')) {
      return { rows: [{ balance_usd: 100.0 }] };
    }
    return { rows: [] };
  }
} as unknown as Pool;

test('BillingService - getMasterNodeId', async (t) => {
  const service = new BillingService(mockRedis, mockPg);

  await t.test('returns mapped node UUID and caches it', async () => {
    const nodeId = await service.getMasterNodeId('test-token-value');
    assert.strictEqual(nodeId, 'test-node-uuid');
  });
});

test('BillingService - preAuth', async (t) => {
  const service = new BillingService(mockRedis, mockPg);

  await t.test('grants pre-auth when balance is sufficient', async () => {
    const result = await service.preAuth('test-node-uuid', 0.05);
    assert.strictEqual(result, true);
  });
});

test('BillingService - capture & pricing math', async (t) => {
  const service = new BillingService(mockRedis, mockPg);

  await t.test('executes capture without errors', async () => {
    await assert.doesNotReject(async () => {
      await service.capture({
        clientId: 'client-uuid',
        agentId: 'agent-uuid',
        contextId: 'context-uuid',
        tokensPrompt: 2000,      // 2000 * 0.005 / 1000 = 0.010
        tokensCompletion: 1000,  // 1000 * 0.015 / 1000 = 0.015
        computeMs: 5000,         // 5000 * 0.0001 / 1000 = 0.0005
        holdUsd: 0.05            // total cost: 0.0255 USD, refund: 0.0245 USD
      });
    });
  });
});

import Fastify from 'fastify';
import billingRoutes from '../routes/billing';

test('Billing Routes API - POST /v1/billing/preauth', async (t) => {
  const app = Fastify();
  
  // Decorate mock billing service
  app.decorate('billing', {
    getMasterNodeId: async (token: string) => {
      if (token === 'valid-token') return 'node-uuid';
      return null;
    },
    preAuth: async (clientId: string, estimatedCost: number) => {
      if (clientId === 'node-uuid' && estimatedCost === 0.05) return true;
      if (clientId === 'node-uuid' && estimatedCost === 999) return false;
      return false;
    }
  } as any);

  await app.register(billingRoutes);

  await t.test('rejects request without Bearer auth header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/preauth',
      payload: { estimated_cost_usd: 0.05 }
    });
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Strict B2A Auth required' });
  });

  await t.test('rejects request with unverified token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/preauth',
      headers: { authorization: 'Bearer invalid-token' },
      payload: { estimated_cost_usd: 0.05 }
    });
    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Node unverified' });
  });

  await t.test('returns 402 if preauth fails (insufficient funds)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/preauth',
      headers: { authorization: 'Bearer valid-token' },
      payload: { estimated_cost_usd: 999 }
    });
    assert.strictEqual(response.statusCode, 402);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Insufficient funds (PAYG balance too low)' });
  });

  await t.test('successfully executes preauth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/preauth',
      headers: { authorization: 'Bearer valid-token' },
      payload: { estimated_cost_usd: 0.05 }
    });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), {
      status: 'success',
      client_id: 'node-uuid',
      hold_usd: 0.05
    });
  });
});

test('Billing Routes API - POST /v1/billing/capture', async (t) => {
  const app = Fastify();
  let capturedData: any = null;

  app.decorate('billing', {
    getMasterNodeId: async (token: string) => {
      if (token === 'valid-token') return 'node-uuid';
      return null;
    },
    capture: async (data: any) => {
      capturedData = data;
    }
  } as any);

  await app.register(billingRoutes);

  await t.test('successfully captures transaction usage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/billing/capture',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        agent_id: 'test-agent',
        context_id: 'context-uuid',
        tokens_prompt: 1000,
        tokens_completion: 500,
        compute_ms: 1200,
        hold_usd: 0.05
      }
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), {
      status: 'success',
      message: 'Captured successfully'
    });
    assert.deepStrictEqual(capturedData, {
      clientId: 'node-uuid',
      agentId: 'test-agent',
      contextId: 'context-uuid',
      tokensPrompt: 1000,
      tokensCompletion: 500,
      computeMs: 1200,
      holdUsd: 0.05
    });
  });
});
