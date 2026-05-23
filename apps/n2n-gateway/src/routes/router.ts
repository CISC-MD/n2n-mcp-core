/**
 * Copyright (c) 2026 Center for Innovation in Cybersecurity (CISC).
 * Chief Architect: Pavel Berezovschi.
 * All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { FastifyInstance } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import Redis from 'ioredis';
import { BillingService } from '../services/billing';
import { EcosystemRegistryService } from '../services/ecosystem';
import { SsePool } from '../services/sse-pool';
import { HttpClient } from '../services/http-client';
import http from 'http';
import fs from 'fs';

import path from 'path';

const sidecarAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 5000
});

function getSocketPath(): string {
  return process.env.CORE_ROUTER_SOCKET_PATH || path.resolve(process.cwd(), 'packages/core-router-rust/core.sock');
}

function dispatchToRustSidecar(payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();
    const postData = JSON.stringify(payload);
    const options = {
      socketPath,
      path: '/v1/execute',
      method: 'POST',
      agent: sidecarAgent,
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    billing: BillingService;
    ecosystem: EcosystemRegistryService;
    ssePool: SsePool;
    httpClient: HttpClient;
  }
}

const GenericMcpMessageSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: Type.Union([Type.String(), Type.Number()]),
  method: Type.String(),
  params: Type.Object({
    targetNode: Type.String(),
    payload: Type.Record(Type.String(), Type.Any())
  })
});

const NodeRegisterSchema = Type.Object({
  uuid: Type.String(),
  type: Type.Union([Type.Literal('AGENT'), Type.Literal('BUSINESS')]),
  endpoint: Type.String(),
  tools: Type.Optional(Type.Array(Type.Object({
    name: Type.String(),
    description: Type.String(),
    parameters: Type.Any()
  }))),
  resources: Type.Optional(Type.Array(Type.Object({
    uri: Type.String(),
    name: Type.String(),
    description: Type.String(),
    mimeType: Type.Optional(Type.String())
  })))
});

const McpCompiler = TypeCompiler.Compile(GenericMcpMessageSchema);
const RegisterCompiler = TypeCompiler.Compile(NodeRegisterSchema);

export async function universalRouter(fastify: FastifyInstance) {
  fastify.post('/v1/register', async (request, reply) => {
    // 1. Authenticate Bearer credit/auth token
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Strict B2A Auth required' });
    }
    
    const token = authHeader.split(' ')[1];
    const nodeId = await fastify.billing.getMasterNodeId(token);
    if (!nodeId) {
      return reply.code(401).send({ error: 'Node unverified' });
    }

    const isValid = RegisterCompiler.Check(request.body);
    if (!isValid) {
      const errors = [...RegisterCompiler.Errors(request.body)];
      const errorMsg = errors.map(e => `${e.path}: ${e.message}`).join(', ');
      return reply.code(400).send({
        error: { code: -32600, message: 'Invalid Request: ' + errorMsg }
      });
    }

    const body = request.body as Static<typeof NodeRegisterSchema>;

    // 2. Prevent Node Spoofing / Hijacking by asserting nodeId matches registration uuid
    if (body.uuid !== nodeId) {
      return reply.code(403).send({ error: 'Forbidden: Cannot register a node under a different UUID than the authenticated Node ID' });
    }

    const redisKey = `node:metadata:${body.uuid}`;
    const payload = {
      type: body.type,
      endpoint: body.endpoint,
      tools: body.tools || [],
      resources: body.resources || []
    };

    await fastify.redis.set(redisKey, JSON.stringify(payload));
    await fastify.redis.publish('ecosystem:reload', 'reload');

    return reply.send({ status: 'REGISTERED', uuid: body.uuid });
  });

  fastify.post('/v1/execute', async (request, reply) => {
    // Валидация структуры сообщения, независимо от доменного контекста
    const isValid = McpCompiler.Check(request.body);
    if (!isValid) {
      const errors = [...McpCompiler.Errors(request.body)];
      const errorMsg = errors.map(e => `${e.path}: ${e.message}`).join(', ');
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: (request.body as any)?.id || null,
        error: { code: -32600, message: 'Invalid Request: ' + errorMsg }
      });
    }
    const body = request.body as Static<typeof GenericMcpMessageSchema>;
    const { targetNode, payload } = body.params;

    // 1. Клиринг: Проверка и холд кредитов отправителя (универсальный слой безопасности)
    const isAuthorized = await fastify.billing.validateM2MTransaction(request.headers);
    if (!isAuthorized) {
      return reply.code(402).send({ error: 'Insufficient Funds / Invalid ZK-Proof' });
    }

    // 2. Try native Rust sidecar IPC routing first over Unix Domain Socket
    try {
      const socketPath = getSocketPath();
      if (fs.existsSync(socketPath)) {
        const sidecarResponse = await dispatchToRustSidecar(body);
        return reply.send(sidecarResponse);
      }
    } catch (err) {
      fastify.log.warn('[Rust Core Router IPC Sidecar Dispatch Failure]: ' + err);
    }

    // 3. Роутинг: Определение типа ноды-получателя через реестр Dragonfly
    const nodeMeta = await fastify.ecosystem.getNodeMetadata(targetNode);
    
    if (nodeMeta.type === 'AGENT') {
      // Режим A2A: Пересылка сообщения в активный SSE-канал целевого агента Б
      const success = await fastify.ssePool.emitToNode(targetNode, {
        method: body.method,
        id: body.id,
        payload
      });
      return reply.send({ status: success ? 'DELIVERED_TO_AGENT' : 'AGENT_OFFLINE' });
    } else {
      // Режим B2A / Web API: Проксирование на веб-хук или REST API классического сайта
      const response = await fastify.httpClient.forward(nodeMeta.endpoint, payload);
      return reply.send({ status: 'DELIVERED_TO_BUSINESS', data: response });
    }
  });
}

export default universalRouter;
