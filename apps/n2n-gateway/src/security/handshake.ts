import { FastifyRequest, FastifyReply } from 'fastify';
import { verify as cryptoVerify } from 'crypto';
import { verifyProofAsync } from './crypto-pool';

/**
 * Verifies a signature using the node's public key (PEM formatted Ed25519 or ECDSA)
 * Supports dynamic algorithm selection ensuring correct signature type checks (Ed25519 vs standard).
 */
export function verifySignature(publicKey: string, signatureBase64: string, payload: string): boolean {
  try {
    const signatureBuffer = Buffer.from(signatureBase64, 'base64');
    const dataBuffer = Buffer.from(payload);

    // Ed25519 signatures cannot be verified with a hash algorithm name (e.g. SHA256) in Node.js
    // and require a null/undefined algorithm parameter.
    const isEd25519 = publicKey.includes('Ed25519') || 
                      publicKey.includes('ED25519') || 
                      publicKey.toLowerCase().includes('id-ed25519');

    const algorithm = isEd25519 ? null : 'SHA256';
    return cryptoVerify(algorithm, dataBuffer, publicKey, signatureBuffer);
  } catch (err) {
    console.error('[Handshake] Signature verification error:', err);
    return false;
  }
}

/**
 * Fastify preHandler hook for cryptographic and credit authorization handshake
 */
export async function mcpHandshakeHook(request: FastifyRequest, reply: FastifyReply) {
  // We only intercept messages targeted for executing tools
  const body = request.body as any;
  if (!body) return;

  // For JSON-RPC 2.0 messages over HTTP POST
  const isToolsCall = body.method === 'tools/call';
  if (!isToolsCall) return;

  const authHeader = request.headers.authorization || request.headers['x-credit-token'] as string;
  const signature = request.headers['x-node-signature'] as string;
  const publicKey = request.headers['x-node-public-key'] as string;

  if (!authHeader) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32001, message: 'Missing Authorization credit token' }
    });
  }

  if (!signature || !publicKey) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32002, message: 'Cryptographic handshake failed: missing signature or public key' }
    });
  }

  // 1. Verify Cryptographic Handshake Signature
  // The client must sign the raw 'params' field or the entire JSON-RPC message
  const payloadToVerify = typeof body.params === 'object' ? JSON.stringify(body.params) : JSON.stringify(body);
  const isSignatureValid = verifySignature(publicKey, signature, payloadToVerify);
  
  if (!isSignatureValid) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32003, message: 'Cryptographic handshake failed: invalid signature' }
    });
  }

  // 1.5. Validate Zero-Knowledge Balance Commitment & Range Proof if provided
  const balanceCommitmentHeader = request.headers['x-balance-commitment'] as string;
  const balanceProofHeader = request.headers['x-balance-proof'] as string;

  if (balanceCommitmentHeader && balanceProofHeader) {
    try {
      const V = JSON.parse(balanceCommitmentHeader);
      const proof = JSON.parse(balanceProofHeader);
      
      const isProofValid = await verifyProofAsync(V, proof, 32);
      if (!isProofValid) {
        return reply.code(401).send({
          jsonrpc: '2.0',
          id: body.id || null,
          error: { code: -32006, message: 'Cryptographic handshake failed: invalid zero-knowledge range proof' }
        });
      }
    } catch (err) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: body.id || null,
        error: { code: -32007, message: 'Cryptographic handshake failed: malformed balance commitment or range proof' }
      });
    }
  }

  // 2. Validate Node Authorization Token & Balance
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  // @ts-ignore
  const billingService = request.server.billing;
  const nodeId = await billingService.getMasterNodeId(token);

  if (!nodeId) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32004, message: 'Credit authorization failed: node unverified' }
    });
  }

  // Deduct default tool pre-auth cost or tool-specific cost if found
  const toolName = body.params?.name;
  // @ts-ignore
  const manifestService = request.server.manifest;
  
  // Try to find if this tool matches a manifest cost
  let cost = 0.05; // default pre-auth cost in USD
  if (toolName) {
    const costOverride = manifestService.getCost(nodeId, toolName);
    if (costOverride !== null) {
      cost = costOverride;
    }
  }

  const hasFunds = await billingService.preAuth(nodeId, cost);
  if (!hasFunds) {
    return reply.code(402).send({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32005, message: 'Credit authorization failed: insufficient balance (PAYG too low)' }
    });
  }

  // Decorate the request context with nodeId & hold details for capture at routing step
  (request as any).authorizedNodeId = nodeId;
  (request as any).authorizedCost = cost;
}
