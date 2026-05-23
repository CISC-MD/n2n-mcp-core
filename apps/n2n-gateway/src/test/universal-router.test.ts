import { test } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import universalRouter from '../routes/router';

test('Universal Router - POST /v1/execute', async (t) => {
  await t.test('rejects invalid JSON-RPC structure', async () => {
    const app = Fastify();
    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        // missing fields, invalid jsonrpc
        jsonrpc: '1.0',
        id: 1,
        method: 'tools/call',
        params: {
          targetNode: 'test-node-id',
          payload: {}
        }
      }
    });

    assert.strictEqual(response.statusCode, 400);
  });

  await t.test('returns 402 if M2M payment / credit clearance fails', async () => {
    const app = Fastify();
    
    app.decorate('billing', {
      validateM2MTransaction: async (headers: any) => {
        // Return null to simulate insufficient funds or failed ZK validation
        return null;
      }
    } as any);

    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'tools/call',
        params: {
          targetNode: 'target-node-id',
          payload: { query: 'test' }
        }
      }
    });

    assert.strictEqual(response.statusCode, 402);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Insufficient Funds / Invalid ZK-Proof' });
  });

  await t.test('routes successfully via A2A SSE pool when node is AGENT and online', async () => {
    const app = Fastify();
    let emittedMessage: any = null;

    app.decorate('billing', {
      validateM2MTransaction: async (headers: any) => 'sender-node-id'
    } as any);

    app.decorate('ecosystem', {
      getNodeMetadata: async (nodeId: string) => ({
        type: 'AGENT',
        endpoint: 'http://agent.local/api'
      })
    } as any);

    app.decorate('ssePool', {
      emitToNode: async (targetNode: string, message: any) => {
        emittedMessage = { targetNode, message };
        return true; // Successfully delivered
      }
    } as any);

    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          targetNode: 'agent-node-uuid',
          payload: { run: 'yes' }
        }
      }
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'DELIVERED_TO_AGENT' });
    assert.deepStrictEqual(emittedMessage, {
      targetNode: 'agent-node-uuid',
      message: {
        method: 'tools/call',
        id: 42,
        payload: { run: 'yes' }
      }
    });
  });

  await t.test('returns AGENT_OFFLINE when A2A node is offline in SSE pool', async () => {
    const app = Fastify();

    app.decorate('billing', {
      validateM2MTransaction: async (headers: any) => 'sender-node-id'
    } as any);

    app.decorate('ecosystem', {
      getNodeMetadata: async (nodeId: string) => ({
        type: 'AGENT',
        endpoint: 'http://agent.local/api'
      })
    } as any);

    app.decorate('ssePool', {
      emitToNode: async (targetNode: string, message: any) => {
        return false; // Target offline
      }
    } as any);

    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          targetNode: 'agent-offline-uuid',
          payload: { data: 'offline' }
        }
      }
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'AGENT_OFFLINE' });
  });

  await t.test('routes successfully via B2A HttpClient when target node is BUSINESS', async () => {
    const app = Fastify();
    let forwardedEndpoint: string | null = null;
    let forwardedPayload: any = null;

    app.decorate('billing', {
      validateM2MTransaction: async (headers: any) => 'sender-node-id'
    } as any);

    app.decorate('ecosystem', {
      getNodeMetadata: async (nodeId: string) => ({
        type: 'BUSINESS',
        endpoint: 'https://business.md/api'
      })
    } as any);

    app.decorate('httpClient', {
      forward: async (endpoint: string, payload: any) => {
        forwardedEndpoint = endpoint;
        forwardedPayload = payload;
        return { success: true, result: 'business_data' };
      }
    } as any);

    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: {
        jsonrpc: '2.0',
        id: 'biz-req-100',
        method: 'resources/read',
        params: {
          targetNode: 'business-node-id',
          payload: { fetch: 'metrics' }
        }
      }
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), {
      status: 'DELIVERED_TO_BUSINESS',
      data: { success: true, result: 'business_data' }
    });
    assert.strictEqual(forwardedEndpoint, 'https://business.md/api');
    assert.deepStrictEqual(forwardedPayload, { fetch: 'metrics' });
  });

  await t.test('POST /v1/register registers a node manifest successfully in Redis', async () => {
    const app = Fastify();
    let savedKey: string | null = null;
    let savedValue: string | null = null;
    let publishedChannel: string | null = null;
    let publishedMsg: string | null = null;

    app.decorate('billing', {
      getMasterNodeId: async (token: string) => {
        if (token === 'my-valid-token') {
          return 'test-node-uuid';
        }
        return null;
      }
    } as any);

    app.decorate('redis', {
      set: async (key: string, val: string) => {
        savedKey = key;
        savedValue = val;
      },
      publish: async (channel: string, msg: string) => {
        publishedChannel = channel;
        publishedMsg = msg;
      }
    } as any);

    await app.register(universalRouter);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/register',
      headers: {
        authorization: 'Bearer my-valid-token'
      },
      payload: {
        uuid: 'test-node-uuid',
        type: 'AGENT',
        endpoint: 'http://my-agent.local',
        tools: [
          {
            name: 'test_tool',
            description: 'My test tool',
            parameters: { type: 'object', properties: {} }
          }
        ]
      }
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'REGISTERED', uuid: 'test-node-uuid' });
    assert.strictEqual(savedKey, 'node:metadata:test-node-uuid');
    const parsed = JSON.parse(savedValue || '{}');
    assert.strictEqual(parsed.type, 'AGENT');
    assert.strictEqual(parsed.endpoint, 'http://my-agent.local');
    assert.strictEqual(publishedChannel, 'ecosystem:reload');
    assert.strictEqual(publishedMsg, 'reload');
  });
});
