import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type, Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { mcpHandshakeHook } from '../security/handshake';
import { createHash } from 'crypto';
import { validateUrl } from '../security/url-validation';

async function scanKeys(redis: any, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = reply[0];
    keys.push(...reply[1]);
  } while (cursor !== '0');
  return keys;
}


// TypeBox schemas for JIT validation
const JsonRpcRequestSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  method: Type.String(),
  params: Type.Optional(Type.Any()),
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
});

const JsonRpcCompiler = TypeCompiler.Compile(JsonRpcRequestSchema);

/**
 * Main JSON-RPC request handler for the MCP Host
 */
export async function handleMcpRequest(fastify: FastifyInstance, request: FastifyRequest, body: any): Promise<any> {
  const isValid = JsonRpcCompiler.Check(body);
  if (!isValid) {
    const errors = [...JsonRpcCompiler.Errors(body)];
    const errorMsg = errors.map(e => `${e.path}: ${e.message}`).join(', ');
    return {
      jsonrpc: '2.0',
      id: body?.id || null,
      error: { code: -32600, message: 'Invalid Request: ' + errorMsg }
    };
  }

  const { method, params, id } = body as Static<typeof JsonRpcRequestSchema>;

  try {
    switch (method) {
      case 'resources/list': {
        const projects = fastify.ecosystem.getActiveProjects();
        const resources = [
          {
            uri: 'n2n://metadata',
            name: 'Standard Semantic Metadata',
            mimeType: 'application/ld+json',
            description: 'JSON-LD graph containing standard positioning, developer (CISC), and chief architect credentials.'
          },
          {
            uri: 'n2n://projects',
            name: 'Ecosystem Projects',
            mimeType: 'application/json',
            description: 'Full registry list of all active B2A ecosystem nodes and projects.'
          },
          ...projects.map(p => ({
            uri: `n2n://projects/${p.project_id}`,
            name: `${p.name} Info`,
            mimeType: 'application/json',
            description: p.description
          }))
        ];

        // Scan Dragonfly/Redis for custom registered nodes
        try {
          const keys = await scanKeys(fastify.redis, 'node:metadata:*');
          for (const key of keys) {
            const customNodeStr = await fastify.redis.get(key);
            if (customNodeStr) {
              const customNode = JSON.parse(customNodeStr);
              const nodeId = key.substring('node:metadata:'.length);
              if (Array.isArray(customNode.resources)) {
                for (const res of customNode.resources) {
                  resources.push({
                    uri: res.uri,
                    name: res.name,
                    mimeType: res.mimeType || 'application/json',
                    description: `${nodeId} | ${res.description}`
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error('[MCP resources/list] Error reading custom nodes from Redis:', e);
        }

        return {
          jsonrpc: '2.0',
          id,
          result: { resources }
        };
      }

      case 'resources/read': {
        const uri = params?.uri;
        if (!uri || typeof uri !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: missing "uri"' }
          };
        }

        const projects = fastify.ecosystem.getActiveProjects();

        // Check standard resources first, then fall back to custom registered node resources in Redis
        try {
          const keys = await scanKeys(fastify.redis, 'node:metadata:*');
          for (const key of keys) {
            const customNodeStr = await fastify.redis.get(key);
            if (customNodeStr) {
              const customNode = JSON.parse(customNodeStr);
              if (Array.isArray(customNode.resources)) {
                const found = customNode.resources.find((r: any) => r.uri === uri);
                if (found) {
                  return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                      contents: [
                        {
                          uri,
                          mimeType: found.mimeType || 'application/json',
                          text: JSON.stringify(found, null, 2)
                        }
                      ]
                    }
                  };
                }
              }
            }
          }
        } catch (e) {
          console.error('[MCP resources/read] Error searching custom nodes in Redis:', e);
        }

        if (uri === 'n2n://metadata') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/ld+json',
                  text: JSON.stringify({
                    "@context": "https://schema.org",
                    "@graph": [
                      {
                        "@type": "Organization",
                        "@id": "https://cisc.md/#cisc",
                        "name": "Center for Innovation in Cybersecurity",
                        "location": "Chișinău, Moldova",
                        "legalName": "Centrul de Inovație în Securitate Cibernetică"
                      },
                      {
                        "@type": "Person",
                        "@id": "https://cisc.md/#architect",
                        "name": "Pavel Berezovschi",
                        "jobTitle": "Chief AI Architect & Full Stack Developer",
                        "worksFor": { "@id": "https://cisc.md/#cisc" }
                      }
                    ]
                  }, null, 2)
                }
              ]
            }
          };
        }

        if (uri === 'n2n://projects') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(projects, null, 2)
                }
              ]
            }
          };
        }

        const projectPrefix = 'n2n://projects/';
        if (uri.startsWith(projectPrefix)) {
          const projectId = uri.substring(projectPrefix.length);
          const project = projects.find(p => p.project_id === projectId);
          if (!project) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Resource not found: ${uri}` }
            };
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(project, null, 2)
                }
              ]
            }
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown resource URI: ${uri}` }
        };
      }

      case 'tools/list': {
        const projects = fastify.ecosystem.getActiveProjects();
        const tools: any[] = [];

        for (const project of projects) {
          if (Array.isArray(project.tools)) {
            for (const tool of project.tools) {
              tools.push({
                name: tool.name,
                description: `${project.name} | ${tool.description}`,
                inputSchema: tool.parameters || { type: 'object', properties: {} }
              });
            }
          }
        }

        // Scan Dragonfly/Redis for custom registered nodes
        try {
          const keys = await scanKeys(fastify.redis, 'node:metadata:*');
          for (const key of keys) {
            const customNodeStr = await fastify.redis.get(key);
            if (customNodeStr) {
              const customNode = JSON.parse(customNodeStr);
              const nodeId = key.substring('node:metadata:'.length);
              if (Array.isArray(customNode.tools)) {
                for (const tool of customNode.tools) {
                  tools.push({
                    name: tool.name,
                    description: `${nodeId} | ${tool.description}`,
                    inputSchema: tool.parameters || { type: 'object', properties: {} }
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error('[MCP tools/list] Error reading custom nodes from Redis:', e);
        }

        return {
          jsonrpc: '2.0',
          id,
          result: { tools }
        };
      }

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        if (!toolName || typeof toolName !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: missing "name"' }
          };
        }

        const projects = fastify.ecosystem.getActiveProjects();
        let targetTool: any = null;
        let targetProject: any = null;

        for (const project of projects) {
          if (Array.isArray(project.tools)) {
            const found = project.tools.find(t => t.name === toolName);
            if (found) {
              targetTool = found;
              targetProject = project;
              break;
            }
          }
        }

        if (!targetTool) {
          try {
            const keys = await scanKeys(fastify.redis, 'node:metadata:*');
            for (const key of keys) {
              const customNodeStr = await fastify.redis.get(key);
              if (customNodeStr) {
                const customNode = JSON.parse(customNodeStr);
                if (Array.isArray(customNode.tools)) {
                  const found = customNode.tools.find((t: any) => t.name === toolName);
                  if (found) {
                    const nodeId = key.substring('node:metadata:'.length);
                    targetTool = {
                      ...found,
                      api_endpoint: found.api_endpoint || customNode.endpoint
                    };
                    targetProject = {
                      project_id: nodeId,
                      name: nodeId
                    };
                    break;
                  }
                }
              }
            }
          } catch (e) {
            console.error('[MCP tools/call] Error searching custom nodes in Redis:', e);
          }
        }

        if (!targetTool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Tool not found: ${toolName}` }
          };
        }

        // Call the tool endpoint
        const start = Date.now();
        try {
          await validateUrl(targetTool.api_endpoint);
          const response = await fetch(targetTool.api_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toolArgs)
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Tool responded with status ${response.status}: ${errText}`);
          }

          const result = await response.json();
          const durationMs = Date.now() - start;

          // Capture billing if preHandler authorized it successfully
          const authorizedNodeId = (request as any).authorizedNodeId;
          const authorizedCost = (request as any).authorizedCost;

          if (authorizedNodeId && authorizedCost !== undefined) {
            await fastify.billing.capture({
              clientId: authorizedNodeId,
              agentId: targetProject.project_id,
              contextId: (request.headers['x-context-id'] as string) || require('crypto').randomUUID(),
              tokensPrompt: 0,
              tokensCompletion: 0,
              computeMs: durationMs,
              holdUsd: authorizedCost
            });
          }

          return {
            jsonrpc: '2.0',
            id,
            result
          };
        } catch (callErr: any) {
          console.error(`[MCP] Failed calling tool ${toolName}:`, callErr);
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: `Execution failed: ${callErr.message}`
            }
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  } catch (err: any) {
    console.error(`[MCP Error] Processing method ${method}:`, err);
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: `Internal server error: ${err.message}` }
    };
  }
}

export default async function mcpRoutes(fastify: FastifyInstance) {
  // GET SSE Endpoint
  fastify.get('/v1/mcp/sse', async (request, reply) => {
    const connectionId = require('crypto').randomUUID();
    const { node_id } = request.query as { node_id?: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });

    // Write endpoint notification to client as per MCP spec
    const endpointMsg = `event: endpoint\ndata: /v1/mcp/message?connection_id=${connectionId}\n\n`;
    reply.raw.write(endpointMsg);

    fastify.ssePool.register(connectionId, reply, node_id);

    request.raw.on('close', () => {
      fastify.ssePool.deregister(connectionId);
      console.log(`[MCP] SSE Connection closed: ${connectionId}`);
    });

    console.log(`[MCP] SSE Connection registered: ${connectionId} (Node ID: ${node_id || 'none'})`);
  });

  // POST Message Endpoint
  fastify.post('/v1/mcp/message', {
    preHandler: mcpHandshakeHook
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { connection_id } = request.query as { connection_id?: string };

    if (!connection_id) {
      return reply.code(400).send({ error: 'Missing connection_id query parameter' });
    }

    const sseReply = fastify.ssePool.get(connection_id);
    if (!sseReply) {
      return reply.code(404).send({ error: 'Active SSE connection not found' });
    }

    // Process the JSON-RPC message
    const response = await handleMcpRequest(fastify, request, request.body);

    // Push the response over SSE stream
    sseReply.raw.write(`data: ${JSON.stringify(response)}\n\n`);

    // Standard acknowledgement response to client
    return reply.code(200).send({ status: 'ok' });
  });
}
