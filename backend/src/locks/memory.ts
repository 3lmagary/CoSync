import { SnapshotLockProvider } from './types';

export class MemorySnapshotLockProvider implements SnapshotLockProvider {
  private locks: Map<string, number> = new Map();

  async acquireLock(lockKey: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiry = this.locks.get(lockKey);

    if (expiry && expiry > now) {
      // Lock is currently held and has not expired yet
      return false;
    }

    this.locks.set(lockKey, now + ttlMs);
    return true;
  }

  async releaseLock(lockKey: string): Promise<void> {
    this.locks.delete(lockKey);
  }

  async close(): Promise<void> {
    this.locks.clear();
  }
}
