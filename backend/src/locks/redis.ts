import { SnapshotLockProvider } from './types';

export class RedisSnapshotLockProvider implements SnapshotLockProvider {
  private client: any;
  private redisUri: string;
  private isConnected = false;
  private clientId: string;

  constructor(redisUri: string) {
    this.redisUri = redisUri;
    this.clientId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    this.init();
  }

  private async init() {
    try {
      const Redis = require('ioredis');
      this.client = new Redis(this.redisUri);
      this.isConnected = true;
      console.log('Redis Lock Provider connected to', this.redisUri);
    } catch (err) {
      console.error('Failed to initialize Redis Lock Provider. Falling back to memory mode.', err);
    }
  }

  async acquireLock(lockKey: string, ttlMs: number): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return true; // Fallback: succeed if redis is not running (e.g. in dev)
    }

    try {
      // SET resource_name client_id NX PX ttlMs
      const result = await this.client.set(lockKey, this.clientId, 'NX', 'PX', ttlMs);
      return result === 'OK';
    } catch (error) {
      console.error(`Error acquiring Redis lock for ${lockKey}:`, error);
      return false;
    }
  }

  async releaseLock(lockKey: string): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    // Lua script: release lock only if lock value matches client ID
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      await this.client.eval(releaseScript, 1, lockKey, this.clientId);
    } catch (error) {
      console.error(`Error releasing Redis lock for ${lockKey}:`, error);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
    this.isConnected = false;
  }
}
