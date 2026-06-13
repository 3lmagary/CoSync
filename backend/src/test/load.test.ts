import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
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
import { logger } from '../services/logger';

const TEST_PORT = 5003;
const TEST_DB_PATH = './data/test-load.db';
const TEST_WAL_DIR = './wal-load';

describe('Collaborative Sync Platform - Load & Stress Tests', () => {
  let server: Server;
  let wss: WebSocketServer;
  let db: SQLiteDatabaseProvider;
  let roomManager: RoomManager;
  let connectionManager: ConnectionManager;
  let persistenceManager: PersistenceManager;
  let snapshotManager: SnapshotManager;
  let testToken: string;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_WAL_DIR)) fs.rmSync(TEST_WAL_DIR, { recursive: true, force: true });

    db = new SQLiteDatabaseProvider(TEST_DB_PATH);
    
    // Create test user, workspace and documents in DB to satisfy foreign key constraints
    await db.createUser('u-load-test', 'LoadClient', 'hash', '#00ff00');
    await db.createWorkspace('ws1', 'Test Workspace', 'u-load-test');
    await db.createDocument('doc-load-test', 'ws1', 'Doc Load Test');
    await db.createDocument('doc-massive-test', 'ws1', 'Doc Massive Test');

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

    testToken = generateToken({ userId: 'u-load-test', username: 'LoadClient', color: '#00ff00' });
  });

  afterAll(async () => {
    await persistenceManager.forceShutdown();
    await db.close();
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(TEST_WAL_DIR)) fs.rmSync(TEST_WAL_DIR, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('1. Load Test: 100 concurrent clients editing same document successfully converges', async () => {
    const NUM_CLIENTS = 100;
    const docs: Y.Doc[] = [];
    const providers: WebsocketProvider[] = [];

    const startMemory = process.memoryUsage().heapUsed;

    // 1. Connect 100 clients
    const connectionPromises = Array.from({ length: NUM_CLIENTS }).map((_, idx) => {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-load-test', doc, {
        WebSocketPolyfill: WebSocket as any,
        protocols: ['co-sync-auth', testToken]
      });

      docs.push(doc);
      providers.push(provider);

      return new Promise<void>((resolve) => {
        provider.on('status', ({ status }) => {
          if (status === 'connected') resolve();
        });
      });
    });

    await Promise.all(connectionPromises);
    logger.info(`Load Test: All ${NUM_CLIENTS} WebSocket clients connected.`);

    // 2. Perform concurrent edits
    const editPromises = docs.map((doc, idx) => {
      return new Promise<void>((resolve) => {
        // Staggered inputs to simulate natural user typing
        setTimeout(() => {
          doc.getText('codemirror').insert(0, `[C-${idx}]`);
          resolve();
        }, idx * 10);
      });
    });

    await Promise.all(editPromises);

    // 3. Wait for eventual synchronization
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    // 4. Assert all document states are identical
    const firstDocText = docs[0].getText('codemirror').toString();
    expect(firstDocText.length).toBeGreaterThan(0);

    for (let i = 1; i < NUM_CLIENTS; i++) {
      expect(docs[i].getText('codemirror').toString()).toBe(firstDocText);
    }

    const endMemory = process.memoryUsage().heapUsed;
    const memoryGrowthMb = (endMemory - startMemory) / 1024 / 1024;
    logger.info(`Load Test memory usage growth: ${memoryGrowthMb.toFixed(2)} MB`);

    // Memory growth should remain within reasonable bounds for 100 active Yjs documents
    expect(memoryGrowthMb).toBeLessThan(150); // Under 150MB overhead

    // Cleanup
    for (const p of providers) {
      p.destroy();
    }
  }, 35000);

  it('2. Massive Update Test: 10,000 edits verifies integrity & triggers snapshot compaction', async () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-massive-test', doc, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    await new Promise<void>((resolve) => {
      provider.on('status', ({ status }) => {
        if (status === 'connected') resolve();
      });
    });

    const ytext = doc.getText('codemirror');
    
    // Apply 10,000 rapid edits
    logger.info('Starting massive edits: applying 10,000 updates...');
    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      // Direct Yjs transactions
      doc.transact(() => {
        ytext.insert(0, 'x');
      });
      // Stagger slightly so the event loop has a chance to flush sockets, or do it synchronously.
      // We do it in fast chunks to avoid call stack size errors or block event loops
      if (i % 1000 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    const duration = Date.now() - start;
    logger.info(`10,000 edits executed in ${duration}ms.`);

    // Wait for persistence queue to capture all updates and write them
    await new Promise<void>(resolve => setTimeout(resolve, 2500));

    // Document length should be exactly 10,000 characters
    expect(ytext.length).toBe(10000);

    // Verify snapshot compaction: should have triggered and saved snapshot due to > 1000 updates threshold
    const compactionTriggered = await snapshotManager.checkCompactionRequired('doc-massive-test');
    expect(compactionTriggered).toBe(true);

    const compacted = await snapshotManager.compact('doc-massive-test', doc);
    expect(compacted).toBe(true);

    // Verify snapshot exists and updates table is cleared
    const snapshot = await db.getLatestSnapshot('doc-massive-test');
    expect(snapshot).not.toBeNull();
    const dbUpdates = await db.getUpdates('doc-massive-test');
    expect(dbUpdates.length).toBe(0);

    provider.destroy();
  }, 45000);
});
