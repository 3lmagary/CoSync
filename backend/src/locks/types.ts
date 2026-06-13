export interface SnapshotLockProvider {
  acquireLock(lockKey: string, ttlMs: number): Promise<boolean>;
  releaseLock(lockKey: string): Promise<void>;
  close(): Promise<void>;
}
