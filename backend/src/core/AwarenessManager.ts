import * as Y from 'yjs';
// y-protocols and lib0 are peer dependencies of yjs/y-websocket and are always present
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocket } from 'ws';
import { logger } from '../services/logger';
import { activeAwarenessUsers } from '../services/metrics';

export interface UserAwarenessState {
  userId: string;
  username: string;
  color: string;
  cursor?: { line: number; ch: number } | null;
  selection?: { anchor: number; head: number } | null;
}

export class AwarenessManager {
  // Mapping of document ID to its corresponding Awareness instance
  private docAwareness: Map<string, awarenessProtocol.Awareness> = new Map();
  // Mapping of WebSocket socket to set of controlled client IDs
  private connectionClients: Map<WebSocket, Set<number>> = new Map();

  /**
   * Gets or creates the Awareness instance for a document room.
   */
  getOrCreateAwareness(documentId: string, doc: Y.Doc): awarenessProtocol.Awareness {
    if (!this.docAwareness.has(documentId)) {
      const awareness = new awarenessProtocol.Awareness(doc);
      
      // Monitor awareness changes to track metrics
      awareness.on('change', () => {
        const activeCount = awareness.getStates().size;
        activeAwarenessUsers.set({ doc_id: documentId }, activeCount);
      });

      // Track controlled client IDs per WebSocket connection
      awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
        if (origin && origin instanceof WebSocket) {
          let controlled = this.connectionClients.get(origin);
          if (!controlled) {
            controlled = new Set<number>();
            this.connectionClients.set(origin, controlled);
          }
          added.forEach((id: number) => controlled!.add(id));
          removed.forEach((id: number) => controlled!.delete(id));
        }
      });

      this.docAwareness.set(documentId, awareness);
      logger.info(`Initialized Awareness instance for document: ${documentId}`);
    }
    return this.docAwareness.get(documentId)!;
  }

  /**
   * Applies an incoming awareness binary update from a client.
   */
  applyAwarenessUpdate(documentId: string, update: Uint8Array, clientSocket: WebSocket): void {
    const awareness = this.docAwareness.get(documentId);
    if (!awareness) return;

    try {
      console.log("Applying awareness update on server...");
      awarenessProtocol.applyAwarenessUpdate(awareness, update, clientSocket);
      console.log("Server awareness states size:", awareness.getStates().size, "Entries:", Array.from(awareness.getStates().entries()).map(([cid, val]: any) => ({ clientId: cid, hasUser: !!val.user, user: val.user })));
    } catch (error) {
      logger.error(`Failed to apply awareness update for doc ${documentId}`, { error });
    }
  }

  /**
   * Decodes and formats the awareness update message to broadcast.
   */
  encodeAwarenessUpdate(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // Message Type 1: Awareness
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, clients);
    encoding.writeVarUint8Array(encoder, update);
    return encoding.toUint8Array(encoder);
  }

  /**
   * Cleans up the awareness state for a client when they disconnect.
   */
  handleDisconnect(documentId: string, clientSocket: WebSocket): void {
    const awareness = this.docAwareness.get(documentId);
    if (!awareness) return;

    const controlled = this.connectionClients.get(clientSocket);
    if (controlled && controlled.size > 0) {
      logger.info(`Cleaning up awareness states for clients: ${Array.from(controlled)} in doc ${documentId}`);
      try {
        awarenessProtocol.removeAwarenessStates(awareness, Array.from(controlled), clientSocket);
      } catch (err) {
        logger.error(`Error removing awareness states on disconnect for doc ${documentId}`, { error: err });
      }
      this.connectionClients.delete(clientSocket);
    }
  }

  /**
   * Destroys the awareness instance when the room is unloaded from memory.
   */
  destroyAwareness(documentId: string): void {
    const awareness = this.docAwareness.get(documentId);
    if (awareness) {
      awareness.destroy();
      this.docAwareness.delete(documentId);
      logger.info(`Destroyed Awareness instance for document: ${documentId}`);
    }
  }
}
