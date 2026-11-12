import { defineConfig } from 'vite';
import path from 'node:path';
const client = path.resolve(import.meta.dirname, '..');
const root = path.resolve(client, '../..');
export default defineConfig({
  root: import.meta.dirname,
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'visual-boundaries',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('UnsavedChangesGuard')) return path.resolve(import.meta.dirname, 'guard.tsx');
      if (id === '../shared') return path.resolve(import.meta.dirname, 'shared.ts');
      if (id === '@bike4mind/common') return path.resolve(import.meta.dirname, 'common.ts');
      if (id === '@client/app/hooks/data/dlqManagement') return path.resolve(import.meta.dirname, 'dlq.ts');
      if (id === '@client/app/contexts/UserContext') return path.resolve(import.meta.dirname, 'user.ts');
      if (id === '@client/app/components/admin/shared' || id === './shared') return path.resolve(import.meta.dirname, 'shared.ts');
    },
  }],
  resolve: { alias: [
    { find: '@client/app/hooks/data/dlqManagement', replacement: path.resolve(import.meta.dirname, 'dlq.ts') },
    { find: '@client/app/contexts/ApiContext', replacement: path.resolve(import.meta.dirname, 'api.ts') },
    { find: '@client/app/utils/feedbackAPICalls', replacement: path.resolve(import.meta.dirname, 'feedback.ts') },
    { find: '@client/app/contexts/UserContext', replacement: path.resolve(import.meta.dirname, 'user.ts') },
    { find: /^@client\/app\/components\/admin\/shared$/, replacement: path.resolve(import.meta.dirname, 'shared.ts') },
    { find: '@client', replacement: client },
    { find: '@', replacement: client },
  ] },
  server: { host: '127.0.0.1', port: 4317, strictPort: true, fs: { allow: [root] } },
});
