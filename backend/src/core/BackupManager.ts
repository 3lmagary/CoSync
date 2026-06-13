import * as fs from 'fs';
import * as path from 'path';
import { DatabaseProvider } from '../database/types';
import { logger } from '../services/logger';

export class BackupManager {
  private dbProvider: DatabaseProvider;
  private backupDir: string;
  private maxBackupRetention: number = 7; // Keep last 7 backups

  constructor(dbProvider: DatabaseProvider, backupDir = './backups') {
    this.dbProvider = dbProvider;
    this.backupDir = backupDir;

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  async runBackup(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.db`;
    const destPath = path.join(this.backupDir, filename);

    logger.info(`Starting database hot backup to: ${destPath}`);
    const start = Date.now();

    try {
      await this.dbProvider.backup(destPath);
      const duration = Date.now() - start;
      logger.info(`Database backup completed successfully in ${duration}ms: ${filename}`);

      // Perform cleanup of older backups
      this.cleanupOldBackups();

      return destPath;
    } catch (error) {
      logger.error('Failed to execute database backup', { error });
      throw error;
    }
  }

  private cleanupOldBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
        .map(f => ({
          name: f,
          path: path.join(this.backupDir, f),
          ctime: fs.statSync(path.join(this.backupDir, f)).ctime.getTime()
        }))
        .sort((a, b) => b.ctime - a.ctime); // Decending: newest first

      if (files.length > this.maxBackupRetention) {
        const toDelete = files.slice(this.maxBackupRetention);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          logger.info(`Deleted obsolete database backup file: ${file.name}`);
        }
      }
    } catch (err) {
      logger.error('Failed to cleanup old backup files', { error: err });
    }
  }

  async restoreBackup(backupFilename: string, currentDbPath: string): Promise<void> {
    const backupPath = path.join(this.backupDir, backupFilename);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file does not exist: ${backupFilename}`);
    }

    logger.info(`Restoring database backup from ${backupPath} to ${currentDbPath}...`);

    try {
      // 1. Close current db connection first
      await this.dbProvider.close();

      // 2. Perform copy
      fs.copyFileSync(backupPath, currentDbPath);
      logger.info('Database backup restore copying complete. Please restart server connection.');
    } catch (error) {
      logger.error('Critical failure during database backup restore', { error });
      throw error;
    }
  }
}
