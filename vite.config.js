import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import apiServer from './api/socket-io.js';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'cast-socket-io-dev',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/api/socket-io')) {
            apiServer.emit('request', req, res);
          } else {
            next();
          }
        });
        server.httpServer?.on('upgrade', (req, socket, head) => {
          if (req.url && req.url.startsWith('/api/socket-io')) {
            apiServer.emit('upgrade', req, socket, head);
          }
        });
      },
    },
  ],
});
