import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseProvider, User, Workspace, Document, DocumentVersion, AuditLog } from './types';
import { generateSecureId, generateSecureToken } from '../services/crypto';

export class SQLiteDatabaseProvider implements DatabaseProvider {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath, { verbose: undefined });
    
    // Hardening configurations for SQLite
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000'); // 5 seconds retry block before failure

    this.initializeSchema();
  }

  private initializeSchema() {
    // Embed the schema SQL statements directly to ensure runtime safety in any execution environment
    const schemaSql = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

      CREATE TABLE IF NOT EXISTS workspace_invites (
        workspace_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(workspace_id, title);

      CREATE TABLE IF NOT EXISTS document_updates (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        update_data BLOB NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_document_updates_doc ON document_updates(document_id);

      CREATE TABLE IF NOT EXISTS document_snapshots (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL UNIQUE,
        snapshot_data BLOB NOT NULL,
        update_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_document_snapshots_doc ON document_snapshots(document_id);

      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        snapshot BLOB NOT NULL,
        version_number INTEGER NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(document_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_versions_num ON document_versions(document_id, version_number);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        workspace_id TEXT,
        document_id TEXT,
        action TEXT NOT NULL,
        ip_address TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_doc ON audit_logs(document_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(timestamp);
    `;

    this.db.exec(schemaSql);
  }

  // --- User operations ---

  async createUser(id: string, username: string, passwordHash: string, color: string): Promise<User> {
    const stmt = this.db.prepare(
      `INSERT INTO users (id, username, password_hash, color) 
       VALUES (?, ?, ?, ?) 
       RETURNING id, username, password_hash AS passwordHash, color, created_at AS createdAt`
    );
    const result = stmt.get(id, username, passwordHash, color) as any;
    return {
      id: result.id,
      username: result.username,
      passwordHash: result.passwordHash,
      color: result.color,
      createdAt: result.createdAt,
    };
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const stmt = this.db.prepare(
      `SELECT id, username, password_hash AS passwordHash, color, created_at AS createdAt 
       FROM users WHERE username = ?`
    );
    const row = stmt.get(username) as any;
    return row || null;
  }

  async getUserById(id: string): Promise<User | null> {
    const stmt = this.db.prepare(
      `SELECT id, username, password_hash AS passwordHash, color, created_at AS createdAt 
       FROM users WHERE id = ?`
    );
    const row = stmt.get(id) as any;
    return row || null;
  }

  // --- Workspace operations ---

  async createWorkspace(id: string, name: string, ownerId: string): Promise<Workspace> {
    const stmt = this.db.prepare(
      `INSERT INTO workspaces (id, name, owner_id) 
       VALUES (?, ?, ?) 
       RETURNING id, name, owner_id AS ownerId, created_at AS createdAt`
    );
    const result = stmt.get(id, name, ownerId) as any;
    return result;
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const stmt = this.db.prepare(
      `SELECT id, name, owner_id AS ownerId, created_at AS createdAt 
       FROM workspaces WHERE id = ?`
    );
    const row = stmt.get(id) as any;
    return row || null;
  }

  async getWorkspacesByOwner(ownerId: string): Promise<Workspace[]> {
    const stmt = this.db.prepare(
      `SELECT w.id, w.name, w.owner_id AS ownerId, w.created_at AS createdAt 
       FROM workspaces w
       LEFT JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE w.owner_id = ? OR wm.user_id = ?
       GROUP BY w.id`
    );
    return stmt.all(ownerId, ownerId) as Workspace[];
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM workspaces WHERE id = ?');
    stmt.run(workspaceId);
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?');
    stmt.run(name, workspaceId);
  }

  async addWorkspaceMember(workspaceId: string, username: string): Promise<User> {
    const userStmt = this.db.prepare(
      'SELECT id, username, password_hash AS passwordHash, color, created_at AS createdAt FROM users WHERE username = ?'
    );
    const user = userStmt.get(username) as any;
    if (!user) {
      throw new Error(`User not found: ${username}`);
    }

    const checkStmt = this.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?');
    const existing = checkStmt.get(workspaceId, user.id);
    if (!existing) {
      const insertStmt = this.db.prepare('INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?)');
      insertStmt.run(workspaceId, user.id);
    }
    return user;
  }

  async isWorkspaceMemberOrOwner(workspaceId: string, userId: string): Promise<boolean> {
    const ws = await this.getWorkspace(workspaceId);
    if (!ws) return false;
    if (ws.ownerId === userId) return true;

    const stmt = this.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?');
    const row = stmt.get(workspaceId, userId);
    return !!row;
  }

  async addWorkspaceMemberById(workspaceId: string, userId: string): Promise<void> {
    const checkStmt = this.db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?');
    const existing = checkStmt.get(workspaceId, userId);
    if (!existing) {
      const insertStmt = this.db.prepare('INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?)');
      insertStmt.run(workspaceId, userId);
    }
  }

  async getOrCreateWorkspaceInvite(workspaceId: string): Promise<string> {
    const getStmt = this.db.prepare('SELECT token FROM workspace_invites WHERE workspace_id = ?');
    const row = getStmt.get(workspaceId) as { token: string } | undefined;
    if (row) {
      return row.token;
    }
    const token = generateSecureToken('inv');
    const insertStmt = this.db.prepare('INSERT INTO workspace_invites (workspace_id, token) VALUES (?, ?)');
    insertStmt.run(workspaceId, token);
    return token;
  }

  async getWorkspaceIdByInviteToken(token: string): Promise<string | null> {
    const stmt = this.db.prepare('SELECT workspace_id AS workspaceId FROM workspace_invites WHERE token = ?');
    const row = stmt.get(token) as { workspaceId: string } | undefined;
    return row ? row.workspaceId : null;
  }

  // --- Document operations ---

  async createDocument(id: string, workspaceId: string, title: string): Promise<Document> {
    const stmt = this.db.prepare(
      `INSERT INTO documents (id, workspace_id, title) 
       VALUES (?, ?, ?) 
       RETURNING id, workspace_id AS workspaceId, title, created_at AS createdAt`
    );
    const result = stmt.get(id, workspaceId, title) as any;
    return result;
  }

  async getDocument(id: string): Promise<Document | null> {
    const stmt = this.db.prepare(
      `SELECT id, workspace_id AS workspaceId, title, created_at AS createdAt 
       FROM documents WHERE id = ?`
    );
    const row = stmt.get(id) as any;
    return row || null;
  }

  async getWorkspaceDocs(workspaceId: string): Promise<Document[]> {
    const stmt = this.db.prepare(
      `SELECT id, workspace_id AS workspaceId, title, created_at AS createdAt 
       FROM documents WHERE workspace_id = ?`
    );
    return stmt.all(workspaceId) as Document[];
  }

  async deleteDocument(documentId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(documentId);
  }

  async renameDocument(documentId: string, title: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE documents SET title = ? WHERE id = ?');
    stmt.run(title, documentId);
  }

  // --- Yjs Sync operations ---

  async saveUpdate(documentId: string, update: Uint8Array): Promise<void> {
    const id = generateSecureId();
    const stmt = this.db.prepare(
      `INSERT INTO document_updates (id, document_id, update_data) VALUES (?, ?, ?)`
    );
    // Bind Uint8Array as Buffer for better-sqlite3 blob type
    stmt.run(id, documentId, Buffer.from(update));
  }

  async saveUpdatesBatch(documentId: string, updates: Uint8Array[]): Promise<void> {
    if (updates.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO document_updates (id, document_id, update_data) VALUES (?, ?, ?)`
    );
    const runTransaction = this.db.transaction((batch: Uint8Array[]) => {
      for (const update of batch) {
        const id = generateSecureId();
        stmt.run(id, documentId, Buffer.from(update));
      }
    });
    runTransaction(updates);
  }

  async getUpdates(documentId: string): Promise<Uint8Array[]> {
    const stmt = this.db.prepare(
      `SELECT update_data FROM document_updates WHERE document_id = ? ORDER BY rowid ASC`
    );
    const rows = stmt.all(documentId) as Array<{ update_data: Buffer }>;
    return rows.map(r => new Uint8Array(r.update_data));
  }

  async clearUpdates(documentId: string): Promise<void> {
    const stmt = this.db.prepare(
      `DELETE FROM document_updates WHERE document_id = ?`
    );
    stmt.run(documentId);
  }

  // --- Snapshot operations ---

  async saveSnapshot(documentId: string, snapshot: Uint8Array, updateCount: number): Promise<void> {
    const id = generateSecureId();
    const stmt = this.db.prepare(
      `INSERT INTO document_snapshots (id, document_id, snapshot_data, update_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET 
         snapshot_data = excluded.snapshot_data,
         update_count = excluded.update_count,
         created_at = CURRENT_TIMESTAMP`
    );
    stmt.run(id, documentId, Buffer.from(snapshot), updateCount);
  }

  async getLatestSnapshot(documentId: string): Promise<{ snapshot: Uint8Array; updateCount: number; createdAt: string | null } | null> {
    const stmt = this.db.prepare(
      `SELECT snapshot_data AS snapshot, update_count AS updateCount, created_at AS createdAt
       FROM document_snapshots WHERE document_id = ?`
    );
    const row = stmt.get(documentId) as any;
    if (!row) return null;
    return {
      snapshot: new Uint8Array(row.snapshot),
      updateCount: row.updateCount,
      createdAt: row.createdAt ?? null,
    };
  }

  // --- Version operations ---

  async createVersion(documentId: string, snapshot: Uint8Array, versionNumber: number, createdBy?: string): Promise<DocumentVersion> {
    const id = generateSecureId();
    const stmt = this.db.prepare(
      `INSERT INTO document_versions (id, document_id, snapshot, version_number, created_by)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, document_id AS documentId, snapshot, version_number AS versionNumber, created_by AS createdBy, created_at AS createdAt`
    );
    const result = stmt.get(id, documentId, Buffer.from(snapshot), versionNumber, createdBy || null) as any;
    return {
      id: result.id,
      documentId: result.documentId,
      snapshot: result.snapshot,
      versionNumber: result.versionNumber,
      createdBy: result.createdBy,
      createdAt: result.createdAt,
    };
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    const stmt = this.db.prepare(
      `SELECT id, document_id AS documentId, snapshot, version_number AS versionNumber, created_by AS createdBy, created_at AS createdAt
       FROM document_versions WHERE document_id = ? ORDER BY version_number DESC`
    );
    const rows = stmt.all(documentId) as any[];
    return rows.map(r => ({
      id: r.id,
      documentId: r.documentId,
      snapshot: new Uint8Array(r.snapshot),
      versionNumber: r.versionNumber,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    }));
  }

  // --- Audit logging operations ---

  async logAuditEvent(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> {
    const id = generateSecureId();
    const stmt = this.db.prepare(
      `INSERT INTO audit_logs (id, user_id, workspace_id, document_id, action, ip_address) 
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, log.userId || null, log.workspaceId || null, log.documentId || null, log.action, log.ipAddress || null);
  }

  // --- Audit log maintenance ---

  async pruneAuditLogsOlderThanDays(days: number): Promise<number> {
    if (days <= 0) return 0;
    const stmt = this.db.prepare(
      `DELETE FROM audit_logs WHERE timestamp < datetime('now', ?)`
    );
    const info = stmt.run(`-${days} days`);
    return info.changes;
  }

  // --- Lifecycle ---

  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
