import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager';
import { DatabaseProvider } from '../database/types';
import { verifyToken, UserTokenPayload } from '../services/auth';
import { logger } from '../services/logger';
import { reconnectStormsBlocked } from '../services/metrics';
import { AuditLogService } from './AuditLogService';
import { FeatureFlagService } from './FeatureFlagService';

// ---------------------------------------------------------------------------
// Rate-limit tracking structures
// ---------------------------------------------------------------------------

/** Sliding-window counter used for IP-level connection throttling. */
interface ConnectionRateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Token Bucket – per WebSocket socket message throttling.
 *
 * Tokens are added at `refillRate` tokens/second up to `capacity`.
 * Each message consumes 1 token.  When the bucket is empty the socket is
 * closed with 1008 (policy violation).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillTime: number;

  constructor(
    private readonly capacity: number,      // max burst tokens
    private readonly refillRate: number      // tokens added per second
  ) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
  }

  /** Returns true if a token was consumed, false if the bucket is empty. */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000; // seconds
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private wss: WebSocketServer;
  private roomManager: RoomManager;
  private auditLogService: AuditLogService;
  private dbProvider: DatabaseProvider;

  // --- IP-level connection rate limits ---
  private ipRateLimits: Map<string, ConnectionRateLimitEntry> = new Map();
  private readonly maxConnectionsPerIp = 200;      // per 60-second window

  // --- User-level connection rate limits ---
  private userConnectionCounts: Map<string, number> = new Map();
  private readonly maxConnectionsPerUser = 10;     // concurrent active connections

  // --- Token Bucket config per socket ---
  private readonly tokenBucketCapacity = 60;       // burst of up to 60 messages
  private readonly tokenBucketRefillRate = 20;     // 20 tokens/second steady state

  constructor(
    wss: WebSocketServer,
    roomManager: RoomManager,
    auditLogService: AuditLogService,
    dbProvider: DatabaseProvider                   // injected for authorization queries
  ) {
    this.wss = wss;
    this.roomManager = roomManager;
    this.auditLogService = auditLogService;
    this.dbProvider = dbProvider;
  }

  // ---------------------------------------------------------------------------
  // Public: HTTP → WebSocket upgrade gate
  // ---------------------------------------------------------------------------

  /**
   * Validates JWT, applies rate limits, verifies workspace membership via the
   * document's *real* workspaceId (source of truth in DB), then completes the
   * WebSocket upgrade.
   */
  async handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): Promise<void> {
    const ip = req.socket.remoteAddress || 'unknown-ip';
    const url = req.url || '';
    logger.info(`Incoming WebSocket upgrade request from ${ip} for URL: ${url}`);

    // ── Step 1: IP-level connection rate limit ─────────────────────────────
    if (FeatureFlagService.isEnabled('ENABLE_RATE_LIMIT') && this.isIpThrottled(ip)) {
      reconnectStormsBlocked.inc();
      logger.warn(`WebSocket upgrade rejected – IP rate limit exceeded: ${ip}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    // ── Step 2: Parse co-sync-auth sub-protocol ────────────────────────────
    const subprotocolHeader = req.headers['sec-websocket-protocol'];
    if (!subprotocolHeader) {
      logger.warn(`WebSocket upgrade rejected: missing authentication subprotocol from IP ${ip}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const protocols = subprotocolHeader.split(',').map(s => s.trim());
    const authIndex = protocols.indexOf('co-sync-auth');
    if (authIndex === -1 || protocols.length <= authIndex + 1) {
      logger.warn(`WebSocket upgrade rejected: missing co-sync-auth credentials from IP ${ip}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // ── Step 3: Verify JWT or CONNECTION_CODE ──────────────────────────────
    const token = protocols[authIndex + 1];
    let decodedToken: UserTokenPayload;
    // SECURITY: No fallback — if CONNECTION_CODE is not set, this auth path is disabled.
    const connectionCode = process.env.CONNECTION_CODE;

    if (connectionCode && token === connectionCode) {
      decodedToken = { userId: 'admin', username: 'Admin', color: '#000' };
    } else {
      try {
        decodedToken = verifyToken(token);
      } catch (authError) {
        logger.warn(`WebSocket upgrade rejected: invalid JWT from IP ${ip}`, { error: authError });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // ── Step 4: User-level connection limit ────────────────────────────────
    if (FeatureFlagService.isEnabled('ENABLE_RATE_LIMIT') && token !== connectionCode) {
      const currentCount = this.userConnectionCounts.get(decodedToken.userId) ?? 0;
      if (currentCount >= this.maxConnectionsPerUser) {
        logger.warn(`WebSocket upgrade rejected – user connection limit exceeded: ${decodedToken.username} (${decodedToken.userId})`);
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // ── Step 5: Parse URL path ─────────────────────────────────────────────
    // Expected: /workspace/{workspaceId}/doc/{documentId}
    const normalizedUrl = url.replace(/\/+/g, '/');
    const match = normalizedUrl.match(/^\/workspace\/([^/]+)\/doc\/([^/]+)$/);
    if (!match) {
      logger.warn(`WebSocket upgrade rejected: invalid URL path structure: "${url}"`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const documentId = match[2];

    // ── Step 6: Authorization – verify document.workspaceId, NOT URL param ─
    // Source of truth is the database, not the URL workspaceId supplied by the client.
    let authorizedWorkspaceId: string;
    try {
      const document = await this.dbProvider.getDocument(documentId);
      if (!document) {
        if (documentId.startsWith('obs-') || token === connectionCode) {
          const workspaceIdFromUrl = match[1];
          if (token !== connectionCode) {
            const isMember = await this.dbProvider.isWorkspaceMemberOrOwner(workspaceIdFromUrl, decodedToken.userId);
            if (!isMember) {
              logger.warn(`WebSocket upgrade rejected – unauthorized: user ${decodedToken.username} is not a member of workspace ${workspaceIdFromUrl}`);
              this.auditLogService.log('ws_auth_rejected', {
                userId: decodedToken.userId,
                workspaceId: workspaceIdFromUrl,
                documentId,
                ipAddress: ip
              });
              socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
              socket.destroy();
              return;
            }
          }
          authorizedWorkspaceId = workspaceIdFromUrl;
        } else {
          logger.warn(`WebSocket upgrade rejected: document not found: ${documentId} (user: ${decodedToken.username})`);
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
      } else {
        authorizedWorkspaceId = document.workspaceId;
        if (token !== connectionCode) {
          const isMember = await this.dbProvider.isWorkspaceMemberOrOwner(authorizedWorkspaceId, decodedToken.userId);
          if (!isMember) {
            logger.warn(`WebSocket upgrade rejected – unauthorized: user ${decodedToken.username} is not a member of workspace ${authorizedWorkspaceId}`);
            this.auditLogService.log('ws_auth_rejected', {
              userId: decodedToken.userId,
              workspaceId: authorizedWorkspaceId,
              documentId,
              ipAddress: ip
            });
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        }
      }
    } catch (dbError) {
      logger.error('WebSocket upgrade failed: authorization DB query error', { error: dbError });
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }

    // ── Step 7: Complete WebSocket Upgrade ─────────────────────────────────
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws, decodedToken, authorizedWorkspaceId, documentId, ip);
    });
  }

  // ---------------------------------------------------------------------------
  // Private: post-upgrade connection lifecycle
  // ---------------------------------------------------------------------------

  private handleConnection(
    ws: WebSocket,
    user: UserTokenPayload,
    workspaceId: string,
    documentId: string,
    ip: string
  ): void {
    logger.info(`WebSocket connected – user: ${user.username} (${user.userId}), workspace: ${workspaceId}, doc: ${documentId}`);

    // Track user-level concurrent connection count
    this.incrementUserConnections(user.userId);

    this.roomManager.handleClientJoin(documentId, ws, workspaceId).then((room) => {
      // Fire-and-forget audit log – already non-blocking
      this.auditLogService.log('join_room', { userId: user.userId, workspaceId, documentId, ipAddress: ip });

      // ── Heartbeat ────────────────────────────────────────────────────────
      let isAlive = true;
      ws.on('pong', () => { isAlive = true; });

      const pingInterval = setInterval(() => {
        if (!isAlive) {
          logger.warn(`Heartbeat failure – terminating connection for user ${user.username}`);
          clearInterval(pingInterval);
          ws.terminate();
          return;
        }
        isAlive = false;
        ws.ping();
      }, 30_000);

      // ── Token Bucket message throttle ────────────────────────────────────
      const bucket = new TokenBucket(this.tokenBucketCapacity, this.tokenBucketRefillRate);

      ws.on('message', (data: Buffer) => {
        if (FeatureFlagService.isEnabled('ENABLE_RATE_LIMIT') && !bucket.consume()) {
          logger.warn(`Token bucket exhausted – disconnecting client: ${user.username}`);
          this.auditLogService.log('throttled_disconnect', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
          ws.close(1008, 'Message rate limit exceeded');
          return;
        }

        this.roomManager.handleClientMessage(room, ws, new Uint8Array(data), workspaceId);
      });

      // ── Socket lifecycle cleanup ─────────────────────────────────────────
      // Guard: ensure decrement happens exactly once regardless of how many
      // close/error events fire. Node.js guarantees 'close' always follows
      // 'error', but the flag protects against any edge-case deviation.
      let decremented = false;
      const decrementOnce = () => {
        if (!decremented) {
          decremented = true;
          this.decrementUserConnections(user.userId);
        }
      };

      ws.on('close', () => {
        logger.info(`WebSocket closed – user: ${user.username}`);
        clearInterval(pingInterval);
        decrementOnce();
        this.roomManager.handleClientLeave(room, ws, workspaceId).then(() => {
          this.auditLogService.log('leave_room', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
        });
      });

      ws.on('error', (err) => {
        logger.error(`WebSocket error – user: ${user.username}`, { error: err });
        // 'error' is always followed by 'close' in Node.js; calling decrementOnce()
        // here as well means we never rely on close firing to clean up the counter.
        decrementOnce();
      });

      // ── JWT Expiry enforcement ───────────────────────────────────────────
      if (user.exp) {
        const remainingTimeMs = user.exp * 1000 - Date.now();
        if (remainingTimeMs > 0) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              logger.warn(`JWT expired – force-disconnecting user: ${user.username}`);
              this.auditLogService.log('jwt_expired_disconnect', { userId: user.userId, workspaceId, documentId, ipAddress: ip });
              ws.close(4001, 'JWT session expired');
            }
          }, remainingTimeMs);
        }
      }
    }).catch(err => {
      logger.error(`Failed to complete join sequence for document ${documentId}`, { error: err });
      this.decrementUserConnections(user.userId);
      ws.close(1011, 'Failed to initialize document room');
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers: rate-limit trackers
  // ---------------------------------------------------------------------------

  /**
   * IP-level sliding-window rate limiter (60-second window).
   * Returns true if the IP should be blocked.
   */
  private isIpThrottled(ip: string): boolean {
    const now = Date.now();
    let tracker = this.ipRateLimits.get(ip);

    if (!tracker || now > tracker.resetTime) {
      tracker = { count: 0, resetTime: now + 60_000 };
      this.ipRateLimits.set(ip, tracker);
    }

    tracker.count++;
    return tracker.count > this.maxConnectionsPerIp;
  }

  /** Increments the active-connection counter for a user. */
  private incrementUserConnections(userId: string): void {
    this.userConnectionCounts.set(userId, (this.userConnectionCounts.get(userId) ?? 0) + 1);
  }

  /** Decrements the active-connection counter for a user, removing the entry at zero. */
  private decrementUserConnections(userId: string): void {
    const current = this.userConnectionCounts.get(userId) ?? 0;
    if (current <= 1) {
      this.userConnectionCounts.delete(userId);
    } else {
      this.userConnectionCounts.set(userId, current - 1);
    }
  }
}
