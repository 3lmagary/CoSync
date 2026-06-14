import * as Y from 'yjs';
// @ts-ignore
import * as syncProtocol from 'y-protocols/dist/sync.cjs';
// @ts-ignore
import * as awarenessProtocol from 'y-protocols/dist/awareness.cjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { DocumentManager } from './DocumentManager';
import { PersistenceManager } from './PersistenceManager';
import { SnapshotManager } from './SnapshotManager';
import { AwarenessManager } from './AwarenessManager';
import { logger } from '../services/logger';
import { activeConnections, messagesReceived } from '../services/metrics';

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

  private rooms: Map<string, Room> = new Map();
  private pendingRooms: Map<string, Promise<Room>> = new Map();

  constructor(
    documentManager: DocumentManager,
    persistenceManager: PersistenceManager,
    snapshotManager: SnapshotManager,
    awarenessManager: AwarenessManager
  ) {
    this.documentManager = documentManager;
    this.persistenceManager = persistenceManager;
    this.snapshotManager = snapshotManager;
    this.awarenessManager = awarenessManager;
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

        // 2. Broadcast the update to other clients
        this.broadcastUpdate(newRoom, update, origin);
      });

      // Handle awareness change broadcasts
      awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
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

    // AUTO-DISCOVERY: If document is from Obsidian and doesn't exist in DB document list, register it
    // This ensures Obsidian notes appear in the web sidebar automatically.
    if (documentId.startsWith('obs-')) {
      try {
        const exists = await this.documentManager.exists(documentId);
        if (!exists) {
          logger.info(`Auto-registering discovered Obsidian document: ${documentId}`);
          // Extract a readable title from the ID (ID format: obs-hash-Title)
          const parts = documentId.split('-');
          const title = parts.length > 2 ? parts.slice(2).join('-') : 'Obsidian Note';
          await this.documentManager.createDocument(documentId, workspaceId, title);
        }
      } catch (err) {
        logger.error(`Failed to auto-register Obsidian document ${documentId}`, { error: err });
      }
    }

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
        const syncType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
        
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
   * Cleans up room connections, awareness tracking, and releases memory on disconnects.
   */
  async handleClientLeave(room: Room, socket: WebSocket, workspaceId: string): Promise<void> {
    room.clients.delete(socket);
    activeConnections.dec({ workspace_id: workspaceId });
    
    logger.info(`Client left room ${room.documentId}. Remaining clients: ${room.clients.size}`);

    // If client had awareness, clean it up
    // Client id identification from awareness mapping usually occurs on WebSocket disconnect
    // In y-websocket, we can delete the client's socket references

    // Release memory if room is completely idle
    if (room.clients.size === 0) {
      await this.cleanupRoom(room.documentId);
    }
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
