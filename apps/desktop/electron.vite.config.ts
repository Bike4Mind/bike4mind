import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';

const sharedDir = resolve(__dirname, 'src/shared');
// See the shim's own header: @bike4mind/common's barrel statically imports node:crypto,
// which a sandboxed renderer cannot resolve.
const nodeCryptoShim = resolve(__dirname, 'src/renderer/src/shims/nodeCrypto.ts');

/**
 * The brand's default backend, supplied at build time and never committed. Precedence is
 * the shell environment first - that is how CI injects it for the CLI today, and how a
 * packaging run injects it here - then a gitignored `.env`/`.env.local` in this directory,
 * which only exists so a local packaging run is one command rather than a long prefix.
 * Absent both, it is empty and the build has no hosted option at all.
 */
function bakedApiUrl(mode: string): string {
  const fromFile = loadEnv(mode, __dirname, 'B4M_');
  return process.env.B4M_DEFAULT_API_URL ?? fromFile.B4M_DEFAULT_API_URL ?? '';
}

export default defineConfig(({ mode }) => {
  const nodeEnv = mode === 'development' ? 'development' : 'production';

  return {
    main: {
      resolve: { alias: { '@shared': sharedDir } },
      // The brand's default backend, baked in at build time exactly as the CLI bakes it via
      // tsdown. A packaged app inherits no shell environment, so reading it at runtime would
      // always be empty; substituting only this one expression leaves every other
      // `process.env` lookup in main working normally. Empty for an unbranded fork, which
      // then has no hosted option in the environment picker.
      define: {
        'process.env.B4M_DEFAULT_API_URL': JSON.stringify(bakedApiUrl(mode)),
      },
      // `@bike4mind/utils` is bundled rather than left external, and only main does this.
      // Main uses one subpath of it, `/artifactParser` - 20 kB that imports nothing but
      // `@bike4mind/common` and `@bike4mind/observability`. Externalizing it made
      // electron-builder ship that package's whole declared closure into the installer:
      // six AWS SDK clients, openai, jimp, tiktoken, xlsx, mammoth - roughly 150 MB of code
      // this app never calls, because the packaged tree is computed from package.json, not
      // from what the bundle reaches. `@bike4mind/observability` has no dependencies of its
      // own and is bundled with it so the emitted chunk has no undeclared external left.
      plugins: [externalizeDepsPlugin({ exclude: ['@bike4mind/utils', '@bike4mind/observability'] })],
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
