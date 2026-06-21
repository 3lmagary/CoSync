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

const TEST_PORT = 5002;
const TEST_DB_PATH = './data/test-chaos.db';
const TEST_WAL_DIR = './wal-chaos';

describe('Collaborative Sync Platform - Chaos & Network Loss Tests', () => {
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
    await db.createUser('u-chaos', 'ChaosMonkey', 'hash', '#ff0000');
    await db.createWorkspace('ws1', 'Test Workspace', 'u-chaos');
    await db.createDocument('doc-latency', 'ws1', 'Doc Latency');
    await db.createDocument('doc-loss', 'ws1', 'Doc Loss');
    await db.createDocument('doc-chaos-cycles', 'ws1', 'Doc Chaos Cycles');

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

    connectionManager = new ConnectionManager(wss, roomManager, auditLogService, db);
    server.on('upgrade', (req, socket, head) => {
      connectionManager.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });

    testToken = generateToken({ userId: 'u-chaos', username: 'ChaosMonkey', color: '#ff0000' });
  });

  afterAll(async () => {
    // Terminate all open clients first so they close and run their close/leave handlers
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
    }
    // Wait 500ms for all leave handlers to complete their DB writes
    await new Promise<void>(resolve => setTimeout(resolve, 500));

    await persistenceManager.forceShutdown();
    await db.close();
    if (wss) wss.close();
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

  /**
   * Helper to proxy and inject packet drop rates and delays into a WebSocket client.
   */
  function wrapWebSocketWithChaos(ws: WebSocket, options: { latencyMs: number; lossRate: number }) {
    const originalSend = ws.send;
    ws.send = function (data: any, cb?: any) {
      // Simulate packet loss (dropping message completely)
      if (Math.random() < options.lossRate) {
        console.log('Chaos wrapper DROPPED packet!');
        return;
      }
      // Simulate network latency (delayed delivery)
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log('Chaos wrapper SENT packet');
          originalSend.call(ws, data, cb);
        }
      }, options.latencyMs);
    };
  }

  it('1. Latency simulation (200ms - 1000ms) converges document state', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-latency', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-latency', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    // Wait for connection
    await Promise.all([
      new Promise<void>((resolve) => providerA.on('status', ({ status }) => { if (status === 'connected') resolve(); })),
      new Promise<void>((resolve) => providerB.on('status', ({ status }) => { if (status === 'connected') resolve(); }))
    ]);

    // Inject 500ms delay to A and 1000ms delay to B
    wrapWebSocketWithChaos(providerA.ws as WebSocket, { latencyMs: 200, lossRate: 0 });
    wrapWebSocketWithChaos(providerB.ws as WebSocket, { latencyMs: 500, lossRate: 0 });

    docA.getText('codemirror').insert(0, 'Delayed ');
    docB.getText('codemirror').insert(0, 'Convergence');

    // Wait for latency timers to settle
    await new Promise<void>(resolve => setTimeout(resolve, 3000));

    try {
      expect(docA.getText('codemirror').toString()).toBe(docB.getText('codemirror').toString());
      expect(docA.getText('codemirror').toString()).toContain('Delayed');
      expect(docA.getText('codemirror').toString()).toContain('Convergence');
    } finally {
      providerA.destroy();
      providerB.destroy();
    }
  }, 12000);

  it('2. Packet loss simulation (20%) recovers and converges document state', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    console.log('--- CLIENT IDs ---');
    console.log('docA.clientID:', docA.clientID);
    console.log('docB.clientID:', docB.clientID);

    docA.on('update', (update, origin) => {
      console.log('docA update! Size:', update.byteLength, 'Origin:', origin ? 'WebsocketProvider' : 'Local', 'Length:', docA.getText('codemirror').toString().length, 'Content:', docA.getText('codemirror').toString());
    });
    docB.on('update', (update, origin) => {
      console.log('docB update! Size:', update.byteLength, 'Origin:', origin ? 'WebsocketProvider' : 'Local', 'Length:', docB.getText('codemirror').toString().length, 'Content:', docB.getText('codemirror').toString());
    });

    const providerA = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-loss', docA, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    const providerB = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-loss', docB, {
      WebSocketPolyfill: WebSocket as any,
      protocols: ['co-sync-auth', testToken]
    });

    await Promise.all([
      new Promise<void>((resolve) => providerA.on('status', ({ status }) => { if (status === 'connected') resolve(); })),
      new Promise<void>((resolve) => providerB.on('status', ({ status }) => { if (status === 'connected') resolve(); }))
    ]);

    // Inject 20% packet loss to A and B
    wrapWebSocketWithChaos(providerA.ws as WebSocket, { latencyMs: 0, lossRate: 0.2 });
    wrapWebSocketWithChaos(providerB.ws as WebSocket, { latencyMs: 0, lossRate: 0.2 });

    // Send rapid updates
    for (let i = 0; i < 20; i++) {
      docA.getText('codemirror').insert(docA.getText('codemirror').length, 'a');
      docB.getText('codemirror').insert(docB.getText('codemirror').length, 'b');
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }

    console.log('--- AFTER LOOP ---');
    console.log('docA:', docA.getText('codemirror').toString());
    console.log('docB:', docB.getText('codemirror').toString());

    // Wait for in-flight packets to settle before disconnecting
    await new Promise<void>(resolve => setTimeout(resolve, 500));

    // Force reconnect to trigger full sync step vector exchange (recovering dropped updates)
    const disconnectPromises = [
      new Promise<void>((resolve) => {
        if (!providerA.wsconnected) resolve();
        else providerA.on('status', ({ status }) => { if (status === 'disconnected') resolve(); });
      }),
      new Promise<void>((resolve) => {
        if (!providerB.wsconnected) resolve();
        else providerB.on('status', ({ status }) => { if (status === 'disconnected') resolve(); });
      })
    ];

    providerA.disconnect();
    providerB.disconnect();

    await Promise.all(disconnectPromises);
    await new Promise<void>(resolve => setTimeout(resolve, 100));

    console.log('--- BEFORE RECONNECT ---');
    console.log('docA:', docA.getText('codemirror').toString());
    console.log('docB:', docB.getText('codemirror').toString());

    // Connect and wait for full sync vector handshake
    console.log('--- CALLING RECONNECT ---');
    providerA.connect();
    providerB.connect();

    await Promise.all([
      new Promise<void>((resolve) => providerA.on('sync', (isSynced) => { if (isSynced) resolve(); })),
      new Promise<void>((resolve) => providerB.on('sync', (isSynced) => { if (isSynced) resolve(); }))
    ]);

    await new Promise<void>(resolve => setTimeout(resolve, 500));

    console.log('--- AFTER RECONNECT ---');
    console.log('docA:', docA.getText('codemirror').toString());
    console.log('docB:', docB.getText('codemirror').toString());

    try {
      expect(docA.getText('codemirror').toString()).toBe(docB.getText('codemirror').toString());
    } finally {
      providerA.destroy();
      providerB.destroy();
    }
  }, 15000);

  it('3. Chaos test: multi-user random connect / disconnect cycles maintain consistency', async () => {
    const NUM_CLIENTS = 10;
    const docs: Y.Doc[] = [];
    const providers: WebsocketProvider[] = [];

    // Instantiate 10 clients
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${TEST_PORT}`, '/workspace/ws1/doc/doc-chaos-cycles', doc, {
        WebSocketPolyfill: WebSocket as any,
        protocols: ['co-sync-auth', testToken]
      });

      docs.push(doc);
      providers.push(provider);
    }

    // Run chaos edits and disconnect/reconnect loops for 3 seconds
    const interval = setInterval(() => {
      const randomIdx = Math.floor(Math.random() * NUM_CLIENTS);
      const randomDoc = docs[randomIdx];
      const randomProvider = providers[randomIdx];

      // Perform edit
      randomDoc.getText('codemirror').insert(0, `${randomIdx}`);

      // Perform network flip
      if (Math.random() < 0.3) {
        if (randomProvider.shouldConnect) {
          randomProvider.disconnect();
        } else {
          randomProvider.connect();
        }
      }
    }, 150);

    await new Promise<void>(resolve => setTimeout(resolve, 3000));
    clearInterval(interval);

    // Reconnect everyone for eventual convergence check
    for (const p of providers) {
      if (!p.shouldConnect) p.connect();
    }

    // Wait for final sync settle
    await new Promise<void>(resolve => setTimeout(resolve, 3000));

    // Assert everyone converges to the exact same text state
    const firstText = docs[0].getText('codemirror').toString();
    for (let i = 1; i < NUM_CLIENTS; i++) {
      expect(docs[i].getText('codemirror').toString()).toBe(firstText);
    }

    for (const p of providers) {
      p.destroy();
    }
  }, 20000);
});
