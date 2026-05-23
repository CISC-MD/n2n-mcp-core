import { test } from 'node:test';
import assert from 'node:assert';
import { SsePool } from '../services/sse-pool';
import { HttpClient } from '../services/http-client';
import Redis from 'ioredis';

test('Clustered SsePool & KeepAlive HttpClient', async (t) => {
  await t.test('SsePool registers, duplicates, and initializes Redis Streams group', async () => {
    let createdGroupStream: any = null;
    let createdGroupName: any = null;
    let addedStreamName: any = null;
    let addedPayload: any = null;

    const createMockRedisClient = () => {
      const mockClient = {
        xgroup: async (action: string, stream: string, group: string, id: string, option?: string) => {
          if (action === 'CREATE') {
            createdGroupStream = stream;
            createdGroupName = group;
          }
          return 'OK';
        },
        xadd: async (stream: string, maxLenKey: string, approx: string, limit: string, star: string, key: string, val: string) => {
          addedStreamName = stream;
          if (key === 'payload') {
            addedPayload = val;
          }
          return '12345-0';
        },
        xack: async () => {
          return 1;
        },
        xreadgroup: async () => {
          // Keep loop waiting or return null to simulate no active messages in blocking cycle
          await new Promise((resolve) => setTimeout(resolve, 50));
          return null;
        },
        quit: async () => {},
        duplicate: () => {
          return mockClient;
        }
      };
      return mockClient;
    };

    const unifiedMockRedis = createMockRedisClient();
    const pool = new SsePool(unifiedMockRedis as unknown as Redis);

    // Wait a brief moment for async initStreamAndGroup to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(createdGroupStream, 'n2n:a2a:stream');
    assert.ok(createdGroupName?.startsWith('g:n2n:'));

    // Emit to a non-local node to trigger Redis Streams XADD
    const success = await pool.emitToNode('remote-agent-uuid', { hello: 'world' });

    assert.strictEqual(success, true);
    assert.strictEqual(addedStreamName, 'n2n:a2a:stream');
    assert.deepStrictEqual(JSON.parse(addedPayload || '{}'), {
      targetNode: 'remote-agent-uuid',
      eventData: { hello: 'world' }
    });

    // Clean up
    await pool.destroy();
  });

  await t.test('SsePool forwards incoming Redis Stream messages to local connection', async () => {
    let mockReadgroupCallback: Function | null = null;
    let messageWritten: string | null = null;

    const mockClient = {
      xgroup: async () => 'OK',
      xadd: async () => '12345-0',
      xack: async () => 1,
      xreadgroup: async () => {
        // Return a mock message once, then block
        if (mockReadgroupCallback) {
          const res = mockReadgroupCallback();
          mockReadgroupCallback = null;
          return res;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        return null;
      },
      quit: async () => {},
      duplicate: () => {
        return mockClient;
      }
    };

    const pool = new SsePool(mockClient as unknown as Redis);

    // Mock local connection
    const mockReply = {
      raw: {
        write: (data: string) => {
          messageWritten = data;
          return true;
        }
      }
    } as any;

    pool.register('local-connection-id', mockReply, 'local-node-uuid');

    // Simulate incoming stream message by setting up the mock read response
    mockReadgroupCallback = () => {
      return [
        [
          'n2n:a2a:stream',
          [
            [
              '12345-0',
              ['payload', JSON.stringify({
                targetNode: 'local-node-uuid',
                eventData: { foo: 'bar' }
              })]
            ]
          ]
        ]
      ];
    };

    // Wait a brief tick for the loop to run and process the mock callback
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(messageWritten, `data: ${JSON.stringify({ foo: 'bar' })}\n\n`);

    // Clean up
    await pool.destroy();
  });

  await t.test('HttpClient has Keep-Alive agent pool configured', async () => {
    const client = new HttpClient();
    const dispatcher = (client as any).dispatcher;
    
    assert.ok(dispatcher);
    
    // Extract undici.Agent options via the Symbol key to avoid internal changes breaking direct properties
    const optionSymbol = Object.getOwnPropertySymbols(dispatcher).find(
      (s) => s.toString() === 'Symbol(options)'
    );
    
    assert.ok(optionSymbol);
    const options = dispatcher[optionSymbol];
    
    assert.strictEqual(options.keepAliveTimeout, 60000);
    assert.strictEqual(options.connections, 100);
  });
});
