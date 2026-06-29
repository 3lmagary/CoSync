import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
// @ts-ignore
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { DocumentManager } from './DocumentManager';
import { PersistenceManager } from './PersistenceManager';
import { SnapshotManager } from './SnapshotManager';
import { AwarenessManager } from './AwarenessManager';
import { PubSubProvider } from '../pubsub/types';
import { DatabaseProvider } from '../database/types';
import { logger } from '../services/logger';
import { activeConnections, messagesReceived } from '../services/metrics';
import type { DocumentVersion } from '../database/types';

interface Room {
  doc: Y.Doc;
  clients: Set<WebSocket>;
  awareness: any; // y-protocols Awareness instance
  documentId: string;
}

export class RoomManager {
  private documentManager: DocumentManager;
  private persistenceManager: PersistenceManager;
  private snapshotManager: SnapshotManager;
  private awarenessManager: AwarenessManager;
  private dbProvider: DatabaseProvider;
  private pubSubProvider?: PubSubProvider;

  private rooms: Map<string, Room> = new Map();
  private pendingRooms: Map<string, Promise<Room>> = new Map();

  constructor(
    documentManager: DocumentManager,
    persistenceManager: PersistenceManager,
    snapshotManager: SnapshotManager,
    awarenessManager: AwarenessManager,
    dbProvider: DatabaseProvider,
    pubSubProvider?: PubSubProvider
  ) {
    this.documentManager = documentManager;
    this.persistenceManager = persistenceManager;
    this.snapshotManager = snapshotManager;
    this.awarenessManager = awarenessManager;
    this.dbProvider = dbProvider;
    this.pubSubProvider = pubSubProvider;

    // When running with a real PubSub backend (Redis), subscribe to a wildcard
    // pattern channel so updates are relayed across backend instances.
    // We use the channel format: "doc:<documentId>"
    if (this.pubSubProvider) {
      this.pubSubProvider.subscribe('doc:*', (message: string) => {
        try {
          const { documentId, update } = JSON.parse(message);
          const room = this.rooms.get(documentId);
          if (!room) return;
          // Apply cross-instance update with a synthetic origin so it is broadcast
          // to local clients and persisted, but not echoed back to the origin socket.
          Y.applyUpdate(room.doc, new Uint8Array(update), 'pubsub');
        } catch (err: any) {
          logger.error('Failed applying pubsub update', { error: err });
        }
      });
    }
  }

  /**
   * Retrieves an active room or loads a new one into memory.
   */
  async getOrCreateRoom(documentId: string): Promise<Room> {
    let room = this.rooms.get(documentId);
    if (room) return room;

    let pending = this.pendingRooms.get(documentId);
    if (pending) return pending;

    const promise = (async () => {
      logger.info(`Creating active memory room for document: ${documentId}`);

      // Load Y.Doc state using snapshot + updates
      const doc = await this.documentManager.loadDocument(documentId);
      const awareness = this.awarenessManager.getOrCreateAwareness(documentId, doc);

      const newRoom: Room = {
        doc,
        clients: new Set<WebSocket>(),
        awareness,
        documentId
      };

      // Safely bind Y.Doc update listener
      // SAFEGUARD: The 'origin' parameter contains the WebSocket of the client who initiated the edit.
      // By matching the origin, we broadcast changes only to OTHER clients in the room.
      // This blocks echo effects, preventing infinite synchronization loop races.
      doc.on('update', (update: Uint8Array, origin: any) => {
        // 1. Queue the update for DB persistence
        this.persistenceManager.appendUpdate(documentId, update).catch(err => {
          logger.error(`Failed to queue update for doc ${documentId}`, { error: err });
        });

        // 2. Fan out to other backend instances when a PubSub backend is configured
        if (this.pubSubProvider && origin !== 'pubsub') {
          const channel = `doc:${documentId}`;
          this.pubSubProvider.publish(channel, JSON.stringify({ documentId, update: Array.from(update) })).catch(err => {
            logger.error(`PubSub publish failed for doc ${documentId}`, { error: err });
          });
        }

        // 3. Broadcast the update to other clients on THIS instance
        this.broadcastUpdate(newRoom, update, origin);
      });

      // Handle awareness change broadcasts
      awareness.on('update', ({ added, updated, removed }: any, _origin: any) => {
        const changedClients = added.concat(updated).concat(removed);
        const message = this.awarenessManager.encodeAwarenessUpdate(awareness, changedClients);

        // Broadcast to everyone in the room
        this.broadcastMessage(newRoom, message);
      });

      this.rooms.set(documentId, newRoom);
      this.pendingRooms.delete(documentId);
      return newRoom;
    })();

    this.pendingRooms.set(documentId, promise);
    return promise;
  }

  /**
   * Orchestrates the Yjs WebSocket sync protocol handshakes when a client connects.
   */
  async handleClientJoin(documentId: string, socket: WebSocket, workspaceId: string): Promise<Room> {
    const room = await this.getOrCreateRoom(documentId);
    room.clients.add(socket);



    activeConnections.inc({ workspace_id: workspaceId });
    logger.info(`Client joined room ${documentId}. Total clients: ${room.clients.size}`);

    // --- Yjs Sync Step 1: Send server state vector to client ---
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // Message Type 0: Sync
    syncProtocol.writeSyncStep1(encoder, room.doc);
    socket.send(encoding.toUint8Array(encoder));

    // --- Send current awareness states to newly joined client ---
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, 1); // Message Type 1: Awareness
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
      );
      socket.send(encoding.toUint8Array(awarenessEncoder));
    }

    return room;
  }

  /**
   * Decodes incoming WebSocket messages according to the Yjs protocol structure.
   */
  handleClientMessage(room: Room, socket: WebSocket, message: Uint8Array, workspaceId: string): void {
    messagesReceived.inc({ workspace_id: workspaceId, doc_id: room.documentId });

    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      if (messageType === 0) {
        // Yjs Sync Message
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0); // Type 0: Sync

        // syncProtocol will read details and write corresponding steps/updates to encoder
        // Origin is set to socket to identify who applied this update
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);

        // If the server wrote responses (e.g. Sync Step 2 / updates) into encoder, send back to client
        if (encoding.length(encoder) > 1) {
          socket.send(encoding.toUint8Array(encoder));
        }
      } else if (messageType === 1) {
        // Yjs Awareness Message
        const awarenessUpdate = decoding.readVarUint8Array(decoder);
        this.awarenessManager.applyAwarenessUpdate(room.documentId, awarenessUpdate, socket);
      } else {
        logger.warn(`Unknown Yjs protocol message type: ${messageType} in room ${room.documentId}`);
      }
    } catch (error) {
      logger.error(`Error processing WebSocket message in room ${room.documentId}`, { error });
    }
  }

  /**
   * Cleans up room connections, awareness tracking, and releases memory on disconnect.
   */
  async handleClientLeave(room: Room, socket: WebSocket, workspaceId: string): Promise<void> {
    room.clients.delete(socket);
    try { activeConnections.dec({ workspace_id: workspaceId }); } catch { /* metric may be missing in tests */ }

    logger.info(`Client left room ${room.documentId}. Remaining clients: ${room.clients.size}`);

    // Clean up disconnected client's awareness state
    this.awarenessManager.handleDisconnect(room.documentId, socket);

    // Release memory if room is completely idle
    if (room.clients.size === 0) {
      await this.cleanupRoom(room.documentId);
    }
  }

  /**
   * Forcefully evicts an active room from memory — used after a version restore
   * so the next connecting client reloads the restored snapshot. Pending writes
   * are flushed and a compaction is run to persist the restored state cleanly.
   */
  async forceEvictRoom(documentId: string): Promise<void> {
    const room = this.rooms.get(documentId);
    this.pendingRooms.delete(documentId);
    if (!room) {
      logger.info(`forceEvictRoom: room ${documentId} not active; nothing to evict.`);
      return;
    }

    logger.info(`Force-evicting room ${documentId} (${room.clients.size} clients).`);
    // Close all client sockets to prevent reconnect loop attempts on non-existent document
    for (const client of room.clients) {
      try {
        client.close(1001, 'Room evicted');
      } catch (err) {
        logger.error('Error closing socket during room eviction', { error: err });
      }
    }
    await this.cleanupRoom(documentId);
  }

  /**
   * Captures the current in-memory document state as a named version.
   * Returns null if the room is not currently active in memory.
   */
  async captureVersion(documentId: string, createdBy?: string): Promise<DocumentVersion | null> {
    const room = this.rooms.get(documentId);
    if (!room) return null;
    const captured = await this.snapshotManager.captureVersion(documentId, room.doc, createdBy);
    if (!captured) return null;
    // Fetch the full row to return the snapshot bytes as well.
    const versions = await this.dbProvider.listVersions(documentId);
    return versions.find(v => v.id === captured.id) || null;
  }

  /**
   * Deallocates memory, flushes remaining queues, and runs snapshot compactions.
   */
  private async cleanupRoom(documentId: string): Promise<void> {
    const room = this.rooms.get(documentId);
    if (!room) return;

    logger.info(`Room ${documentId} is empty. Commencing lifecycle deallocation...`);

    // 1. Force flush any pending write-queue items
    await this.persistenceManager.flushDocument(documentId);

    // Guard: Check if a client reconnected while we were flushing in the background
    if (room.clients.size > 0) {
      logger.info(`Aborting cleanup for room ${documentId}: client reconnected during flush.`);
      return;
    }

    // 2. Evaluate snapshot compaction trigger requirements
    const compactionNeeded = await this.snapshotManager.checkCompactionRequired(documentId);
    if (compactionNeeded) {
      await this.snapshotManager.compact(documentId, room.doc);
    }

    // Guard: Check if a client reconnected while we were running compaction in the background
    if (room.clients.size > 0) {
      logger.info(`Aborting cleanup for room ${documentId}: client reconnected during compaction.`);
      return;
    }

    // 3. Clear awareness and document allocations
    this.awarenessManager.destroyAwareness(documentId);
    room.doc.destroy();

    this.rooms.delete(documentId);
    logger.info(`Successfully unloaded room ${documentId} from memory.`);
  }

  /**
   * Broadcasts Y.Doc updates to all connected sockets in the room, excluding the sender.
   */
  private broadcastUpdate(room: Room, update: Uint8Array, originSocket: any): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // Message Sync
    encoding.writeVarUint(encoder, 2); // Sync update type
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);

    for (const client of room.clients) {
      // SAFEGUARD: Do not echo the update back to the socket that sent it.
      if (client !== originSocket && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Broadcasts standard raw messages to all clients in a room.
   */
  private broadcastMessage(room: Room, message: Uint8Array): void {
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  // Exposed for diagnostics
  getActiveRoomsCount(): number {
    return this.rooms.size;
  }

  getRoomClientsCount(documentId: string): number {
    return this.rooms.get(documentId)?.clients.size || 0;
  }
}
