import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager';
import { verifyToken, UserTokenPayload } from '../services/auth';
import { logger } from '../services/logger';
import { reconnectStormsBlocked } from '../services/metrics';
import { AuditLogService } from './AuditLogService';
import { FeatureFlagService } from './FeatureFlagService';

// Per-IP rate limiting tracking in memory
interface RateLimitTracker {
  count: number;
  resetTime: number;
}

export class ConnectionManager {
  private wss: WebSocketServer;
  private roomManager: RoomManager;
  private auditLogService: AuditLogService;

  // Rate Limiting caches
  private ipRateLimits: Map<string, RateLimitTracker> = new Map();
  private maxConnectionsPerIp = 20; // Allow 20 connections per IP
  private messageLimitPerSecond = 50; // Max 50 messages per second per socket

  constructor(wss: WebSocketServer, roomManager: RoomManager, auditLogService: AuditLogService) {
    this.wss = wss;
    this.roomManager = roomManager;
    this.auditLogService = auditLogService;
  }

  /**
   * Performs JWT subprotocol checks, rate limit validations, and upgrades HTTP to WebSocket.
   */
  async handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): Promise<void> {
    const ip = req.socket.remoteAddress || 'unknown-ip';
    const url = req.url || '';
    logger.info(`Incoming WebSocket upgrade request from ${ip} for URL: ${url}`);

    // 1. IP rate limiting block
    if (FeatureFlagService.isEnabled('ENABLE_RATE_LIMIT') && this.isIpThrottled(ip)) {
      reconnectStormsBlocked.inc();
      logger.warn(`WebSocket upgrade rejected. IP rate limit exceeded: ${ip}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    // 2. Parse WebSocket Subprotocol
    const subprotocolHeader = req.headers['sec-websocket-protocol'];
    if (!subprotocolHeader) {
      logger.warn(`WebSocket upgrade rejected: missing authentication subprotocol from IP ${ip}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // The subprotocol header looks like: "co-sync-auth, <jwt-token>"
    const protocols = subprotocolHeader.split(',').map(s => s.trim());
    const authIndex = protocols.indexOf('co-sync-auth');
    if (authIndex === -1 || protocols.length <= authIndex + 1) {
      logger.warn(`WebSocket upgrade rejected: missing co-sync-auth credentials from IP ${ip}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = protocols[authIndex + 1];
    let decodedToken: UserTokenPayload;

    try {
      decodedToken = verifyToken(token);
    } catch (authError) {
      logger.warn(`WebSocket upgrade rejected: invalid JWT token from IP ${ip}`, { error: authError });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 3. Parse and validate Workspace/Document path
    // Format expected: /workspace/{workspaceId}/doc/{documentId}
    const normalizedUrl = url.replace(/\/+/g, '/');
    const match = normalizedUrl.match(/^\/workspace\/([^/]+)\/doc\/([^/]+)$/);
    if (!match) {
      logger.warn(`WebSocket upgrade rejected: invalid URL path structure: "${url}"`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const workspaceId = match[1];
    const documentId = match[2];

    // 4. Complete Upgrade Handshake
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Complete association
      this.handleConnection(ws, decodedToken, workspaceId, documentId, ip);
    });
  }

  /**
   * Initializes WebSocket events, rate limiting, and heartbeats for an upgraded connection.
   */
  private handleConnection(
    ws: WebSocket,
    user: UserTokenPayload,
    workspaceId: string,
    documentId: string,
    ip: string
  ): void {
    logger.info(`WebSocket connection established for user ${user.username} (ID: ${user.userId}) in workspace ${workspaceId}, document ${documentId}`);

    // Join room
    this.roomManager.handleClientJoin(documentId, ws, workspaceId).then((room) => {
      this.auditLogService.log('join_room', { userId: user.userId, workspaceId, documentId, ipAddress: ip });

      // Track heartbeat state
      let isAlive = true;
      ws.on('pong', () => {
        isAlive = true;
      });

      const pingInterval = setInterval(() => {
        if (!isAlive) {
          logger.warn(`Heartbeat failure. Terminating connection for user ${user.username}`);
          clearInterval(pingInterval);
          ws.terminate();
          return;
        }
        isAlive = false;
        ws.ping();
      }, 30000);

      // Throttling tracking
      let messageCount = 0;
      let throttlingWindowReset = Date.now() + 1000;

      ws.on('message', (data: Buffer) => {
        // Message rate limiting checks
        const now = Date.now();
        if (now > throttlingWindowReset) {
          messageCount = 0;
          throttlingWindowReset = now + 1000;
        }

        messageCount++;
        if (FeatureFlagService.isEnabled('ENABLE_RATE_LIMIT') && messageCount > this.messageLimitPerSecond) {
          logger.warn(`Message rate limit exceeded. Disconnecting client: ${user.username}`);
          this.auditLogService.log('throttled_disconnect', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
          ws.close(1008, 'Message rate limit exceeded');
          return;
        }

        // Apply Yjs protocol parsing and sync routing
        this.roomManager.handleClientMessage(room, ws, new Uint8Array(data), workspaceId);
      });

      // Socket lifecycle cleanup
      ws.on('close', () => {
        logger.info(`WebSocket connection closed for user ${user.username}`);
        clearInterval(pingInterval);
        this.roomManager.handleClientLeave(room, ws, workspaceId).then(() => {
          this.auditLogService.log('leave_room', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
        });
      });

      ws.on('error', (err) => {
        logger.error(`WebSocket error for user ${user.username}`, { error: err });
      });

      // JWT Expiry enforcement
      if (user.exp) {
        const remainingTimeMs = user.exp * 1000 - Date.now();
        if (remainingTimeMs > 0) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              logger.warn(`JWT session expired. Force-disconnecting user: ${user.username}`);
              this.auditLogService.log('jwt_expired_disconnect', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
              ws.close(4001, 'JWT session expired');
            }
          }, remainingTimeMs);
        }
      }
    }).catch(err => {
      logger.error(`Failed to complete join sequence for document ${documentId}`, { error: err });
      ws.close(1011, 'Failed to initialize document room');
    });
  }

  /**
   * Helper to perform connection upgrade sliding-window rate limit checks per IP.
   */
  private isIpThrottled(ip: string): boolean {
    const now = Date.now();
    let tracker = this.ipRateLimits.get(ip);

    if (!tracker || now > tracker.resetTime) {
      tracker = { count: 0, resetTime: now + 60000 }; // Reset window every 1 minute
      this.ipRateLimits.set(ip, tracker);
    }

    tracker.count++;
    return tracker.count > this.maxConnectionsPerIp;
  }
}
