export class FeatureFlagService {
  static isEnabled(flagName: string): boolean {
    const value = process.env[flagName];
    if (!value) return false;
    return value.toLowerCase() === 'true' || value === '1';
  }

  static getRedisUri(): string {
    return process.env.REDIS_URI || 'redis://localhost:6379';
  }

  static getDatabasePath(): string {
    return process.env.DATABASE_PATH || './data/sync.db';
  }

  static getMaxDocSize(): number {
    const size = parseInt(process.env.MAX_DOC_SIZE || '5242880', 10); // Default: 5MB in bytes
    return isNaN(size) ? 5242880 : size;
  }
}
