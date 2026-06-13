import { PubSubProvider } from './types';

export class MemoryPubSub implements PubSubProvider {
  private subscriptions: Map<string, Set<(message: string) => void>> = new Map();

  async publish(channel: string, message: string): Promise<void> {
    const subscribers = this.subscriptions.get(channel);
    if (subscribers) {
      for (const callback of subscribers) {
        // Run callbacks asynchronously to avoid blocking the main execution path
        setImmediate(() => {
          try {
            callback(message);
          } catch (error) {
            console.error(`Error in memory PubSub callback for channel ${channel}:`, error);
          }
        });
      }
    }
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)!.add(callback);
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
  }
}
