import client from 'prom-client';

// Collect default metrics (CPU, Memory, Event Loop, etc.)
client.collectDefaultMetrics({ prefix: 'sync_platform_' });

export const activeConnections = new client.Gauge({
  name: 'sync_platform_active_connections',
  help: 'Number of active WebSocket connections',
  labelNames: ['workspace_id']
});

export const messagesReceived = new client.Counter({
  name: 'sync_platform_messages_received_total',
  help: 'Total number of WebSocket messages received',
  labelNames: ['workspace_id', 'doc_id']
});

export const persistenceQueueLength = new client.Gauge({
  name: 'sync_platform_persistence_queue_length',
  help: 'Number of updates currently waiting in the persistence queue',
  labelNames: ['doc_id']
});

export const batchWriteDuration = new client.Histogram({
  name: 'sync_platform_persistence_batch_write_duration_seconds',
  help: 'Duration of database batch write transactions',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

export const snapshotCompactionCount = new client.Counter({
  name: 'sync_platform_snapshot_compaction_total',
  help: 'Total number of snapshot compaction triggers',
  labelNames: ['status'] // 'success' | 'failure'
});

export const snapshotDuration = new client.Histogram({
  name: 'sync_platform_snapshot_duration_seconds',
  help: 'Duration of snapshot compiles and commits',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5]
});

export const reconnectStormsBlocked = new client.Counter({
  name: 'sync_platform_reconnect_storms_blocked_total',
  help: 'Total connection attempts rejected by rate limiting'
});

export const activeAwarenessUsers = new client.Gauge({
  name: 'sync_platform_awareness_active_users',
  help: 'Number of active users broadcasting awareness data',
  labelNames: ['doc_id']
});

export async function getMetricsString(): Promise<string> {
  return client.register.metrics();
}

export const metricsContentType = client.register.contentType;
