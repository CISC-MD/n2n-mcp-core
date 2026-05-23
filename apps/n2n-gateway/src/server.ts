/**
 * Copyright (c) 2026 Center for Innovation in Cybersecurity (CISC).
 * Chief Architect: Pavel Berezovschi.
 * All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { Pool } from 'pg';
import path from 'path';
import { BillingService } from './services/billing';
import { ManifestService } from './services/manifest';
import { EcosystemRegistryService } from './services/ecosystem';
import { CacheService } from './services/cache';
import { PIIService } from './services/pii';
import { SsePool } from './services/sse-pool';
import { HttpClient } from './services/http-client';
import topupRoutes from './routes/topup';
import billingRoutes from './routes/billing';
import mcpRoutes from './routes/mcp';
import universalRouter from './routes/router';
import rateLimit from '@fastify/rate-limit';

const fastify = Fastify({ logger: { level: 'info' } });

// Единый инстанс Redis для высокой нагрузки (с поддержкой Unix Sockets для нулевых сетевых задержек)
const redisCache = new Redis(
  process.env.REDIS_SOCKET_PATH
    ? { path: process.env.REDIS_SOCKET_PATH }
    : {
        host: process.env.REDIS_HOST || 'redis',
        port: Number(process.env.REDIS_PORT) || 6379,
      }
);

// Configure Redis instance parameters
redisCache.options.retryStrategy = (times) => Math.min(times * 50, 2000);
redisCache.options.maxRetriesPerRequest = 3;
redisCache.options.lazyConnect = true;

// Dynamic, production-grade rate limiting backed by shared Redis store
fastify.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
  redis: redisCache,
  keyGenerator: (request) => {
    // Generate rate limit keys using IP or token if authorized
    return request.headers['x-forwarded-for'] as string || request.ip;
  },
  errorResponseBuilder: (request, context) => {
    return {
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum allowed is ${context.max} requests per ${context.after}.`
    };
  }
});

const pgPool = new Pool({
  user: process.env.POSTGRES_USER || 'n2n_user',
  password: process.env.POSTGRES_PASSWORD || 'n2n_password',
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB || 'n2n_hub',
  max: 100,
  min: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const billing = new BillingService(redisCache, pgPool);
const manifest = new ManifestService();
const ecosystem = new EcosystemRegistryService(redisCache);
const cacheService = new CacheService(redisCache);
const piiService = new PIIService();
const ssePool = new SsePool(redisCache);
const httpClient = new HttpClient();

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    pg: Pool;
    billing: BillingService;
    manifest: ManifestService;
    ecosystem: EcosystemRegistryService;
    semanticCache: CacheService;
    pii: PIIService;
    ssePool: SsePool;
    httpClient: HttpClient;
  }
}

fastify.decorate('redis', redisCache);
fastify.decorate('pg', pgPool);
fastify.decorate('billing', billing);
fastify.decorate('manifest', manifest);
fastify.decorate('ecosystem', ecosystem);
fastify.decorate('semanticCache', cacheService);
fastify.decorate('pii', piiService);
fastify.decorate('ssePool', ssePool);
fastify.decorate('httpClient', httpClient);

// Регистрация только абстрактных финансовых маршрутов
fastify.register(topupRoutes);
fastify.register(billingRoutes);
fastify.register(mcpRoutes);
fastify.register(universalRouter);

// B2A Generic Task Queue
fastify.post('/v1/b2a/dispatch', async (request: any, reply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Strict B2A Auth required' });
  }
  
  const token = authHeader.split(' ')[1];
  const nodeId = await fastify.billing.getMasterNodeId(token);
  if (!nodeId) return reply.code(401).send({ error: 'Node unverified' });

  const { target_node_id, action_id, payload, webhook_url } = request.body;
  
  if (!target_node_id || !action_id || !payload) {
    return reply.code(400).send({ error: 'Missing target_node_id, action_id, or payload' });
  }

  // --- SEMANTIC CACHING ---
  // If payload has a text query, check cache
  const queryText = payload.query || payload.text;
  if (queryText) {
    const cachedResult = await fastify.semanticCache.getCachedResult(queryText, action_id);
    if (cachedResult) {
      return reply.send({
        status: 'cached',
        tx_hash: 'cached_' + require('crypto').randomUUID(),
        result: cachedResult
      });
    }
  }

  // Получаем точную стоимость из скомпилированного манифеста
  const cost_tokens = fastify.manifest.getCost(target_node_id, action_id);
  if (cost_tokens === null) {
    // Внедрение Fallback логики из Ecosystem (упрощенно: можно рероутить на резервный API)
    return reply.code(404).send({ error: 'Action not found for target node' });
  }

  // Строгая валидация входящего JSON через AJV
  const validation = fastify.manifest.validatePayload(target_node_id, action_id, payload);
  if (!validation.valid) {
    return reply.code(400).send({ error: 'Payload validation failed', details: validation.errors });
  }
  
  const holdUsd = cost_tokens; 
  const hasFunds = await fastify.billing.preAuth(nodeId, holdUsd);
  if (!hasFunds) {
    return reply.code(402).send({ error: 'Insufficient funds (PAYG balance too low)' });
  }

  const txHash = require('crypto').randomUUID();

  // --- PII REDACTION ---
  let safePayload = payload;
  if (queryText) {
    const { redactedText, map } = fastify.pii.redact(queryText);
    safePayload = { ...payload, [payload.query ? 'query' : 'text']: redactedText };
    
    // Store PII map in Redis to restore later
    if (Object.keys(map).length > 0) {
      await redisCache.set(`pii_map:${txHash}`, JSON.stringify(map), 'EX', 3600);
    }
  }

  // Save webhook URL and status
  if (webhook_url) {
    await redisCache.set(`webhook:${txHash}`, webhook_url, 'EX', 86400);
  }
  await redisCache.set(`status:${txHash}`, 'pending', 'EX', 86400);

  // Публикация задачи в абстрактный стрим
  await redisCache.xadd(`node_queue:${target_node_id}`, '*', 
    'source', nodeId, 
    'action_id', action_id,
    'context_id', txHash,
    'hold_usd', holdUsd.toString(),
    'payload', JSON.stringify(safePayload)
  );

  return reply.code(202).send({
    status: 'accepted',
    tx_hash: txHash,
    hold_usd: holdUsd
  });
});

// Polling endpoint for clients without webhooks
fastify.get('/v1/b2a/status/:tx_hash', async (request: any, reply) => {
  const { tx_hash } = request.params;
  const status = await redisCache.get(`status:${tx_hash}`);
  const result = await redisCache.get(`result:${tx_hash}`);

  if (!status) return reply.code(404).send({ error: 'Transaction not found' });

  return reply.send({
    status,
    result: result ? JSON.parse(result) : null
  });
});

// Webhook для получения результатов от Data Plane (Агентов) и выполнения Capture
fastify.post('/v1/b2a/result', async (request: any, reply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Strict B2A Auth required' });
  }
  
  const targetNodeId = await fastify.billing.getMasterNodeId(authHeader.split(' ')[1]);
  if (!targetNodeId) return reply.code(401).send({ error: 'Node unverified' });

  let { client_id, context_id, usage, hold_usd, result, original_query } = request.body;
  if (!client_id || !usage || !hold_usd) {
    return reply.code(400).send({ error: 'Missing client_id, usage metrics, or hold_usd' });
  }

  // --- RESTORE PII ---
  const piiMapStr = await redisCache.get(`pii_map:${context_id}`);
  if (piiMapStr && result?.text) {
    const piiMap = JSON.parse(piiMapStr);
    result.text = fastify.pii.restore(result.text, piiMap);
  }

  // --- SEMANTIC CACHING ---
  if (original_query && result) {
    // We assume action_id is known or we cache it globally for the agent
    await fastify.semanticCache.setCachedResult(original_query, targetNodeId, result);
  }

  // Шаг 2: Capture (Списание и разморозка)
  try {
    await fastify.billing.capture({
      clientId: client_id,
      agentId: targetNodeId,
      contextId: context_id,
      tokensPrompt: usage.prompt_tokens || 0,
      tokensCompletion: usage.completion_tokens || 0,
      computeMs: usage.compute_ms || 0,
      holdUsd: parseFloat(hold_usd)
    });

    // Save status and result
    await redisCache.set(`status:${context_id}`, 'completed');
    if (result) {
      await redisCache.set(`result:${context_id}`, JSON.stringify(result));
    }

    // --- ASYNC WEBHOOK ---
    const webhookUrl = await redisCache.get(`webhook:${context_id}`);
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx_hash: context_id, status: 'completed', result })
        });
      } catch (e) {
        fastify.log.error(`Failed to trigger webhook for ${context_id}`);
      }
    }

    return reply.send({ status: 'captured' });
  } catch (err: any) {
    fastify.log.error({ err }, 'Capture failed');
    await redisCache.set(`status:${context_id}`, 'failed');
    return reply.code(500).send({ error: 'Capture process failed' });
  }
});

// Semantic Discovery Route
fastify.post('/v1/b2a/discover', async (request: any, reply) => {
  const { query } = request.body || {};
  if (!query) {
    return reply.code(400).send({ error: 'Missing search query' });
  }

  const results = fastify.ecosystem.matchByKeyword(query);
  const crossSaleContextId = require('crypto').randomUUID();
  
  return reply.send({
    status: 'success',
    matches: results.map(r => ({
      project_id: r.project_id,
      name: r.name,
      description: r.description,
      api_endpoint: r.api_endpoint,
      tools: r.tools || [],
      fallbacks: r.fallbacks || [],
      cross_sale_context_id: crossSaleContextId
    }))
  });
});

fastify.addHook('onClose', async (instance) => {
  await instance.ssePool.destroy();
});

const PORT = Number(process.env.PORT) || 4000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, async (err) => {
  if (err) { 
    fastify.log.error({ err }, 'Failed to start B2A Core'); 
    process.exit(1); 
  }
  
  try {
    const manifestsPath = path.join(__dirname, '../manifests');
    await fastify.manifest.loadAll(manifestsPath);
  } catch (manifestErr) {
    fastify.log.error({ err: manifestErr }, 'Failed to load manifests');
  }

  // Initialize Ecosystem Registry with Hot Reload
  await fastify.ecosystem.initialize();

  // Start background ledger consumer to sync Redis stream to PostgreSQL
  fastify.billing.startLedgerConsumer();

  fastify.log.info(`n2n B2A Registry listening on port ${PORT}`);
});