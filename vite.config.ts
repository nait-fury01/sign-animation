import { defineConfig } from 'vite';

export default defineConfig({
  // Only public/ is copied into dist/. Keep research/ at the repository root as local evidence.
  publicDir: 'public',
  server: { host: '0.0.0.0' },
});
