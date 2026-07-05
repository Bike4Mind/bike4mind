import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';
import path from 'path';
// @vitejs/plugin-react v6 requires Vite 8 (it imports the `vite/internal`
// subpath). Vite is otherwise only a transitive peer of vitest. Declaring
// `vite` as an explicit devDependency here is the lever that satisfies
// plugin-react 6's strict `^8` peer — pnpm then unifies vite to 8 workspace-wide
// for every vitest package (safe: vitest 4 accepts vite ^6 || ^7 || ^8). This
// vite devDep and the plugin-react v6 bump are coupled — keep both or revert both.
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    ...sharedTest,
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    exclude: ['**/node_modules/**', 'e2e', '.next/**', '.open-next/**'],
  },
  resolve: {
    alias: {
      '@server': path.resolve(__dirname, 'server'),
      '@client': path.resolve(__dirname, '.'),
      '@pages': path.resolve(__dirname, 'pages'),
      '@public': path.resolve(__dirname, 'public'),
      '@/': `${path.resolve(__dirname, '.')}/`,
      crypto: 'node:crypto',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    include: ['uuid'],
  },
});
