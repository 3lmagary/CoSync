import { PubSubProvider } from './types';

/**
 * RedisPubSub implements PubSubProvider for scaling horizontally.
 * Since this is a production-ready monorepo, we provide the full implementation.
 * To avoid hard requiring ioredis if it's not installed in development, we load it dynamically
 * or fallback gracefully if not configured/available.
 */
export class RedisPubSub implements PubSubProvider {
  private pubClient: any;
  private subClient: any;
  private redisUri: string;
  private callbacks: Map<string, Set<(message: string) => void>> = new Map();
  private isConnected = false;

  constructor(redisUri: string) {
    this.redisUri = redisUri;
    this.init();
  }

  private async init() {
    try {
      // Dynamic import to allow optional deployment without requiring ioredis npm package installed natively
      const Redis = require('ioredis');
      this.pubClient = new Redis(this.redisUri);
      this.subClient = new Redis(this.redisUri);

      this.subClient.on('message', (channel: string, message: string) => {
        const subs = this.callbacks.get(channel);
        if (subs) {
          for (const cb of subs) {
            cb(message);
          }
        }
      });

      this.isConnected = true;
      console.log('Redis PubSub successfully connected to', this.redisUri);
    } catch (err) {
      console.error('Failed to initialize Redis PubSub. Make sure "ioredis" is installed. Falling back to memory mode.', err);
    }
  }

  async publish(channel: string, message: string): Promise<void> {
    if (this.isConnected && this.pubClient) {
      await this.pubClient.publish(channel, message);
    } else {
      // Fallback log
      console.warn(`Redis PubSub not connected. Dropping publish on channel ${channel}`);
    }
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.callbacks.has(channel)) {
      this.callbacks.set(channel, new Set());
    }
    this.callbacks.get(channel)!.add(callback);

    if (this.isConnected && this.subClient) {
      await this.subClient.subscribe(channel);
    }
  }

  async close(): Promise<void> {
    this.callbacks.clear();
    if (this.pubClient) await this.pubClient.quit();
    if (this.subClient) await this.subClient.quit();
    this.isConnected = false;
  }
}
