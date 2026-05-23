import Redis from 'ioredis';
import { Pool } from 'pg';
import { createHash } from 'crypto';

const RATES = {
    PROMPT_1K: 0.005,
    COMPLETION_1K: 0.015,
    COMPUTE_SEC: 0.0001 
};

export class BillingService {
  private readonly PEPPER: string;
  private readonly STREAM_CRITICAL_THRESHOLD: number = 900000;

  constructor(private redis: Redis, private pg: Pool) {
    this.PEPPER = process.env.TOKEN_PEPPER || 'default_pepper_change_in_production';
    if (this.PEPPER === 'default_pepper_change_in_production') {
      console.warn('[SECURITY WARNING] TOKEN_PEPPER is set to default or is missing! Change TOKEN_PEPPER in production to prevent token compromise.');
    }
    
    // Шаг 1: Заморозка (Hold) базовой стоимости с распределенным локальным локом
    this.redis.defineCommand('preAuth', {
      numberOfKeys: 1,
      lua: `
        local lockKey = 'lock:balance:' .. KEYS[1]
        local balanceKey = 'balance:' .. KEYS[1]
        local holdKey = 'hold:' .. KEYS[1]
        local holdAmount = tonumber(ARGV[1])
        local lockTimeout = 2000

        -- Пытаемся захватить атомарный лок
        local acquired = redis.call('SET', lockKey, '1', 'NX', 'PX', lockTimeout)
        if not acquired then
          return -1 -- Конкурентный запрос обрабатывается
        end

        local raw_balance = redis.call('GET', balanceKey)
        local balance = tonumber(raw_balance or '0')
        
        if balance >= holdAmount then
            redis.call('INCRBYFLOAT', balanceKey, -holdAmount)
            redis.call('INCRBYFLOAT', holdKey, holdAmount)
            redis.call('DEL', lockKey)
            return 1 -- Успешно залочено
        else
            redis.call('DEL', lockKey)
            return 0 -- Недостаточно средств
        end
      `
    });

    // Шаг 2: Фактическое списание и возврат остатка (или досписание)
    this.redis.defineCommand('capture', {
      numberOfKeys: 1,
      lua: `
        local holdKey = 'hold:' .. KEYS[1]
        local balanceKey = 'balance:' .. KEYS[1]
        local holdAmount = tonumber(ARGV[1])
        local refundAmount = tonumber(ARGV[2])

        -- Снимаем из hold
        redis.call('INCRBYFLOAT', holdKey, -holdAmount)

        -- Возвращаем на баланс (или досписываем)
        if refundAmount > 0 then
            redis.call('INCRBYFLOAT', balanceKey, refundAmount)
        elseif refundAmount < 0 then
            redis.call('INCRBYFLOAT', balanceKey, refundAmount)
        end
        return 1
      `
    });
  }

  async getMasterNodeId(token: string): Promise<string | null> {
    const tokenHash = createHash('sha256').update(token + this.PEPPER).digest('hex');
    const cacheKey = `auth:${tokenHash}`;
    
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const { rows } = await this.pg.query('SELECT id FROM nodes WHERE token_hash = $1', [tokenHash]);
    if (rows.length === 0) return null;

    const nodeId = rows[0].id;
    await this.redis.set(cacheKey, nodeId, 'EX', 3600);
    return nodeId;
  }

  /**
   * Замораживает средства перед выполнением запроса.
   * Если ключа balance:nodeId нет в Redis, загружаем из PG.
   * Поддерживает конкурентный экспоненциальный бэкофф.
   */
  async preAuth(clientId: string, estimatedCostUsd: number = 0.05): Promise<boolean> {
    const balanceKey = `balance:${clientId}`;
    
    // Проверяем наличие ключа в Redis. Если нет, грузим из PG.
    const exists = await this.redis.exists(balanceKey);
    if (!exists) {
      const { rows } = await this.pg.query('SELECT balance_usd FROM client_balances WHERE client_id = $1', [clientId]);
      if (rows.length > 0) {
        await this.redis.set(balanceKey, rows[0].balance_usd.toString());
      } else {
        return false; // Клиент не найден
      }
    }

    let retries = 5;
    while (retries > 0) {
      // @ts-ignore
      const result = await this.redis.preAuth(clientId, estimatedCostUsd);
      if (result === 1) {
        return true;
      } else if (result === -1) {
        retries--;
        await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 5));
      } else {
        return false; // Недостаточно средств
      }
    }

    return false; // Не удалось захватить лок за 5 попыток
  }

  /**
   * Списание фактической стоимости, возврат замороженного остатка 
   * и отправка в очередь транзакций.
   */
  async capture(data: {
      clientId: string;
      agentId: string;
      contextId?: string;
      tokensPrompt: number;
      tokensCompletion: number;
      computeMs: number;
      holdUsd: number;
  }): Promise<void> {
      // Расчет реальной стоимости
      const promptCost = (data.tokensPrompt / 1000) * RATES.PROMPT_1K;
      const compCost = (data.tokensCompletion / 1000) * RATES.COMPLETION_1K;
      const computeCost = (data.computeMs / 1000) * RATES.COMPUTE_SEC;
      const totalCostUsd = promptCost + compCost + computeCost;

      const refund = data.holdUsd - totalCostUsd;

      // Выполнение Lua-скрипта
      // @ts-ignore
      await this.redis.capture(data.clientId, data.holdUsd, refund);

      // Логгируем потребление в очередь (для асинхронного сброса в PG)
      await this.redis.xadd('stream:ledger', 'MAXLEN', '~', 100000, '*', 
          'client_id', data.clientId,
          'agent_id', data.agentId,
          'context_id', data.contextId || 'none',
          'cost_usd', totalCostUsd.toString(),
          'tokens_prompt', data.tokensPrompt.toString(),
          'tokens_completion', data.tokensCompletion.toString(),
          'compute_ms', data.computeMs.toString()
      );
  }

  async startLedgerConsumer(): Promise<void> {
    let lastId = '0-0';
    
    const poll = async () => {
      try {
        const streams = await this.redis.xread('COUNT', 100, 'BLOCK', 2000, 'STREAMS', 'stream:ledger', lastId);
        if (!streams) {
          setTimeout(poll, 100);
          return;
        }

        const [_, entries] = streams[0];
        if (entries.length === 0) {
          setTimeout(poll, 100);
          return;
        }

        const client = await this.pg.connect();
        try {
          await client.query('BEGIN');
          for (const [id, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              obj[fields[i]] = fields[i + 1];
            }

            const { client_id, agent_id, context_id, cost_usd, tokens_prompt, tokens_completion, compute_ms } = obj;
            const contextUuid = (context_id && context_id !== 'none') ? context_id : null;

            // 1. Запись в usage_ledger
            await client.query(
              `INSERT INTO usage_ledger 
               (client_id, agent_id, context_id, tokens_prompt, tokens_completion, compute_ms, cost_usd) 
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [client_id, agent_id, contextUuid, Number(tokens_prompt), Number(tokens_completion), Number(compute_ms), Number(cost_usd)]
            );

            // 2. Списание с баланса в PostgreSQL
            await client.query(
              `UPDATE client_balances 
               SET balance_usd = balance_usd - $1, updated_at = CURRENT_TIMESTAMP 
               WHERE client_id = $2`,
              [Number(cost_usd), client_id]
            );

            lastId = id;
          }
          await client.query('COMMIT');
        } catch (dbErr) {
          await client.query('ROLLBACK');
          throw dbErr;
        } finally {
          client.release();
        }

        if (lastId !== '0-0') {
          // Удаляем обработанные записи из Redis, чтобы не занимать RAM
          const idsToDelete = entries.map(e => e[0]);
          await this.redis.xdel('stream:ledger', ...idsToDelete);
        }
      } catch (err) {
        console.error('Failed to process ledger stream batch:', err);
      }
      setTimeout(poll, 1000);
    };

    setTimeout(poll, 1000);
  }

  public async validateM2MTransaction(headers: any): Promise<string | null> {
    const authHeader = headers.authorization || headers['x-credit-token'];
    if (!authHeader) return null;

    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const nodeId = await this.getMasterNodeId(token);
    if (!nodeId) return null;

    // Zero-Knowledge balance commitment proof verification
    const commitment = headers['x-balance-commitment'];
    const proof = headers['x-balance-proof'];
    if (commitment && proof) {
      try {
        const { verifyProofAsync } = require('../security/crypto-pool');
        const isProofValid = await verifyProofAsync(JSON.parse(commitment), JSON.parse(proof), 32);
        if (!isProofValid) return null;
      } catch (err) {
        console.error('[Billing] ZK proof validation exception:', err);
        return null;
      }
    }

    // Hold credits (estimated standard PAYG cost)
    const hasFunds = await this.preAuth(nodeId, 0.05);
    return hasFunds ? nodeId : null;
  }
}