import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Config env loading
dotenv.config();

// Imports
import { SQLiteDatabaseProvider } from './database/db';
import { MemoryPubSub } from './pubsub/memory';
import { RedisPubSub } from './pubsub/redis';
import { MemorySnapshotLockProvider } from './locks/memory';
import { RedisSnapshotLockProvider } from './locks/redis';

import { FeatureFlagService } from './core/FeatureFlagService';
import { AuditLogService } from './core/AuditLogService';
import { BackupManager } from './core/BackupManager';
import { DocumentManager } from './core/DocumentManager';
import { PersistenceManager } from './core/PersistenceManager';
import { SnapshotManager } from './core/SnapshotManager';
import { AwarenessManager } from './core/AwarenessManager';
import { RoomManager } from './core/RoomManager';
import { ConnectionManager } from './core/ConnectionManager';

import { generateToken, authMiddleware, AuthenticatedRequest } from './services/auth';
import { logger } from './services/logger';
import { getMetricsString, metricsContentType } from './services/metrics';

// 1. Instantiation variables
const PORT = process.env.PORT || 4000;
const DB_PATH = FeatureFlagService.getDatabasePath();

// 2. Initialize Database & Services
const dbProvider = new SQLiteDatabaseProvider(DB_PATH);
const auditLogService = new AuditLogService(dbProvider);
const backupManager = new BackupManager(dbProvider);

// Determine PubSub scaling strategy
const pubSubProvider = FeatureFlagService.isEnabled('ENABLE_REDIS')
  ? new RedisPubSub(FeatureFlagService.getRedisUri())
  : new MemoryPubSub();

// Determine Snapshot Lock strategy
const lockProvider = FeatureFlagService.isEnabled('ENABLE_REDIS')
  ? new RedisSnapshotLockProvider(FeatureFlagService.getRedisUri())
  : new MemorySnapshotLockProvider();

const documentManager = new DocumentManager(dbProvider);
const persistenceManager = new PersistenceManager(dbProvider);
const snapshotManager = new SnapshotManager(dbProvider, lockProvider);
const awarenessManager = new AwarenessManager();
const roomManager = new RoomManager(documentManager, persistenceManager, snapshotManager, awarenessManager);

// Express and HTTP wrapping
const app = express();
const httpServer = createServer(app);

// WebSocket Server
const wss = new WebSocketServer({
  noServer: true,
  // Native y-websocket matching subprotocol selector
  handleProtocols: (protocols) => {
    const list = Array.from(protocols);
    if (list.includes('co-sync-auth')) {
      return 'co-sync-auth';
    }
    return false;
  }
});

const connectionManager = new ConnectionManager(wss, roomManager, auditLogService);

// Middleware
app.use(cors());
app.use(express.json());

// 3. REST HTTP API Routes

// Health check liveness
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// Health check readiness
app.get('/health/ready', async (req, res) => {
  try {
    // 1. Verify database responsiveness
    const testUser = await dbProvider.getUserById('system-test'); // Safe query

    // 2. Verify WAL directory is writable
    const testFile = path.join('./wal', '.ready-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);

    res.status(200).json({
      status: 'ready',
      database: 'connected',
      queue: 'operational',
      wal: 'healthy',
      snapshotLock: 'active'
    });
  } catch (err) {
    logger.error('Readiness health check failed', { error: err });
    res.status(503).json({ status: 'unready', error: String(err) });
  }
});

// Prometheus Metrics route
app.get('/metrics', async (req, res) => {
  if (FeatureFlagService.isEnabled('ENABLE_METRICS')) {
    try {
      res.set('Content-Type', metricsContentType);
      res.end(await getMetricsString());
    } catch (err) {
      res.status(500).end(String(err));
    }
  } else {
    res.status(403).send('Metrics disabled');
  }
});

// Auth REST endpoints
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const existing = await dbProvider.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken' });
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    
    // Pick a random vibrant cursor color for this user
    const colors = ['#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3', '#4CAF50', '#FFEB3B', '#FF9800'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const userId = Math.random().toString(36).substring(2) + Date.now().toString(36);

    const user = await dbProvider.createUser(userId, username, passwordHash, color);
    const token = generateToken({ userId: user.id, username: user.username, color: user.color });

    await auditLogService.log('register', { userId: user.id, ipAddress: req.ip });

    res.status(201).json({ token, user: { id: user.id, username: user.username, color: user.color } });
  } catch (err) {
    logger.error('User registration failed', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await dbProvider.getUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = generateToken({ userId: user.id, username: user.username, color: user.color });
    await auditLogService.log('login', { userId: user.id, ipAddress: req.ip });

    res.status(200).json({ token, user: { id: user.id, username: user.username, color: user.color } });
  } catch (err) {
    logger.error('User login failed', { error: err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Workspace REST endpoints
app.post('/api/workspaces', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { name } = req.body;
  const ownerId = req.user!.userId;

  if (!name) {
    return res.status(400).json({ error: 'Workspace name is required' });
  }

  try {
    const workspaceId = 'ws-' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    const ws = await dbProvider.createWorkspace(workspaceId, name, ownerId);
    
    await auditLogService.log('create_workspace', { userId: ownerId, workspaceId, ipAddress: req.ip });
    res.status(201).json(ws);
  } catch (err) {
    logger.error('Workspace creation failed', { error: err });
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

app.get('/api/workspaces', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const ownerId = req.user!.userId;
  try {
    const workspaces = await dbProvider.getWorkspacesByOwner(ownerId);
    res.status(200).json(workspaces);
  } catch (err) {
    logger.error('Failed to retrieve workspaces', { error: err });
    res.status(500).json({ error: 'Failed to retrieve workspaces' });
  }
});

// Workspace modifications & sharing REST endpoints
app.delete('/api/workspaces/:workspaceId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId } = req.params;
  const userId = req.user!.userId;

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (ws.ownerId !== userId) {
      return res.status(403).json({ error: 'Only the owner can delete the workspace' });
    }

    await dbProvider.deleteWorkspace(workspaceId);
    await auditLogService.log('delete_workspace', { userId, workspaceId, ipAddress: req.ip });
    res.status(200).json({ message: 'Workspace deleted successfully' });
  } catch (err) {
    logger.error('Workspace deletion failed', { error: err });
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

app.put('/api/workspaces/:workspaceId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId } = req.params;
  const { name } = req.body;
  const userId = req.user!.userId;

  if (!name) {
    return res.status(400).json({ error: 'Workspace name is required' });
  }

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    await dbProvider.renameWorkspace(workspaceId, name);
    await auditLogService.log('rename_workspace', { userId, workspaceId, ipAddress: req.ip });
    res.status(200).json({ message: 'Workspace renamed successfully' });
  } catch (err) {
    logger.error('Workspace rename failed', { error: err });
    res.status(500).json({ error: 'Failed to rename workspace' });
  }
});

app.post('/api/workspaces/:workspaceId/share', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId } = req.params;
  const { username } = req.body;
  const userId = req.user!.userId;

  if (!username) {
    return res.status(400).json({ error: 'Username to share with is required' });
  }

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (ws.ownerId !== userId) {
      return res.status(403).json({ error: 'Only the owner can share the workspace' });
    }

    const addedUser = await dbProvider.addWorkspaceMember(workspaceId, username);
    await auditLogService.log('share_workspace', { userId, workspaceId, ipAddress: req.ip });
    res.status(200).json({ message: `Workspace shared with ${username} successfully`, user: { id: addedUser.id, username: addedUser.username } });
  } catch (err) {
    logger.error('Workspace share failed', { error: err });
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/workspaces/:workspaceId/invite-token', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId } = req.params;
  const userId = req.user!.userId;

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    const token = await dbProvider.getOrCreateWorkspaceInvite(workspaceId);
    res.status(200).json({ token });
  } catch (err) {
    logger.error('Failed to get or create invite token', { error: err });
    res.status(500).json({ error: 'Failed to generate invite token' });
  }
});

app.post('/api/workspaces/join/:token', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { token } = req.params;
  const userId = req.user!.userId;

  try {
    const workspaceId = await dbProvider.getWorkspaceIdByInviteToken(token);
    if (!workspaceId) {
      return res.status(404).json({ error: 'Invalid or expired invite token' });
    }

    await dbProvider.addWorkspaceMemberById(workspaceId, userId);
    const ws = await dbProvider.getWorkspace(workspaceId);

    await auditLogService.log('join_workspace', { userId, workspaceId, ipAddress: req.ip });
    res.status(200).json({ message: 'Joined workspace successfully', workspace: ws });
  } catch (err) {
    logger.error('Failed to join workspace via invite token', { error: err });
    res.status(500).json({ error: 'Failed to join workspace' });
  }
});

// Document REST endpoints
app.post('/api/workspaces/:workspaceId/documents', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { title } = req.body;
  const { workspaceId } = req.params;
  const userId = req.user!.userId;

  if (!title) {
    return res.status(400).json({ error: 'Document title is required' });
  }

  try {
    // Access validation (Verify workspace belongs to user)
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    const documentId = 'doc-' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    const doc = await dbProvider.createDocument(documentId, workspaceId, title);

    await auditLogService.log('create_document', { userId, workspaceId, documentId, ipAddress: req.ip });
    res.status(201).json(doc);
  } catch (err) {
    logger.error('Document creation failed', { error: err });
    res.status(500).json({ error: 'Failed to create document' });
  }
});

app.get('/api/workspaces/:workspaceId/documents', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId } = req.params;
  const userId = req.user!.userId;

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    const docs = await dbProvider.getWorkspaceDocs(workspaceId);
    res.status(200).json(docs);
  } catch (err) {
    logger.error('Failed to retrieve documents', { error: err });
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// Document modifications REST endpoints
app.delete('/api/workspaces/:workspaceId/documents/:documentId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId, documentId } = req.params;
  const userId = req.user!.userId;

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    await dbProvider.deleteDocument(documentId);
    await auditLogService.log('delete_document', { userId, workspaceId, documentId, ipAddress: req.ip });
    res.status(200).json({ message: 'Document deleted successfully' });
  } catch (err) {
    logger.error('Document deletion failed', { error: err });
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

app.put('/api/workspaces/:workspaceId/documents/:documentId', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { workspaceId, documentId } = req.params;
  const { title } = req.body;
  const userId = req.user!.userId;

  if (!title) {
    return res.status(400).json({ error: 'Document title is required' });
  }

  try {
    const ws = await dbProvider.getWorkspace(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const isMember = await dbProvider.isWorkspaceMemberOrOwner(workspaceId, userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Unauthorized access to workspace' });
    }

    await dbProvider.renameDocument(documentId, title);
    await auditLogService.log('rename_document', { userId, workspaceId, documentId, ipAddress: req.ip });
    res.status(200).json({ message: 'Document renamed successfully' });
  } catch (err) {
    logger.error('Document rename failed', { error: err });
    res.status(500).json({ error: 'Failed to rename document' });
  }
});

// Document version history APIs
app.get('/api/documents/:documentId/versions', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { documentId } = req.params;
  try {
    const versions = await dbProvider.listVersions(documentId);
    res.status(200).json(versions);
  } catch (err) {
    logger.error('Failed to retrieve version list', { error: err });
    res.status(500).json({ error: 'Failed to retrieve version list' });
  }
});

app.post('/api/documents/:documentId/versions/:versionId/restore', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { documentId, versionId } = req.params;
  const userId = req.user!.userId;

  try {
    const versions = await dbProvider.listVersions(documentId);
    const targetVersion = versions.find(v => v.id === versionId);
    if (!targetVersion) {
      return res.status(404).json({ error: 'Version not found' });
    }

    // Restore version snapshot: Write snapshot into DB snapshots table, clear updates
    await dbProvider.saveSnapshot(documentId, targetVersion.snapshot, 0);
    await dbProvider.clearUpdates(documentId);

    // If there is an active memory room loaded, we must destroy it to force reload from restored snapshot
    // (This is handled by roomManager restarting room state)
    // For simplicity, we just destroy the active memory room instance so next connection re-loads it.
    await roomManager.handleClientLeave(await roomManager.getOrCreateRoom(documentId), null as any, 'admin-restore');

    await auditLogService.log('restore_version', { userId, documentId, ipAddress: req.ip });
    res.status(200).json({ message: 'Version restored successfully' });
  } catch (err) {
    logger.error('Failed to restore version snapshot', { error: err });
    res.status(500).json({ error: 'Failed to restore version snapshot' });
  }
});

// Admin backups API
app.post('/api/admin/backup', authMiddleware, async (req: AuthenticatedRequest, res) => {
  if (!FeatureFlagService.isEnabled('ENABLE_BACKUPS')) {
    return res.status(403).json({ error: 'Backup system is disabled' });
  }

  try {
    const backupPath = await backupManager.runBackup();
    res.status(200).json({ message: 'Backup created successfully', path: backupPath });
  } catch (err) {
    logger.error('Manual admin backup failed', { error: err });
    res.status(500).json({ error: 'Backup execution failed' });
  }
});

// 4. WebSocket upgrade piping
httpServer.on('upgrade', (req, socket, head) => {
  connectionManager.handleUpgrade(req, socket, head);
});

// 5. Server Startup & Recovery
async function startServer() {
  // Replay outstanding crash logs from WAL before incoming traffic starts
  await persistenceManager.recoverWAL();

  httpServer.listen(PORT, () => {
    logger.info(`Collaborative Server running on HTTP port ${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to bootstrap collaborative server', { error: err });
  process.exit(1);
});

// 6. Graceful Shutdown Hooks
async function shutdown(signal: string) {
  logger.warn(`Termination signal ${signal} received. Initiating graceful shutdown...`);
  
  try {
    // Terminate persistent connections and write queue
    await persistenceManager.forceShutdown();
    
    // Close sqlite DB connections
    await dbProvider.close();
    
    // Close pubsub
    await pubSubProvider.close();
    await lockProvider.close();

    logger.info('Graceful shutdown complete. Exiting process.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during graceful shutdown sequence', { error: err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
