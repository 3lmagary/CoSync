import { DatabaseProvider } from '../database/types';
import { logger } from '../services/logger';

export class AuditLogService {
  private dbProvider: DatabaseProvider;

  constructor(dbProvider: DatabaseProvider) {
    this.dbProvider = dbProvider;
  }

  async log(action: string, meta: { userId?: string; workspaceId?: string; documentId?: string; ipAddress?: string }) {
    try {
      await this.dbProvider.logAuditEvent({
        userId: meta.userId,
        workspaceId: meta.workspaceId,
        documentId: meta.documentId,
        action,
        ipAddress: meta.ipAddress
      });

      logger.info(`Audit Log [${action}]: user=${meta.userId || 'N/A'}, workspace=${meta.workspaceId || 'N/A'}, doc=${meta.documentId || 'N/A'} ip=${meta.ipAddress || 'unknown'}`);
    } catch (err) {
      logger.error('Failed to log audit event in DatabaseProvider', { error: err, action, meta });
    }
  }
}
