import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const nodeCryptoShim = resolve(root, 'src/renderer/src/shims/nodeCrypto.ts');
const TARGET = 'es2022';

// Must stay in sync with the `renderer` block of ../electron.vite.config.ts, which explains
// the crypto shim and the process.env substitution.
export default ({ mode }: { mode: string }) => {
  const nodeEnv = mode === 'development' ? 'development' : 'production';
  return {
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@renderer': resolve(root, 'src/renderer/src'),
        crypto: nodeCryptoShim,
        'node:crypto': nodeCryptoShim,
      },
    },
    // Ladle bundles Vite 6, whose default browser target the workspace's pinned esbuild cannot
    // lower destructuring to. The stories only ever run in a current Chromium.
    build: { target: TARGET },
    esbuild: { target: TARGET },
    optimizeDeps: { esbuildOptions: { target: TARGET } },
    define: {
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'process.env': JSON.stringify({ NODE_ENV: nodeEnv }),
    },
  };
};
