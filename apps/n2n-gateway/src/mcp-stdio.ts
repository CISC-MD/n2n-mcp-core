import 'dotenv/config';
import readline from 'readline';
import Redis from 'ioredis';
import { Pool } from 'pg';
import path from 'path';
import { BillingService } from './services/billing';
import { ManifestService } from './services/manifest';
import { EcosystemRegistryService } from './services/ecosystem';
import { handleMcpRequest } from './routes/mcp';
import { FastifyInstance, FastifyRequest } from 'fastify';

async function main() {
  // Initialize minimal core services
  const redisCache = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6380,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3
  });

  const pgPool = new Pool({
    user: process.env.POSTGRES_USER || 'n2n_user',
    password: process.env.POSTGRES_PASSWORD || 'n2n_password',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'n2n_hub',
  });

  const billing = new BillingService(redisCache, pgPool);
  const manifest = new ManifestService();
  const ecosystem = new EcosystemRegistryService(redisCache);

  await ecosystem.initialize();
  
  try {
    const manifestsPath = path.join(__dirname, 'manifests');
    await manifest.loadAll(manifestsPath);
  } catch (err) {
    // manifests might not be in dist/src/manifests or src/manifests, try fallback relative paths
    try {
      const manifestsPathFallback = path.join(__dirname, '../manifests');
      await manifest.loadAll(manifestsPathFallback);
    } catch (_) {}
  }

  // Create a minimal Fastify-like mock context
  const mockFastify = {
    billing,
    manifest,
    ecosystem,
    redis: redisCache,
    pg: pgPool,
  } as unknown as FastifyInstance;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  // Keep connection logs to stderr to avoid polluting stdout (MCP standard spec)
  console.error('[MCP STDIO] Host Server Active and Listening on stdin...');

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const body = JSON.parse(trimmed);
      
      // Mock Fastify Request object for tool invocation inside STDIO
      const mockRequest = {
        headers: {},
        query: {}
      } as unknown as FastifyRequest;

      // Note: Handshake signature verification is bypassed for local STDIO connections by design,
      // as STDIO runs in secure local processes, but we register standard credit details if required.
      const response = await handleMcpRequest(mockFastify, mockRequest, body);
      
      // Print output directly to stdout
      console.log(JSON.stringify(response));
    } catch (parseErr: any) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: ' + parseErr.message }
      }));
    }
  });

  process.on('SIGINT', async () => {
    console.error('[MCP STDIO] Shutting down...');
    await redisCache.quit();
    await pgPool.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[MCP STDIO] Fatal Error in STDIO layer:', err);
  process.exit(1);
});
