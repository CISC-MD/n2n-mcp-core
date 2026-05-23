import Redis from 'ioredis';

export class BillingService {
  private redis: Redis;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    
    this.redis.defineCommand('atomicDeduct', {
      numberOfKeys: 1,
      lua: `
        local node_id = redis.call('GET', 'auth:' .. KEYS[1])
        if not node_id then
          return {"ERR_UNAUTH"}
        end
        local balance = tonumber(redis.call('GET', 'balance:' .. node_id) or "0")
        local cost = tonumber(ARGV[1])
        if balance < cost then
          return {"ERR_FUNDS", tostring(balance)}
        end
        local new_balance = redis.call('INCRBYFLOAT', 'balance:' .. node_id, -cost)
        return {"OK", tostring(new_balance), node_id}
      `
    });
  }

  async deductTokens(token: string, cost: number): Promise<{ success: boolean; error?: string; balance?: number; nodeId?: string }> {
    try {
      // @ts-ignore
      const result = await this.redis.atomicDeduct(token, cost.toString());
      if (result[0] === 'ERR_UNAUTH') return { success: false, error: 'Unauthorized' };
      if (result[0] === 'ERR_FUNDS') return { success: false, error: 'Insufficient funds', balance: parseFloat(result[1]) };
      if (result[0] === 'OK') return { success: true, balance: parseFloat(result[1]), nodeId: result[2] };
      return { success: false, error: 'Unknown error' };
    } catch (e) {
      return { success: false, error: 'Redis error' };
    }
  }
}
