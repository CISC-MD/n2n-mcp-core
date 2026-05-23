import Redis from 'ioredis';
import Ajv, { ValidateFunction } from 'ajv';

export interface EcosystemTool {
  name: string;
  description: string;
  parameters: any;
  api_endpoint: string;
}

export interface EcosystemProject {
  project_id: string;
  name: string;
  description: string;
  keywords: string[];
  api_endpoint: string;
  status: string;
  tools?: EcosystemTool[];
  fallbacks?: { api_endpoint: string }[];
}

export class EcosystemRegistryService {
  private projects: Map<string, EcosystemProject> = new Map();
  private subscriberRedis: Redis;
  
  constructor(private redis: Redis) {
    // Clone redis connection for subscriber so it doesn't block the main client
    this.subscriberRedis = redis.duplicate();
  }

  public async initialize(): Promise<void> {
    try {
      await this.loadFromRedis();
      this.subscribeToUpdates();
      console.log(`[Ecosystem] Initialized. Loaded ${this.projects.size} projects from Redis.`);
    } catch (error) {
      console.error('[Ecosystem] Failed to initialize registry:', error);
    }
  }

  private async loadFromRedis(): Promise<void> {
    try {
      const allProjects = await this.redis.hgetall('ecosystem:projects');
      this.projects.clear();
      
      for (const [projectId, content] of Object.entries(allProjects)) {
        try {
          const project = JSON.parse(content) as EcosystemProject;
          if (project.status === 'active') {
            this.projects.set(projectId, project);
          }
        } catch (e) {
          console.error(`[Ecosystem] Failed to parse project ${projectId} from Redis`);
        }
      }
    } catch (error) {
      console.error('[Ecosystem] Error loading from Redis:', error);
    }
  }

  private subscribeToUpdates(): void {
    this.subscriberRedis.subscribe('ecosystem:reload', (err) => {
      if (err) console.error('[Ecosystem] Failed to subscribe to reload channel', err);
    });

    this.subscriberRedis.on('message', async (channel, message) => {
      if (channel === 'ecosystem:reload') {
        console.log('[Ecosystem] 🔄 Received reload signal via Pub/Sub. Reloading...');
        await this.loadFromRedis();
        console.log(`[Ecosystem] Reload complete. Active projects: ${this.projects.size}`);
      }
    });
  }

  public matchByKeyword(query: string): EcosystemProject[] {
    const lowerQuery = query.toLowerCase();
    
    // Sort projects by number of matching keywords (Context Budgeting)
    const scoredProjects = Array.from(this.projects.values())
      .map(project => {
        const matchCount = project.keywords.filter(kw => lowerQuery.includes(kw.toLowerCase())).length;
        return { project, matchCount };
      })
      .filter(p => p.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount);

    // Context Budgeting: limit to top 2 results
    return scoredProjects.slice(0, 2).map(p => p.project);
  }

  public getActiveProjects(): EcosystemProject[] {
    return Array.from(this.projects.values());
  }

  public async getNodeMetadata(nodeId: string): Promise<{ type: 'AGENT' | 'BUSINESS'; endpoint: string; metadata?: any }> {
    const project = this.projects.get(nodeId) || Array.from(this.projects.values()).find(p => p.project_id === nodeId);
    if (project) {
      return {
        type: 'AGENT',
        endpoint: project.api_endpoint,
        metadata: project
      };
    }
    
    // Check if custom node configuration is present in Redis
    const customNodeStr = await this.redis.get(`node:metadata:${nodeId}`);
    if (customNodeStr) {
      try {
        return JSON.parse(customNodeStr);
      } catch (e) {}
    }
    
    // Default fallback to standard business service endpoints
    return {
      type: 'BUSINESS',
      endpoint: `https://${nodeId}.md/api`
    };
  }
}
