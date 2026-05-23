import { Agent } from 'undici';
import { validateUrl } from '../security/url-validation';

export class HttpClient {
  // Enforce a high-performance persistent Keep-Alive connection pool
  private dispatcher = new Agent({
    keepAliveTimeout: 60000,    // Keep sockets active for 60 seconds
    keepAliveMaxTimeout: 600000,
    connections: 100           // Maintain up to 100 concurrent reusable sockets
  });

  /**
   * Forwards a payload to the given HTTP endpoint and returns the JSON response,
   * utilizing the reusable socket pool to prevent TCP port exhaustion.
   */
  public async forward(endpoint: string, payload: any): Promise<any> {
    await validateUrl(endpoint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      // @ts-ignore
      dispatcher: this.dispatcher
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP forward failed: [${response.status}] ${errorText}`);
    }

    return response.json();
  }
}
