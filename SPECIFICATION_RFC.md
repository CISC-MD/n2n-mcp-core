# N2N Protocol Specification (RFC-1)

**Version:** 1.1.0  
**Authors:** Chief AI Architect Pavel Berezovschi, Center for Innovation in Cybersecurity (CISC)  
**License:** [MIT License](file:///Users/pablolab/n2n/LICENSE)  
**Status:** Standard / Active Reference Specification (Defensive Publication / Prior Art)  

---

## 1. Abstract

The Node-to-Node (N2N) Protocol defines an open, domain-agnostic, and high-performance routing, clearing, and semantic switchboard standard. It is designed to act as a decentralized semantic transit layer for machine-to-machine (M2M), agent-to-agent (A2A), and business-to-agent (B2A) interactions.

N2N operates under strict Zero-Trust and Privacy-by-Design paradigms, in full compliance with GDPR Article 5 and the Republic of Moldova Law № 195/2024 "On Personal Data Protection". No domain-specific semantics or plain-text PII (Personally Identifiable Information) are retained or processed on transit nodes.

This document, combined with the public repository reference implementations, establishes an official defensive publication. Software architectures, messaging patterns, and clearing methodologies defined herein are published under the MIT License to serve as **Prior Art**, preventing third-party patent locking and ensuring open, royalty-free usage across the global developer community.

---

## 2. Architecture & Frame Structures

N2N endpoints facilitate decoupled, stateless message routing. Payloads are encapsulated in generic wireframes.

### 2.1 JSON-RPC 2.0 Message Schema

Every message routed through the N2N Gateway MUST conform to the JSON-RPC 2.0 standard. High-performance JSON schema validations are JIT-compiled in Fastify via `@sinclair/typebox`:

```json
{
  "jsonrpc": "2.0",
  "id": "req-8e4f1a2b-cd3e-4f3a-af5b-8f9a0b1c2d3e",
  "method": "tools/call",
  "params": {
    "targetNode": "node-target-uuid-here",
    "payload": {
      "query": "Perform semantic analysis on database log records",
      "depth": "deep"
    }
  }
}
```

### 2.2 Cap'n Proto Binary Serialization

For high-speed, zero-copy IPC socket transmissions, N2N supports binary serialization utilizing **Cap'n Proto**. This eliminates serialization and deserialization overhead on gateway nodes:

```capnp
@0xf8b18a3d3c2e1b0a;

struct Params {
  targetNode @0 :Text;
  payload @1 :Data; # Dynamic serialized protocol buffer or JSON-LD byte data
}

struct McpMessage {
  jsonrpc @0 :Text = "2.0";
  id @1 :Int64;
  method @2 :Text;
  params @3 :Params;
}

struct NodeManifest {
  uuid @0 :Text;
  type @1 :Type;
  endpoint @2 :Text;
  tools @3 :List(Tool);
  resources @4 :List(Resource);

  enum Type {
    agent @0;
    business @1;
  }

  struct Tool {
    name @0 :Text;
    description @1 :Text;
    parametersSchema @2 :Data; # JIT TypeBox or JSON-Schema bytes
  }

  struct Resource {
    uri @0 :Text;
    name @1 :Text;
    description @2 :Text;
    mimeType @3 :Text;
  }
}
```

---

## 3. Dynamic Registry & Live MCP Binding

Self-discovery is achieved via dynamic manifest registration. Custom agent or business nodes submit a validated manifest to the Gateway endpoint `POST /v1/register`.

Registered manifests are saved atomically into the Dragonfly caching tier using IPC Unix Domain Sockets (`.sock`):
* **Key Format:** `node:metadata:${uuid}`
* **Ecosystem Reload:** Emits a high-frequency reload trigger via Pub/Sub to sync the network state.

During Model Context Protocol (MCP) interactions (e.g. `tools/list`, `tools/call`, `resources/list`, `resources/read`), the gateway scans Dragonfly registry keys matching `node:metadata:*` in real-time, dynamically merging and proxying third-party capabilities instantly.

---

## 4. Cryptographic Clearing Layer (ZK-Clearing)

To enforce transactional rate-limiting and cost-accounting without disclosing sensitive agent balances, the N2N clearing layer uses additive-homomorphic commitments and ZK proofs.

### 4.1 Pedersen Commitments

A wallet or economic node commits its token balance or transit fees to a hidden curve point:

$$C = vG + sH \pmod p$$

Where:
* $v$ is the scalar value (e.g., wallet balance or compute fee).
* $s$ is the cryptographically secure random blinding factor (scalar).
* $G$ is the standard Secp256k1 generator point.
* $H$ is a cryptographically independent, fixed Secp256k1 generator point:
  $$H = \text{sha256}(G_x)$$

### 4.2 Homomorphic Balance Subtraction

When a transaction fee $v_{fee}$ is assessed, the gateway performs homomorphic subtraction of the commitments in the off-chain ledger directly on the elliptic curve, without decrypting or learning the original balance $v_{orig}$:

$$C_{new} = C_{orig} - C_{fee}$$

$$(v_{orig}G + s_{orig}H) - (v_{fee}G + s_{fee}H) = (v_{orig} - v_{fee})G + (s_{orig} - s_{fee})H$$

This results in a mathematically precise, verifiable new balance commitment $C_{new}$, backed by non-interactive Bulletproofs ZK Range Proofs validating that $v_{orig} - v_{fee} \ge 0$, maintaining 100% solvency and cryptographic privacy.

---

## 5. Security & Regulatory Compliance

### 5.1 Moldova Law № 195/2024 & GDPR Art. 5 Compliance
All gateway implementations MUST implement:
1. **Zero-PII Storage**: Absolutely no database logging or persistent storage of plain-text PII in transit. All user telemetry is transient and completely purged from memory buffers every 7 days.
2. **End-to-End Payload Encryption**: Message payloads (`payload` object) containing private data are encrypted at the edge node using `AES-256-CBC` with the recipient's public key prior to gateway transit. The routing gateway has no visibility of the keys.
3. **Consumer Group Garbage Collection**: To prevent cluster PEL (Pending Acknowledgment List) memory leaks, gateways must implement an active cleanup loop `reapDeadConsumerGroups()` using `XINFO GROUPS` to identify and `XGROUP DESTROY` dynamic consumer groups hapayload_idg 0 active consumers.
