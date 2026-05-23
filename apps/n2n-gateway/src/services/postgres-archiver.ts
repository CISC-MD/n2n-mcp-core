import { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface AerospikeTxBlock {
  contextId: string;
  clientId: string;
  agentId: string;
  costUsd: number;
  tokensPrompt: number;
  tokensCompletion: number;
  computeMs: number;
  timestamp: number;
  tenantUuid?: string;
}

export class PostgresArchiverService {
  constructor(private pgPool: Pool) {}

  /**
   * Performs high-speed parameterized bulk insertion of transaction blocks
   * into partitioned_usage_ledger.
   */
  async archiveBlocks(blocks: AerospikeTxBlock[]): Promise<number> {
    if (blocks.length === 0) return 0;

    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');

      // Construct a single, highly optimized parameterized batch INSERT query
      const fields = [
        'id', 'client_id', 'agent_id', 'context_id',
        'tokens_prompt', 'tokens_completion', 'compute_ms',
        'cost_usd', 'transaction_date', 'tenant_uuid'
      ];
      
      const valuesPlaceholders: string[] = [];
      const flatParams: any[] = [];
      
      let paramIndex = 1;
      
      for (const block of blocks) {
        // Ensure valid UUID format for id and contextId
        const id = randomUUID();
        
        let validContextUuid: string | null = null;
        if (block.contextId && block.contextId.length === 36) {
          validContextUuid = block.contextId;
        } else {
          validContextUuid = randomUUID(); // fallback if not a valid UUID format
        }

        // Format timestamp as YYYY-MM-DD
        const dateObj = new Date(block.timestamp);
        const transactionDate = dateObj.toISOString().split('T')[0];

        // Format or fallback tenant_uuid
        let tenantUuid = block.tenantUuid;
        if (!tenantUuid || tenantUuid.length !== 36) {
          // Deterministic UUID fallback based on client_id or random
          tenantUuid = 'd3b07384-d113-4956-b50e-aa612d6776be';
        }

        const placeholders = [
          `$${paramIndex++}`, // id
          `$${paramIndex++}`, // client_id
          `$${paramIndex++}`, // agent_id
          `$${paramIndex++}`, // context_id
          `$${paramIndex++}`, // tokens_prompt
          `$${paramIndex++}`, // tokens_completion
          `$${paramIndex++}`, // compute_ms
          `$${paramIndex++}`, // cost_usd
          `$${paramIndex++}`, // transaction_date
          `$${paramIndex++}`  // tenant_uuid
        ];

        valuesPlaceholders.push(`(${placeholders.join(', ')})`);
        
        flatParams.push(
          id,
          block.clientId,
          block.agentId,
          validContextUuid,
          block.tokensPrompt,
          block.tokensCompletion,
          block.computeMs,
          block.costUsd,
          transactionDate,
          tenantUuid
        );
      }

      const sql = `
        INSERT INTO partitioned_usage_ledger 
        (${fields.join(', ')}) 
        VALUES ${valuesPlaceholders.join(', ')}
        ON CONFLICT (id, transaction_date) DO NOTHING
      `;

      await client.query(sql, flatParams);
      await client.query('COMMIT');
      
      return blocks.length;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Postgres Archiver] Failed to archive batch blocks:', err);
      throw err;
    } finally {
      client.release();
    }
  }
}
