import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import Ajv, { ValidateFunction } from 'ajv';

interface ActionMetadata {
  cost: number;
  validator: ValidateFunction;
  schema: any;
}

interface NodeManifest {
  actions: Map<string, ActionMetadata>;
  baseCost: number;
}

export class ManifestService {
  private ajv: Ajv;
  private manifests: Map<string, NodeManifest> = new Map();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, removeAdditional: false });
  }

  async loadAll(manifestsDir: string): Promise<void> {
    try {
      const files = await fs.readdir(manifestsDir);
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          await this.loadManifest(path.join(manifestsDir, file));
        }
      }
      console.log(`Loaded ${this.manifests.size} node manifests.`);
    } catch (err) {
      console.error(`Error loading manifests from ${manifestsDir}:`, err);
    }
  }

  private async loadManifest(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const doc = yaml.load(content) as any;

    if (!doc || !doc.network || !doc.network.node_id) {
      console.warn(`Skipping invalid manifest at ${filePath}`);
      return;
    }

    const nodeId = doc.network.node_id;
    const baseCost = doc.economics?.base_cost_per_intent || 0;
    const actions = new Map<string, ActionMetadata>();

    if (Array.isArray(doc.capabilities)) {
      for (const cap of doc.capabilities) {
        const actionId = cap.action_id;
        const schema = cap.payload_schema || {};
        const costOverride = cap.cost_override;
        const cost = costOverride !== undefined ? costOverride : baseCost;

        try {
          const validator = this.ajv.compile(schema);
          actions.set(actionId, { cost, validator, schema });
        } catch (err) {
          console.error(`Failed to compile schema for action ${actionId} in node ${nodeId}`, err);
        }
      }
    }

    this.manifests.set(nodeId, { baseCost, actions });
  }

  getCost(nodeId: string, actionId: string): number | null {
    const node = this.manifests.get(nodeId);
    if (!node) return null;
    const action = node.actions.get(actionId);
    if (!action) return null;
    return action.cost;
  }

  validatePayload(nodeId: string, actionId: string, payload: any): { valid: boolean; errors?: any } {
    const node = this.manifests.get(nodeId);
    if (!node) return { valid: false, errors: ['Node manifest not found'] };
    
    const action = node.actions.get(actionId);
    if (!action) return { valid: false, errors: ['Action not found in manifest'] };

    const valid = action.validator(payload);
    if (!valid) {
      return { valid: false, errors: action.validator.errors };
    }
    return { valid: true };
  }
}
