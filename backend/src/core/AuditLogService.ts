import { DatabaseProvider } from '../database/types';
import { logger } from '../services/logger';

export class AuditLogService {
  private dbProvider: DatabaseProvider;

  constructor(dbProvider: DatabaseProvider) {
    this.dbProvider = dbProvider;
  }

  /**
   * Fire-and-forget audit log: never blocks the caller.
   * Errors are silently swallowed and logged only to the logger so the main
   * request path is never disrupted by an audit-log failure.
   */
  log(action: string, meta: { userId?: string; workspaceId?: string; documentId?: string; ipAddress?: string }): void {
    // Intentionally not awaited – this is fire-and-forget
    void this.dbProvider.logAuditEvent({
      userId: meta.userId,
      workspaceId: meta.workspaceId,
      documentId: meta.documentId,
      action,
      ipAddress: meta.ipAddress
    }).then(() => {
      logger.info(`Audit Log [${action}]: user=${meta.userId || 'N/A'}, workspace=${meta.workspaceId || 'N/A'}, doc=${meta.documentId || 'N/A'} ip=${meta.ipAddress || 'unknown'}`);
    }).catch((err) => {
      logger.error('Failed to log audit event in DatabaseProvider', { error: err, action, meta });
    });
  }
}
