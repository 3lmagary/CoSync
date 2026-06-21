import ws from 'k6/ws';
import { check } from 'k6';
import { encodeStateVector, encodeStateAsUpdate } from 'yjs'; // Note: K6 doesn't run node_modules natively easily without bundling, this is a conceptual script
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

export const options = {
  stages: [
    { duration: '30s', target: 10 }, // Baseline
    { duration: '1m', target: 50 },  // Spike
    { duration: '2m', target: 100 }, // Heavy load
    { duration: '1m', target: 0 },   // Cool down
  ],
};

// Assuming token auth for load test user
const token = __ENV.TOKEN || 'test-token';
const wsUrl = `ws://localhost:4000/workspace/ws-test/doc/doc-load-test`;

export default function () {
  const res = ws.connect(wsUrl, { headers: { Authorization: `Bearer ${token}` } }, function (socket) {
    socket.on('open', () => {
      console.log('connected');
      // Simulate typing every 50ms (20 edits / sec)
      socket.setInterval(function timeout() {
        // Mock Yjs sync protocol message
        // A real load test requires bundling yjs logic into the k6 script
        const mockUpdate = new Uint8Array([0, 2, ...Array.from(randomString(10)).map(c => c.charCodeAt(0))]);
        socket.send(mockUpdate);
      }, 50);
    });

    socket.on('message', (data) => {
      // Just receive to test throughput
    });

    socket.on('close', () => console.log('disconnected'));
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
