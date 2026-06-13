export interface PubSubProvider {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  close(): Promise<void>;
}
