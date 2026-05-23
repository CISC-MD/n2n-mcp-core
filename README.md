# N2N Protocol (B2A Gateway)

**Make your business Agent-Ready.**

The N2N Protocol is a global B2A (Business-to-Agent) gateway and deterministic routing standard for autonomous AI agents. It provides a highly secure, strictly typed bridge between untrusted external AI systems and your internal business logic.

![N2N Architecture](https://img.shields.io/badge/Architecture-B2A-blue) ![License](https://img.shields.io/badge/License-MIT-green) ![Status](https://img.shields.io/badge/Status-Production-success)

---

## The Core Concept

Autonomous AI agents (Initiators) often hallucinate when parsing standard HTML websites. They also face severe security barriers when trying to authenticate, perform payments, or execute actions on behalf of a user. 

N2N solves this by decoupling the **compute load** from the **routing layer**.

### Topology
1. **Gateway (api.n2n.md):** A lightweight Fastify + Redis router. It acts as a registry, schema validator, and clearinghouse. **It executes no business logic.**
2. **Edge Node (Business Agent):** A secure, on-premise server or local machine (e.g., Edge Node behind NAT) running your private logic and LLMs.
3. **Initiator:** Any external AI agent (OpenClaw, Antigravity, etc.) looking to execute a task.

### Why N2N?

| Problem | N2N Solution |
| :--- | :--- |
| **LLM HTML Parsing Hallucinations** | Strict JSON contracts with `additionalProperties: false`. |
| **SLA & Timeouts** | Explicit SLA guarantees and timeouts executed at the Gateway level. |
| **Prompt Injection Attacks** | Hardcore payload validation via `AJV` *before* hitting the business agent. |
| **Data Exfiltration & Privacy** | Edge Node execution. Sensitive data is AES-256-CBC encrypted; the Gateway acts strictly as a blind transit router. |

---

## 🚀 Quickstart: Joining the Network

Integrating your business into the N2N B2A network takes less than 5 minutes. No open ports, no complex NAT configurations.

### 1. Publish Your Manifest
Declare your capabilities, economics, and strictly typed JSON schemas using an `n2n.yaml` file. The Gateway uses this manifest to generate dynamic AJV validators.

```yaml
# n2n.yaml example
network:
  node_id: "example_business_core"
  type: "edge_polling" 
  public_key: "-----BEGIN PUBLIC KEY-----\n..." 

economics:
  currency: "credits"
  sla_timeout_ms: 15000 

capabilities:
  - action_id: "get_service_quote"
    description: "Request service pricing"
    cost_override: 5
    payload_schema:
      type: "object"
      additionalProperties: false
      properties:
        service_type: 
          type: "string"
          enum: ["audit", "development", "architecture"]
      required: ["service_type"]
```

### 2. Start Your Edge Worker (Robust Production Example)
Run a secure, daemonized Long-Polling worker inside your infrastructure. This example uses RSA cryptography to sign ACKs and includes exponential backoff for resilience.

```python
import asyncio
import httpx
import json
import base64
import logging
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import serialization

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

GATEWAY_URL = "https://api.n2n.md/v1/b2a"
NODE_TOKEN = "edge_node_generic_core_secret"

# Загрузка приватного ключа Edge Node для подписи ответов
with open("/opt/n2n/keys/private_key.pem", "rb") as key_file:
    PRIVATE_KEY = serialization.load_pem_private_key(key_file.read(), password=None)

def sign_payload(payload_dict: dict) -> str:
    payload_bytes = json.dumps(payload_dict, sort_keys=True).encode('utf-8')
    signature = PRIVATE_KEY.sign(
        payload_bytes,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
        hashes.SHA256()
    )
    return base64.b64encode(signature).decode('utf-8')

async def process_task(action_id: str, payload: dict) -> dict:
    if action_id == "query_semantic_payload":
        # Локальный LLM/Скрипт
        await asyncio.sleep(1)
        return {"payload_id": payload.get("payload_id"), "result_data": 8500, "status": "success"}
    raise ValueError("Unknown action_id")

async def main():
    headers = {"Authorization": f"Bearer {NODE_TOKEN}"}
    limits = httpx.Limits(max_keepalive_connections=5, max_connections=10)
    
    async with httpx.AsyncClient(headers=headers, timeout=30.0, limits=limits) as client:
        backoff = 1
        while True:
            try:
                resp = await client.get(f"{GATEWAY_URL}/poll")
                backoff = 1 # Сброс при успешном коннекте
                
                if resp.status_code == 204:
                    continue
                resp.raise_for_status()
                
                task = resp.json()
                result = await process_task(task["action_id"], task["payload"])
                
                # Формируем и подписываем ACK
                ack_payload = {
                    "message_id": task["message_id"],
                    "status": "success",
                    "result_payload": result
                }
                ack_payload["signature"] = sign_payload(ack_payload)
                
                await client.post(f"{GATEWAY_URL}/ack", json=ack_payload)
                logging.info(f"Task {task['message_id']} executed and signed.")
                
            except Exception as e:
                logging.error(f"Worker fault: {e}. Backing off for {backoff}s.")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

if __name__ == "__main__":
    asyncio.run(main())
```

### 3. Daemonization on macOS (launchd)
To ensure the worker runs persistently in the background, set it up as a `launchd` service.

Create the file: `~/Library/LaunchAgents/md.n2n.edge.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>md.n2n.edge</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/python3</string>
        <string>/opt/n2n/edge_worker.py</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/tmp/n2n_edge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/n2n_edge_err.log</string>
</dict>
</plist>
```

Activate the service:
```bash
launchctl load ~/Library/LaunchAgents/md.n2n.edge.plist
launchctl start md.n2n.edge
```

---

## Development & Deployment

The N2N core infrastructure is built on Node.js, Fastify, Redis, and PostgreSQL.

```bash
# Clone and install dependencies
cd core
npm install

# Run the Fastify B2A Router
npm run build
npm start
```

### Docs Portal
The official technical documentation and asset downloads are available via our high-performance Vite static site generator located in the `docs-portal/` directory.

```bash
cd docs-portal
npm install
npm run dev
```

---

*Architected for a decentralized, agent-first future.*
