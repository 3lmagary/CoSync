import * as fs from 'fs';
import * as path from 'path';
import { DatabaseProvider } from '../database/types';
import { logger } from '../services/logger';
import { persistenceQueueLength, batchWriteDuration } from '../services/metrics';

export class PersistenceManager {
  private dbProvider: DatabaseProvider;
  private walDir: string;
  private queue: Map<string, Uint8Array[]> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  
  // Configurations
  private flushIntervalMs = 1000; // Flush queue every 1s
  private maxBatchSize = 100;      // Or when we hit 100 updates
  private maxRetries = 3;

  constructor(dbProvider: DatabaseProvider, walDir = './wal') {
    this.dbProvider = dbProvider;
    this.walDir = walDir;

    if (!fs.existsSync(this.walDir)) {
      fs.mkdirSync(this.walDir, { recursive: true });
    }

    this.startFlushInterval();
  }

  /**
   * Scans the WAL directory on boot and replays any updates that were not flushed before a crash.
   */
  async recoverWAL(): Promise<void> {
    try {
      if (!fs.existsSync(this.walDir)) return;
      const files = fs.readdirSync(this.walDir).filter(f => f.endsWith('.log'));
      if (files.length === 0) {
        logger.info('No WAL recovery logs found. Clean startup.');
        return;
      }

      logger.info(`Found ${files.length} WAL log files. Starting crash recovery...`);
      for (const file of files) {
        const documentId = path.basename(file, '.log');
        const filePath = path.join(this.walDir, file);
        
        try {
          const doc = await this.dbProvider.getDocument(documentId);
          if (!doc) {
            logger.info(`WAL document ${documentId} no longer exists in DB. Cleaning up WAL file.`);
            fs.unlinkSync(filePath);
            continue;
          }

          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(line => line.trim().length > 0);
          
          if (lines.length > 0) {
            const updates = lines.map(line => new Uint8Array(Buffer.from(line, 'base64')));
            logger.info(`Replaying ${updates.length} pending updates for document ${documentId}...`);
            await this.dbProvider.saveUpdatesBatch(documentId, updates);
          }
          
          fs.unlinkSync(filePath);
          logger.info(`Recovered and cleaned up WAL for document: ${documentId}`);
        } catch (fileError) {
          logger.error(`Failed to recover WAL file ${file}`, { error: fileError });
        }
      }
      logger.info('WAL crash recovery process finished.');
    } catch (error) {
      logger.error('Error in WAL recovery process', { error });
    }
  }

  /**
   * Intercepts updates, logs them to WAL, and registers them in the in-memory queue.
   */
  async appendUpdate(documentId: string, update: Uint8Array): Promise<void> {
    // 1. Append to WAL file immediately for durabilty
    const walPath = path.join(this.walDir, `${documentId}.log`);
    const base64Update = Buffer.from(update).toString('base64') + '\n';
    
    try {
      fs.appendFileSync(walPath, base64Update);
    } catch (err) {
      logger.error(`CRITICAL: Failed to write to WAL file for document ${documentId}`, { error: err });
      throw new Error(`WAL Write Failure: ${err}`);
    }

    // 2. Queue in memory
    if (!this.queue.has(documentId)) {
      this.queue.set(documentId, []);
    }
    const docQueue = this.queue.get(documentId)!;
    docQueue.push(update);

    // Update Prometheus Metric
    persistenceQueueLength.set({ doc_id: documentId }, docQueue.length);

    // 3. Batch boundary check
    if (docQueue.length >= this.maxBatchSize) {
      await this.flushDocument(documentId);
    }
  }

  /**
   * Flushes a specific document's queue to SQLite.
   */
  async flushDocument(documentId: string): Promise<void> {
    const docQueue = this.queue.get(documentId);
    if (!docQueue || docQueue.length === 0) return;

    // Slice queue atomically to avoid race conditions during async DB operations
    const batch = docQueue.slice();
    this.queue.set(documentId, []);
    persistenceQueueLength.set({ doc_id: documentId }, 0);

    const start = Date.now();
    let attempt = 0;

    while (attempt < this.maxRetries) {
      try {
        await this.dbProvider.saveUpdatesBatch(documentId, batch);
        
        // Clean up WAL file upon successful commit
        const walPath = path.join(this.walDir, `${documentId}.log`);
        if (fs.existsSync(walPath)) {
          fs.unlinkSync(walPath);
        }

        const duration = (Date.now() - start) / 1000;
        batchWriteDuration.observe(duration);
        logger.debug(`Flushed ${batch.length} updates for doc ${documentId} to DB in ${duration * 1000}ms`);
        return;
      } catch (dbError) {
        attempt++;
        logger.warn(`Database write attempt ${attempt} failed for doc ${documentId}. Retrying...`, { error: dbError });
        if (attempt >= this.maxRetries) {
          logger.error(`CRITICAL: Failed to flush updates for doc ${documentId} after ${this.maxRetries} attempts. Restoring queue.`, { error: dbError });
          // Restore sliced updates back to the head of the queue so they aren't lost
          const currentQueue = this.queue.get(documentId) || [];
          this.queue.set(documentId, [...batch, ...currentQueue]);
          persistenceQueueLength.set({ doc_id: documentId }, this.queue.get(documentId)!.length);
        } else {
          // Linear backoff before retry
          await new Promise(resolve => setTimeout(resolve, attempt * 200));
        }
      }
    }
  }

  /**
   * Periodically flushes all document queues.
   */
  private startFlushInterval() {
    this.flushTimer = setInterval(async () => {
      const docIds = Array.from(this.queue.keys());
      for (const docId of docIds) {
        await this.flushDocument(docId);
      }
    }, this.flushIntervalMs);
  }

  /**
   * Flushes all remaining updates and cleans up timers on server shutdown.
   */
  async forceShutdown(): Promise<void> {
    logger.info('Shutting down PersistenceManager: flushing all queues to database...');
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const docIds = Array.from(this.queue.keys());
    for (const docId of docIds) {
      try {
        await this.flushDocument(docId);
      } catch (err) {
        logger.error(`Failed to flush document ${docId} during shutdown`, { error: err });
      }
    }
    logger.info('PersistenceManager shutdown completed successfully.');
  }

  // Exposed for testing
  getQueueLength(documentId: string): number {
    return this.queue.get(documentId)?.length || 0;
  }
}
