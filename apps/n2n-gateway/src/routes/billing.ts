import { FastifyInstance } from 'fastify';
import { BillingService } from '../services/billing';

declare module 'fastify' {
  interface FastifyInstance {
    billing: BillingService;
  }
}

export default async function billingRoutes(fastify: FastifyInstance) {
  // 1. PreAuth (Hold) endpoint
  fastify.post('/v1/billing/preauth', async (request: any, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Strict B2A Auth required' });
    }
    
    const token = authHeader.split(' ')[1];
    const nodeId = await fastify.billing.getMasterNodeId(token);
    if (!nodeId) return reply.code(401).send({ error: 'Node unverified' });

    const { estimated_cost_usd } = request.body || {};
    const holdUsd = estimated_cost_usd !== undefined ? Number(estimated_cost_usd) : 0.05;

    if (isNaN(holdUsd) || holdUsd <= 0) {
      return reply.code(400).send({ error: 'Invalid estimated_cost_usd' });
    }

    const hasFunds = await fastify.billing.preAuth(nodeId, holdUsd);
    if (!hasFunds) {
      return reply.code(402).send({ error: 'Insufficient funds (PAYG balance too low)' });
    }

    return reply.send({
      status: 'success',
      client_id: nodeId,
      hold_usd: holdUsd
    });
  });

  // 2. Capture endpoint (also handles full/partial refunds via zero/low metrics)
  fastify.post('/v1/billing/capture', async (request: any, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Strict B2A Auth required' });
    }
    
    const token = authHeader.split(' ')[1];
    const nodeId = await fastify.billing.getMasterNodeId(token);
    if (!nodeId) return reply.code(401).send({ error: 'Node unverified' });

    const { agent_id, context_id, tokens_prompt, tokens_completion, compute_ms, hold_usd } = request.body || {};

    if (hold_usd === undefined || isNaN(Number(hold_usd)) || Number(hold_usd) <= 0) {
      return reply.code(400).send({ error: 'Missing or invalid hold_usd' });
    }

    try {
      await fastify.billing.capture({
        clientId: nodeId,
        agentId: agent_id || 'n8n-automation-agent',
        contextId: context_id,
        tokensPrompt: tokens_prompt !== undefined ? Number(tokens_prompt) : 0,
        tokensCompletion: tokens_completion !== undefined ? Number(tokens_completion) : 0,
        computeMs: compute_ms !== undefined ? Number(compute_ms) : 0,
        holdUsd: Number(hold_usd)
      });

      return reply.send({
        status: 'success',
        message: 'Captured successfully'
      });
    } catch (err: any) {
      fastify.log.error({ err }, 'External Capture failed');
      return reply.code(500).send({ error: 'Capture process failed' });
    }
  });
}
