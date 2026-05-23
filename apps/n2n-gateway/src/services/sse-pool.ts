import { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

export class SsePool {
  private connections = new Map<string, FastifyReply>();
  private nodeToConnection = new Map<string, string>();
  private redis: Redis;
  private streamRedis: Redis;
  private instanceId: string;
  private streamName = 'n2n:a2a:stream';
  private groupName: string;
  private isRunning = false;

  constructor(redis: Redis) {
    this.redis = redis;
    // Clone redis client for dedicated blocking stream reads to avoid blocking main application traffic
    this.streamRedis = redis.duplicate();
    // Support static node mapping NODE_INSTANCE_ID for Docker/VPS deployments to prevent PEL leaks
    const staticId = process.env.NODE_INSTANCE_ID || process.env.HOSTNAME;
    const isProd = process.env.NODE_ENV === 'production';
    if (!staticId && isProd) {
      throw new Error('[SsePool] Critical error: NODE_INSTANCE_ID or HOSTNAME must be explicitly defined in production to prevent PEL consumer group memory leaks.');
    }
    this.instanceId = staticId || `gateway-dev-${randomUUID().substring(0, 8)}`;
    // Unique consumer group per cluster instance for Fan-out distribution
    this.groupName = `g:n2n:${this.instanceId}`;

    // Clean up dead/orphaned consumer groups from previous ungraceful restarts before initializing
    this.reapDeadConsumerGroups()
      .then(() => this.initStreamAndGroup())
      .then(() => {
        this.startConsumerLoop();
      })
      .catch((err) => {
        console.error('[SsePool] Stream consumer initialization failed:', err);
      });
  }

  /**
   * Scans existing stream consumer groups and destroys orphaned ones (consumers = 0)
   * to prevent memory leaks (PEL accumulations) in high-throughput production environments.
   */
  private async reapDeadConsumerGroups(): Promise<void> {
    try {
      const info = await this.redis.xinfo('GROUPS', this.streamName) as any;
      if (Array.isArray(info)) {
        for (const group of info) {
          const groupName = group.name || '';
          const consumers = Number(group.consumers);

          // Orphaned dynamic cluster groups have 0 consumers. Reap them.
          if (consumers === 0 && groupName.startsWith('g:n2n:') && groupName !== this.groupName) {
            await this.redis.xgroup('DESTROY', this.streamName, groupName);
            console.log(`[SsePool] [GC] Reaped orphaned consumer group: ${groupName}`);
          }
        }
      }
    } catch (err) {
      // If the stream does not exist yet, xinfo throws an error. This is safe to ignore.
    }
  }

  private async initStreamAndGroup(): Promise<void> {
    try {
      // Create consumer group and stream if they do not exist ($ starts reading new messages)
      await this.redis.xgroup('CREATE', this.streamName, this.groupName, '$', 'MKSTREAM');
      console.log(`[SsePool] 📡 Created Redis Stream Consumer Group: ${this.groupName}`);
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        throw err;
      }
      console.log(`[SsePool] 📡 Re-using existing Redis Stream Consumer Group: ${this.groupName}`);
    }
  }

  /**
   * Get an active connection by connection ID or Node ID.
   */
  public get(id: string): FastifyReply | undefined {
    return this.connections.get(id);
  }

  /**
   * Register a new active connection in the pool, optionally linking a Node ID.
   */
  public register(connectionId: string, reply: FastifyReply, nodeId?: string): void {
    this.connections.set(connectionId, reply);
    if (nodeId) {
      this.nodeToConnection.set(nodeId, connectionId);
      this.connections.set(nodeId, reply);
    }
    console.log(`[SsePool] Connection registered: ${connectionId} (Node: ${nodeId || 'none'})`);
  }

  /**
   * Deregister connection by connection ID.
   */
  public deregister(connectionId: string): void {
    this.connections.delete(connectionId);
    
    // Remove reverse Node ID references
    for (const [nodeId, connId] of this.nodeToConnection.entries()) {
      if (connId === connectionId) {
        this.nodeToConnection.delete(nodeId);
        this.connections.delete(nodeId);
        console.log(`[SsePool] Node reference cleaned: ${nodeId}`);
      }
    }
    console.log(`[SsePool] Connection removed: ${connectionId}`);
  }

  /**
   * Emits a payload to a specific registered Node ID or connection ID.
   * If the node is not connected to this local instance, it broadcasts the frame
   * to all active gateway cluster nodes via Redis Streams.
   */
  public async emitToNode(targetNode: string, message: any): Promise<boolean> {
    // 1. Fast local routing if hosted on this instance
    const reply = this.connections.get(targetNode);
    if (reply) {
      try {
        reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
        return true;
      } catch (err) {
        console.error(`[SsePool] Failed to emit message to local target ${targetNode}:`, err);
        return false;
      }
    }

    // 2. Multi-instance cluster delivery via Redis Streams with MAXLEN capping
    try {
      const payload = JSON.stringify({ targetNode, eventData: message });
      await this.redis.xadd(this.streamName, 'MAXLEN', '~', '1000', '*', 'payload', payload);
      console.log(`[SsePool] Dispatched global stream frame for ${targetNode}`);
      return true;
    } catch (err) {
      console.error(`[SsePool] Redis stream dispatch failed for ${targetNode}:`, err);
      return false;
    }
  }

  private async startConsumerLoop(): Promise<void> {
    this.isRunning = true;
    console.log(`[SsePool] Stream consumer loop started on instance: ${this.instanceId}`);
    
    while (this.isRunning) {
      try {
        // Read new messages from the stream for our group (blocking for up to 2 seconds)
        const response = await this.streamRedis.xreadgroup(
          'GROUP', this.groupName, this.instanceId,
          'COUNT', '10', 'BLOCK', '2000',
          'STREAMS', this.streamName, '>'
        ) as any;

        if (!response || !this.isRunning) {
          continue;
        }

        for (const [_stream, messages] of response) {
          for (const [id, fields] of messages) {
            // Redis Stream stores fields as key-value pairs in a flat array, e.g. ['payload', 'JSONString']
            let rawPayload = '';
            for (let i = 0; i < fields.length; i += 2) {
              if (fields[i] === 'payload') {
                rawPayload = fields[i + 1];
                break;
              }
            }

            if (!rawPayload) {
              continue;
            }

            try {
              const { targetNode, eventData } = JSON.parse(rawPayload);
              const localReply = this.connections.get(targetNode);

              if (localReply) {
                // Deliver message to local client and acknowledge message in group
                localReply.raw.write(`data: ${JSON.stringify(eventData)}\n\n`);
                await this.redis.xack(this.streamName, this.groupName, id);
                console.log(`[SsePool] [Streams] Delivered stream frame to local node: ${targetNode}`);
              }
            } catch (jsonErr) {
              console.error('[SsePool] [Streams] Failed parsing stream message:', jsonErr);
            }
          }
        }
      } catch (err: any) {
        // Log network glitches without breaking loop
        console.error('[SsePool] [Streams] Consumer Loop Error:', err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Checks if a target node is currently online.
   */
  public isNodeOnline(nodeId: string): boolean {
    return this.connections.has(nodeId);
  }

  /**
   * Closes connections and destroys the consumer group.
   */
  public async destroy(): Promise<void> {
    this.isRunning = false;
    try {
      await this.redis.xgroup('DESTROY', this.streamName, this.groupName);
      console.log(`[SsePool] Destroyed Stream Consumer Group: ${this.groupName}`);
    } catch (err) {
      // Ignore cleanup error
    }
    try {
      await this.streamRedis.quit();
    } catch (err) {
      // Ignore
    }
  }
}
