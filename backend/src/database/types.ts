export interface User {
  id: string;
  username: string;
  passwordHash: string;
  color: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface Document {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
}

export interface DocumentUpdate {
  id: string;
  documentId: string;
  updateData: Buffer;
  createdAt: string;
}

export interface DocumentSnapshot {
  id: string;
  documentId: string;
  snapshotData: Buffer;
  updateCount: number;
  createdAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  snapshot: Uint8Array;
  versionNumber: number;
  createdBy?: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId?: string;
  workspaceId?: string;
  documentId?: string;
  action: string;
  ipAddress?: string;
  timestamp: string;
}

export interface DatabaseProvider {
  // User operations
  createUser(id: string, username: string, passwordHash: string, color: string): Promise<User>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;

  // Workspace operations
  createWorkspace(id: string, name: string, ownerId: string): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  getWorkspacesByOwner(ownerId: string): Promise<Workspace[]>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  addWorkspaceMember(workspaceId: string, username: string): Promise<User>;
  addWorkspaceMemberById(workspaceId: string, userId: string): Promise<void>;
  isWorkspaceMemberOrOwner(workspaceId: string, userId: string): Promise<boolean>;
  getOrCreateWorkspaceInvite(workspaceId: string): Promise<string>;
  getWorkspaceIdByInviteToken(token: string): Promise<string | null>;

  // Document operations
  createDocument(id: string, workspaceId: string, title: string): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  getWorkspaceDocs(workspaceId: string): Promise<Document[]>;
  deleteDocument(documentId: string): Promise<void>;
  renameDocument(documentId: string, title: string): Promise<void>;

  // Yjs Sync operations
  saveUpdate(documentId: string, update: Uint8Array): Promise<void>;
  saveUpdatesBatch(documentId: string, updates: Uint8Array[]): Promise<void>;
  getUpdates(documentId: string): Promise<Uint8Array[]>;
  clearUpdates(documentId: string): Promise<void>;

  // Snapshot operations
  saveSnapshot(documentId: string, snapshot: Uint8Array, updateCount: number): Promise<void>;
  getLatestSnapshot(documentId: string): Promise<{ snapshot: Uint8Array; updateCount: number } | null>;

  // Version operations
  createVersion(documentId: string, snapshot: Uint8Array, versionNumber: number, createdBy?: string): Promise<DocumentVersion>;
  listVersions(documentId: string): Promise<DocumentVersion[]>;

  // Audit logging operations
  logAuditEvent(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void>;

  // Lifecycle
  backup(destPath: string): Promise<void>;
  close(): Promise<void>;
}
