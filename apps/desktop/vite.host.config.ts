import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { baked, copyTreeSitterWasm, devVersionInfo, PRODUCTION_API_URL } from './buildShared';

/**
 * The headless host, `out/host/b4m-host.cjs`: a plain-Node program with every dependency bundled,
 * so it runs from a folder copied to a machine with Node and nothing else. The entry holds only
 * the CLI; the daemon and connect load from chunks beside it on demand, which lets the Node
 * version check run before anything that needs a newer Node is loaded. All chunks sit in one
 * folder because the shell parser finds its wasm at `<chunk dir>/wasm`.
 */
export default defineConfig(({ mode }) => {
  const packageVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string })
    .version;
  return {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@bike4mind/cli/skills': resolve(__dirname, '../../packages/cli/src/skills/index.ts'),
      },
    },
    // Baked the same way as the Electron main bundle; see electron.vite.config.ts.
    define: {
      'process.env.B4M_DEFAULT_API_URL': JSON.stringify(
        baked(mode, 'B4M_DEFAULT_API_URL') || (mode === 'development' ? '' : PRODUCTION_API_URL)
      ),
      __B4M_HOST_VERSION__: JSON.stringify(devVersionInfo().version || packageVersion),
    },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: resolve(__dirname, 'src/host/headless/bin.ts'),
      outDir: resolve(__dirname, 'out/host'),
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        // A headless host never has Electron; left external so an import of it fails loudly at run time.
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'b4m-host.cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
    plugins: [copyTreeSitterWasm()],
  };
});
