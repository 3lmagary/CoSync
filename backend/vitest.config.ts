import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    pool: 'forks',
    server: {
      deps: {
        inline: [
          'yjs',
          'y-protocols',
          'y-websocket'
        ]
      }
    }
  },
  resolve: {
    alias: {
      'yjs': resolve(__dirname, '../node_modules/yjs/dist/yjs.cjs')
    }
  }
});
