import * as Y from 'yjs';
import { DatabaseProvider } from '../database/types';
import { FeatureFlagService } from './FeatureFlagService';
import { logger } from '../services/logger';

export class DocumentManager {
  private dbProvider: DatabaseProvider;
  private maxDocSize: number;

  constructor(dbProvider: DatabaseProvider) {
    this.dbProvider = dbProvider;
    this.maxDocSize = FeatureFlagService.getMaxDocSize();
  }

  /**
   * Checks if a document exists in the metadata table.
   */
  async exists(documentId: string): Promise<boolean> {
    const doc = await this.dbProvider.getDocument(documentId);
    return !!doc;
  }

  /**
   * Explicitly registers a new document in a workspace.
   */
  async createDocument(documentId: string, workspaceId: string, title: string): Promise<any> {
    return await this.dbProvider.createDocument(documentId, workspaceId, title);
  }

  /**
   * Reconstructs the document Y.Doc by loading the latest snapshot and replaying updates.
   */
  async loadDocument(documentId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    
    try {
      logger.info(`Loading document: ${documentId}`);
      
      // 1. Fetch latest consolidated snapshot
      const snapshotRecord = await this.dbProvider.getLatestSnapshot(documentId);
      if (snapshotRecord) {
        logger.debug(`Applying snapshot to document ${documentId} with count: ${snapshotRecord.updateCount}`);
        Y.applyUpdate(doc, snapshotRecord.snapshot);
      }

      // 2. Fetch and apply all incremental updates
      const updates = await this.dbProvider.getUpdates(documentId);
      logger.debug(`Applying ${updates.length} incremental updates to document ${documentId}`);
      
      for (const update of updates) {
        Y.applyUpdate(doc, update);
      }

      // 3. Verify size limits
      this.checkDocumentSize(documentId, doc);

      return doc;
    } catch (error) {
      logger.error(`Failed to load document: ${documentId}`, { error });
      throw error;
    }
  }

  /**
   * Checks the binary size of the Y.Doc state to prevent out-of-memory or database bloat issues.
   */
  checkDocumentSize(documentId: string, doc: Y.Doc): number {
    const stateUpdate = Y.encodeStateAsUpdate(doc);
    const sizeBytes = stateUpdate.byteLength;

    if (sizeBytes > this.maxDocSize) {
      logger.warn(`Document ${documentId} size exceeds maximum limit of ${this.maxDocSize} bytes. Size: ${sizeBytes} bytes.`);
      // In production, we log the violation. Edits that would exceed this threshold can be rejected in ConnectionManager.
    } else if (sizeBytes > this.maxDocSize * 0.8) {
      logger.warn(`Document ${documentId} size is approaching limits. Size: ${sizeBytes} bytes (80%+ threshold).`);
    }

    return sizeBytes;
  }

  /**
   * Helper to verify if applying a new update would violate size limits.
   */
  isUpdateAllowed(doc: Y.Doc, nextUpdate: Uint8Array): boolean {
    // Clone and simulate
    const clone = new Y.Doc();
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(clone, nextUpdate);
    const totalSize = Y.encodeStateAsUpdate(clone).byteLength;
    return totalSize <= this.maxDocSize;
  }
}
