import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as path from 'path';
import * as fs from 'fs';

import { SQLiteDatabaseProvider } from '../database/db';
import { MemoryPubSub } from '../pubsub/memory';
import { MemorySnapshotLockProvider } from '../locks/memory';
import { DocumentManager } from '../core/DocumentManager';
import { PersistenceManager } from '../core/PersistenceManager';
import { SnapshotManager } from '../core/SnapshotManager';
import { AwarenessManager } from '../core/AwarenessManager';
import { RoomManager } from '../core/RoomManager';
import { ConnectionManager } from '../core/ConnectionManager';
import { generateToken } from '../services/auth';
import { AuditLogService } from '../core/AuditLogService';

const TEST_PORT = 5001;
const TEST_DB_PATH = './data/test-sync.db';
const TEST_WAL_DIR = './wal-test';

describe('Collaborative Sync Platform - Core Integration Tests', () => {
  let server: Server;
  let wss: WebSocketServer;
  let db: SQLiteDatabaseProvider;
  let roomManager: RoomManager;
  let connectionManager: ConnectionManager;
  let persistenceManager: PersistenceManager;
  let snapshotManager: SnapshotManager;
  let testToken: string;
  let testUser = { id: 'u-test-123', username: 'Ahmed', color: '#4CAF50' };

  beforeAll(async () => {
    // Ensure clean test folders
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_WAL_DIR)) fs.rmSync(TEST_WAL_DIR, { recursive: true, force: true });

    db = new SQLiteDatabaseProvider(TEST_DB_PATH);
    
    // Create test user, workspace and documents in DB to satisfy foreign key constraints
    await db.createUser(testUser.id, testUser.username, 'hash', testUser.color);
    await db.createWorkspace('ws1', 'Test Workspace', testUser.id);
    await db.createDocument('doc1', 'ws1', 'Doc 1');
    await db.createDocument('doc2', 'ws1', 'Doc 2');
    await db.createDocument('doc3', 'ws1', 'Doc 3');
    await db.createDocument('doc4', 'ws1', 'Doc 4');
    await db.createDocument('docA', 'ws1', 'Doc A');
    await db.createDocument('docB', 'ws1', 'Doc B');
    await db.createDocument('doc-comp-test', 'ws1', 'Doc Comp Test');

    const auditLogService = new AuditLogService(db);
    persistenceManager = new PersistenceManager(db, TEST_WAL_DIR);
    snapshotManager = new SnapshotManager(db, new MemorySnapshotLockProvider());
    const documentManager = new DocumentManager(db);
    const awarenessManager = new AwarenessManager();
    roomManager = new RoomManager(documentManager, persistenceManager, snapshotManager, awarenessManager);

    server = createServer();
    wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        const list = Array.from(protocols);
        if (list.includes('co-sync-auth')) return 'co-sync-auth';
        return false;
      }
    });

    connectionManager = new ConnectionManager(wss, roomManager, auditLogService);
    
    server.on('upgrade', (req, socket, head) => {
      connectionManager.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });

    testToken = generateToken({ userId: testUser.id, username: testUser.username, color: testUser.color });
  });

  afterAll(async () => {
    await persistenceManager.forceShutdown();
    await db.close();
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Clean up files
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(TEST_WAL_DIR)) fs.rmSync(TEST_WAL_DIR, { recursive: true, force: true });
      
      const logsDir = path.join(process.cwd(), 'logs');
      if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('1. Authentication rejection - socket closes without token', async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/workspace/ws1/doc/doc1`);
    
    const wasRejected = await new Promise<boolean>((resolve) => {
      ws.on('close', (code) => {
        // Closed due to lack of auth header protocols
        resolve(true);
      });
      ws.on('open', () => {
        resolve(false);
      });
      ws.on('error', () => {
        // ws library emits error on 401 response status code
        resolve(true);
      });
    });

    expect(wasRejected).toBe(true);
  });

  it('2. Two users editing simultaneously converges states', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc2', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc2', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    // Wait for connection to open
    await Promise.all([
      new Promise<void>((resolve) => providerA.on('status', ({ status }) => { if (status === 'connected') resolve(); })),
      new Promise<void>((resolve) => providerB.on('status', ({ status }) => { if (status === 'connected') resolve(); }))
    ]);

    // Apply concurrent changes
    docA.getText('codemirror').insert(0, 'Hello ');
    docB.getText('codemirror').insert(0, 'World');

    // Wait for changes to sync
    await new Promise<void>(resolve => setTimeout(resolve, 800));

    expect(docA.getText('codemirror').toString()).toBe(docB.getText('codemirror').toString());
    expect(docA.getText('codemirror').toString()).toContain('Hello');
    expect(docA.getText('codemirror').toString()).toContain('World');

    providerA.destroy();
    providerB.destroy();
  }, 10000);

  it('3. Offline editing then reconnect merges correctly', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc3', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    // Connect initially and wait for full sync
    await new Promise<void>((resolve) => {
      providerA.on('sync', (isSynced) => { if (isSynced) resolve(); });
    });
    docA.getText('codemirror').insert(0, 'Initial Text. ');
    await new Promise<void>(resolve => setTimeout(resolve, 150));

    // Disconnect A
    providerA.disconnect();

    // Make local modifications on disconnected client A
    docA.getText('codemirror').insert(docA.getText('codemirror').length, 'Client A offline edit.');

    // Connect client B, edit doc3 separately
    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc3', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });
    // Wait for client B to sync with server
    await new Promise<void>((resolve) => {
      providerB.on('sync', (isSynced) => { if (isSynced) resolve(); });
    });
    
    // Client B sees initial text, edits it
    expect(docB.getText('codemirror').toString()).toContain('Initial Text');
    docB.getText('codemirror').insert(docB.getText('codemirror').length, 'Client B online edit.');

    // Reconnect A
    providerA.connect();

    // Wait for synchronization
    await new Promise<void>(resolve => setTimeout(resolve, 1000));

    // Verify convergence
    expect(docA.getText('codemirror').toString()).toBe(docB.getText('codemirror').toString());
    expect(docA.getText('codemirror').toString()).toContain('Client A offline edit');
    expect(docA.getText('codemirror').toString()).toContain('Client B online edit');

    providerA.destroy();
    providerB.destroy();
  }, 10000);

  it('4. Awareness propagates cursor metadata', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc4', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc4', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    await Promise.all([
      new Promise<void>((resolve) => providerA.on('status', ({ status }) => { if (status === 'connected') resolve(); })),
      new Promise<void>((resolve) => providerB.on('status', ({ status }) => { if (status === 'connected') resolve(); }))
    ]);

    // Send awareness state from A
    providerA.awareness.setLocalStateField('user', { name: 'Ahmed', color: '#ff00ff' });

    // Wait for B to receive
    const awarenessReceived = await new Promise<boolean>((resolve) => {
      const check = () => {
        const states = Array.from(providerB.awareness.getStates().values());
        const ahmedState = states.find((s: any) => s.user && s.user.name === 'Ahmed');
        if (ahmedState) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    expect(awarenessReceived).toBe(true);
    
    providerA.destroy();
    providerB.destroy();
  }, 10000);

  it('5. Snapshot Compaction & Restoration flow', async () => {
    const docId = 'doc-comp-test';
    
    // Write some direct DB updates
    await db.saveUpdate(docId, Y.encodeStateAsUpdate(new Y.Doc()));
    await db.saveUpdate(docId, Y.encodeStateAsUpdate(new Y.Doc()));

    // Create a mock doc with text content
    const testDoc = new Y.Doc();
    testDoc.getText('codemirror').insert(0, 'Snapshot content');

    // Trigger Compaction
    const status = await snapshotManager.compact(docId, testDoc);
    expect(status).toBe(true);

    // Verify snapshot was created in DB
    const snapshotRecord = await db.getLatestSnapshot(docId);
    expect(snapshotRecord).not.toBeNull();
    expect(snapshotRecord?.updateCount).toBe(2);

    // Verify updates table was cleared for this document
    const updates = await db.getUpdates(docId);
    expect(updates.length).toBe(0);

    // Restore test: load document via DocumentManager and verify state matches
    const docManager = new DocumentManager(db);
    const restoredDoc = await docManager.loadDocument(docId);
    expect(restoredDoc.getText('codemirror').toString()).toBe('Snapshot content');
  });

  it('6. Duplicate updates do not corrupt or append twice (Idempotency)', async () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('codemirror');
    ytext.insert(0, 'Original Text. ');

    const update = Y.encodeStateAsUpdate(doc);

    // Apply update twice
    const targetDoc = new Y.Doc();
    Y.applyUpdate(targetDoc, update);
    Y.applyUpdate(targetDoc, update);

    expect(targetDoc.getText('codemirror').toString()).toBe('Original Text. ');
  });

  it('7. Room isolation - edits do not leak to other document rooms', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/docA', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/docB', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    await Promise.all([
      new Promise<void>((resolve) => providerA.on('status', ({ status }) => { if (status === 'connected') resolve(); })),
      new Promise<void>((resolve) => providerB.on('status', ({ status }) => { if (status === 'connected') resolve(); }))
    ]);

    docA.getText('codemirror').insert(0, 'Secret code.');

    await new Promise<void>(resolve => setTimeout(resolve, 500));

    expect(docB.getText('codemirror').toString()).toBe(''); // Remains isolated empty

    providerA.destroy();
    providerB.destroy();
  });
});
