import { FastifyInstance } from 'fastify';

export default async function topupRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/billing/topup', async (request: any, reply) => {
    const { node_id, amount_tokens, payment_provider, provider_tx_id, webhook_signature } = request.body;
    
    if (webhook_signature !== process.env.WEBHOOK_SECRET) {
      return reply.code(403).send({ error: 'Invalid signature' });
    }

    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        'INSERT INTO topup_history (node_id, amount_tokens, payment_provider, provider_tx_id) VALUES ($1, $2, $3, $4) ON CONFLICT (provider_tx_id) DO NOTHING',
        [node_id, amount_tokens, payment_provider, provider_tx_id]
      );

      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.send({ status: 'already_processed' });
      }

      await client.query(
        'UPDATE master_balances SET balance_tokens = balance_tokens + $1, updated_at = NOW() WHERE node_id = $2',
        [amount_tokens, node_id]
      );
      await client.query('COMMIT');

      const key = `node_balance:${node_id}`;
      if (await fastify.redis.exists(key)) {
        await fastify.redis.incrbyfloat(key, amount_tokens);
      }
      return reply.send({ status: 'success', added: amount_tokens });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}
