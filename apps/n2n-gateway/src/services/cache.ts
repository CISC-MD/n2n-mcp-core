import Redis from 'ioredis';
import { createHash } from 'crypto';

export class CacheService {
  constructor(private redis: Redis) {}

  /**
   * Normalizes the query to improve cache hit rate (lowercase, remove punctuation, trim).
   */
  private normalize(query: string): string {
    return query.toLowerCase().replace(/[^\w\s\u0400-\u04FF]/gi, '').replace(/\s+/g, ' ').trim();
  }

  private getHash(normalizedQuery: string): string {
    return createHash('sha256').update(normalizedQuery).digest('hex');
  }

  /**
   * Tries to find a cached semantic result.
   */
  public async getCachedResult(query: string, actionId: string): Promise<any | null> {
    const normalized = this.normalize(query);
    const hash = this.getHash(normalized);
    const key = `semantic_cache:${actionId}:${hash}`;

    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Caches a successful result. TTL is 24 hours by default.
   */
  public async setCachedResult(query: string, actionId: string, result: any, ttlSeconds: number = 86400): Promise<void> {
    const normalized = this.normalize(query);
    const hash = this.getHash(normalized);
    const key = `semantic_cache:${actionId}:${hash}`;

    await this.redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
  }
}
