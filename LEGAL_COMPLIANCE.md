# N2N Protocol & Gateway — Legal Compliance Manifesto

This document outlines the architectural positioning, regulatory compliance matrix, and data-handling standards of the N2N B2A/A2A Protocol and Gateway.

---

## 🏛️ Architectural Positioning & Core Philosophy

The **N2N Protocol** is an open-source, content-agnostic decentralized routing standard and semantic switchboard designed exclusively for autonomous AI agents (initiating workflows via Model Context Protocol - MCP) and structured web resources.

*   **MIT License & Public Good:** The N2N standard, gateway codebase, and edge polling specifications are developed under the aegis of the **Center for Innovation in Cybersecurity (CISC)**, based in Chișinău, Republic of Moldova.
*   **Chief Architect:** The specification is designed, architected, and administered by **Pavel Berezovschi** (Chief AI Architect & Full Stack Developer).
*   **Decoupled Clearing & Zero Central Billing:** In its core open-source distribution, the N2N Gateway operates purely as an agnostic transport layer. **The core has zero built-in centralized financial processing, acquiring, or monetization.** Any financial clearing, transactional accounting, or monetization contracts are executed by independent external economic nodes connected as modular services to the common bus.

---

## 🛡️ Regulatory Compliance Framework

N2N is architected around the strict principles of **Privacy-by-Design** and **Zero-Trust Transports**, satisfying state-of-the-art global AI and data regulations:

### 1. Law of the Republic of Moldova No. 195/2024 "On Personal Data Protection"
*(Aligned with EU GDPR, entering full, mandatory enforcement in August 2026)*

*   **Zero PII Storage:** The N2N Gateway acts as a blind switchboard. It forbids, restricts, and does not parse, store, or cache Personally Identifiable Information (PII) at the transit level.
*   **Edge Isolation:** Sensitive payload data is end-to-end encrypted (`AES-256-CBC`) using the public key of the targeted Edge Node before submission. The Gateway serves strictly as an encrypted blind transit pipeline.
*   **Strict Retention Controls:** Transient audit logs and network metadata are retained solely for telemetry diagnostics and are automatically, permanently purged after **7 days**.
*   **PII Filtering Layer:** The gateway integrates upstream anomaly checking and anonymization middleware (including *Presidio NER* filters and *Llama-Guard* guardrails) to block and sanitize accidental user payload leakage.

### 2. European Union Artificial Intelligence Act (EU AI Act - Article 52)
*   **Transparency Disclosures:** In compliance with Article 52 transparency mandates, N2N provides machine-readable manifests and distinct JSON-LD schema bindings. Any autonomous agent interactions routed through the switchboard are explicitly flagged as automated machine operations.
*   **Agnostic Routing & Open Ecosystem:** CISC ensures that the routing engine does not discriminate or manipulate agent prompts or responses, functioning as a passive, neutral utility.

---

## 🗃️ Standard Semantic Graph Registry (JSON-LD)

To declare standard compliance and positioning across the semantic web, the gateway serves a machine-readable JSON-LD graph representing the developer organization (CISC) and chief architect:

```json
{
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
}
```

---

## ⚖️ Liability Disclaimer & MIT License

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, THE CENTER FOR INNOVATION IN CYBERSECURITY (CISC), OR PAVEL BEREZOVSCHI BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
