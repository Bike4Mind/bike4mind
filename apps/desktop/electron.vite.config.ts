import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const sharedDir = resolve(__dirname, 'src/shared');
// See the shim's own header: @bike4mind/common's barrel statically imports node:crypto,
// which a sandboxed renderer cannot resolve.
const nodeCryptoShim = resolve(__dirname, 'src/renderer/src/shims/nodeCrypto.ts');

export default defineConfig(({ mode }) => {
  const nodeEnv = mode === 'development' ? 'development' : 'production';

  return {
    main: {
      resolve: { alias: { '@shared': sharedDir } },
      plugins: [externalizeDepsPlugin()],
    },
    preload: {
      resolve: { alias: { '@shared': sharedDir } },
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      resolve: {
        alias: {
          '@shared': sharedDir,
          '@renderer': resolve(__dirname, 'src/renderer/src'),
          crypto: nodeCryptoShim,
          'node:crypto': nodeCryptoShim,
        },
      },
      // @bike4mind/common reads process.env at module scope (APP_NAME and WEBSITE_URL in
      // its utils barrel), and a sandboxed renderer has no process global. Substituting the
      // expression at compile time rather than assigning a globalThis.process shim keeps
      // `typeof process` undefined, so libraries that feature-detect Node still take their
      // browser branch. NODE_ENV is carried explicitly because replacing the whole
      // `process.env` expression would otherwise leave React's dev/prod check undefined.
      define: {
        'process.env.NODE_ENV': JSON.stringify(nodeEnv),
        'process.env': JSON.stringify({ NODE_ENV: nodeEnv }),
      },
      plugins: [react()],
    },
  };
});
