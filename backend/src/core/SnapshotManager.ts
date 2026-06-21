import * as Y from 'yjs';
import { DatabaseProvider } from '../database/types';
import { SnapshotLockProvider } from '../locks/types';
import { logger } from '../services/logger';
import { snapshotCompactionCount, snapshotDuration } from '../services/metrics';

export class SnapshotManager {
  private dbProvider: DatabaseProvider;
  private lockProvider: SnapshotLockProvider;

  // Thresholds
  private maxUpdatesCount: number;
  private maxUpdatesSize: number;
  private maxTimeElapsedMs: number;

  constructor(
    dbProvider: DatabaseProvider,
    lockProvider: SnapshotLockProvider,
    options?: {
      maxUpdatesCount?: number;
      maxUpdatesSize?: number;
      maxTimeElapsedMs?: number;
    }
  ) {
    this.dbProvider = dbProvider;
    this.lockProvider = lockProvider;
    
    // Fallbacks to default env or values
    this.maxUpdatesCount = options?.maxUpdatesCount || parseInt(process.env.SNAPSHOT_MAX_UPDATES || '1000', 10);
    this.maxUpdatesSize = options?.maxUpdatesSize || parseInt(process.env.SNAPSHOT_MAX_SIZE || '5242880', 10); // 5MB
    this.maxTimeElapsedMs = options?.maxTimeElapsedMs || parseInt(process.env.SNAPSHOT_MAX_TIME_MS || '3600000', 10); // 1 hour
  }

  /**
   * Evaluates if a document requires compaction based on multi-trigger conditions.
   */
  async checkCompactionRequired(documentId: string): Promise<boolean> {
    try {
      const updates = await this.dbProvider.getUpdates(documentId);
      if (updates.length === 0) return false;

      // 1. Trigger: Update count threshold
      if (updates.length >= this.maxUpdatesCount) {
        logger.info(`Compaction required: ${updates.length} updates accumulated for document ${documentId} (Limit: ${this.maxUpdatesCount})`);
        return true;
      }

      // 2. Trigger: Data size threshold
      const totalSize = updates.reduce((sum, u) => sum + u.byteLength, 0);
      if (totalSize >= this.maxUpdatesSize) {
        logger.info(`Compaction required: Update size is ${totalSize} bytes for document ${documentId} (Limit: ${this.maxUpdatesSize})`);
        return true;
      }

      // 3. Trigger: Time elapsed threshold
      // Use the snapshot's createdAt timestamp to compute actual elapsed time.
      const latestSnapshot = await this.dbProvider.getLatestSnapshot(documentId);
      if (latestSnapshot && latestSnapshot.createdAt) {
        const snapshotAge = Date.now() - new Date(latestSnapshot.createdAt).getTime();
        if (snapshotAge >= this.maxTimeElapsedMs) {
          logger.info(`Compaction required: last snapshot for document ${documentId} is ${Math.round(snapshotAge / 60000)} min old (Limit: ${Math.round(this.maxTimeElapsedMs / 60000)} min)`);
          return true;
        }
      } else if (!latestSnapshot) {
        // No snapshot at all and updates exist → compact now
        logger.info(`Compaction required: no existing snapshot for document ${documentId}`);
        return true;
      }

      return false;
    } catch (err) {
      logger.error(`Failed checking compaction for document ${documentId}`, { error: err });
      return false;
    }
  }

  /**
   * Replays and compacts a document's updates into a single snapshot.
   */
  async compact(documentId: string, activeYDoc?: Y.Doc): Promise<boolean> {
    const lockKey = `lock:snapshot:${documentId}`;
    const ttlMs = 30000; // 30 seconds snapshot lock TTL

    // Acquire distributed lock to prevent multi-server compaction fights
    const lockActained = await this.lockProvider.acquireLock(lockKey, ttlMs);
    if (!lockActained) {
      logger.info(`Compaction lock could not be acquired for document ${documentId}. Skipping.`);
      return false;
    }

    const start = Date.now();
    logger.info(`Compaction lock acquired. Processing snapshot for document: ${documentId}`);

    try {
      // 1. Build consolidated Y.Doc state
      const ydoc = activeYDoc || new Y.Doc();
      
      // Load latest snapshot
      const snapshotRecord = await this.dbProvider.getLatestSnapshot(documentId);
      if (snapshotRecord) {
        Y.applyUpdate(ydoc, snapshotRecord.snapshot);
      }

      // Load and apply incremental updates
      const updates = await this.dbProvider.getUpdates(documentId);
      for (const update of updates) {
        Y.applyUpdate(ydoc, update);
      }

      // 2. Encode full Y.Doc state
      const consolidatedState = Y.encodeStateAsUpdate(ydoc);

      // 3. Save snapshot and clear updates
      await this.dbProvider.saveSnapshot(documentId, consolidatedState, updates.length);
      await this.dbProvider.clearUpdates(documentId);

      const duration = Date.now() - start;
      snapshotCompactionCount.inc({ status: 'success' });
      snapshotDuration.observe(duration / 1000);
      
      logger.info(`Compaction complete for document: ${documentId} in ${duration}ms. Consolidated ${updates.length} updates.`);
      return true;
    } catch (error) {
      snapshotCompactionCount.inc({ status: 'failure' });
      logger.error(`Failed to execute compaction for document ${documentId}`, { error });
      return false;
    } finally {
      // Release distributed lock
      await this.lockProvider.releaseLock(lockKey);
    }
  }
}
