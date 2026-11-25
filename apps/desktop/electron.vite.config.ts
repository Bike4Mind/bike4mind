import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import { baked, copyTreeSitterWasm, devVersionInfo, PRODUCTION_API_URL } from './buildShared';

const sharedDir = resolve(__dirname, 'src/shared');
// Imported from source: the published CLI is bin-only and ships no skills entry point.
const cliSkills = resolve(__dirname, '../../packages/cli/src/skills/index.ts');
// See the shim's own header: @bike4mind/common's barrel statically imports node:crypto,
// which a sandboxed renderer cannot resolve.
const nodeCryptoShim = resolve(__dirname, 'src/renderer/src/shims/nodeCrypto.ts');

/**
 * Puts the manifold-3d engine (Apache-2.0) beside the main bundle, in `model3d/`. The b4m-model:
 * protocol (src/main/chat/model3d/engineProtocol.ts) serves these files to the sandboxed engine
 * frame by path, so no bundler ever sees an import for them.
 */
function copyManifoldEngine(): Plugin {
  const require = createRequire(join(__dirname, 'package.json'));
  // LICENSE is not in the package's exports map, so it is found beside the wasm instead.
  const packageDir = dirname(require.resolve('manifold-3d/manifold.wasm'));
  const files = ['manifold.js', 'manifold.wasm', 'LICENSE'];
  return {
    name: 'copy-manifold-engine',
    writeBundle(options) {
      const target = join(options.dir ?? resolve(__dirname, 'out/main'), 'model3d');
      mkdirSync(target, { recursive: true });
      for (const file of files) copyFileSync(join(packageDir, file), join(target, file));
    },
  };
}

/**
 * Writes `curated-build.json` beside the main bundle with the curated values this build baked in, so
 * packages/scripts `curated:check-build` can fail a release that trusts the test keys or bakes a non-https URL.
 */
function curatedBuildInfo(info: { devKeys: boolean; manifestUrl: string }): Plugin {
  return {
    name: 'curated-build-info',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'curated-build.json', source: `${JSON.stringify(info)}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const devVersion = devVersionInfo();
  const nodeEnv = mode === 'development' ? 'development' : 'production';
  const curatedUrl = baked(mode, 'B4M_CURATED_MANIFEST_URL');
  const curatedDevKeys = process.env.B4M_CURATED_DEV_KEYS === '1';

  return {
    main: {
      resolve: { alias: { '@shared': sharedDir, '@bike4mind/cli/skills': cliSkills } },
      // The brand's default backend, baked in at build time exactly as the CLI bakes it via
      // tsdown. A packaged app inherits no shell environment, so reading it at runtime would
      // always be empty; substituting only this one expression leaves every other
      // `process.env` lookup in main working normally.
      // The release feed is baked in the same way and for the same reasons, plus one more:
      // this repo is public, and a feed url is a host or a bucket behind one. Empty for a fork,
      // which then builds an app with updates switched off rather than one pointed at ours.
      // The signed curated models list is baked the same way; empty means the bundled list only. The test keys
      // need B4M_CURATED_DEV_KEYS=1 in the shell (never `.env`); see curatedBuildInfo for the release gate.
      define: {
        // Not in development: an empty default there lets a source run fall back to Local Dev.
        'process.env.B4M_DEFAULT_API_URL': JSON.stringify(
          baked(mode, 'B4M_DEFAULT_API_URL') || (mode === 'development' ? '' : PRODUCTION_API_URL)
        ),
        'process.env.B4M_UPDATE_FEED_URL': JSON.stringify(baked(mode, 'B4M_UPDATE_FEED_URL')),
        // The keys the feed's manifest signatures must verify under; empty keeps unsigned manifests.
        'process.env.B4M_UPDATE_PUBLIC_KEYS': JSON.stringify(baked(mode, 'B4M_UPDATE_PUBLIC_KEYS')),
        'process.env.B4M_CURATED_MANIFEST_URL': JSON.stringify(curatedUrl),
        __B4M_CURATED_DEV_KEYS__: JSON.stringify(curatedDevKeys),
        __B4M_DEV_VERSION__: JSON.stringify(devVersion.version),
        __B4M_DEV_VERSION_BASIS__: JSON.stringify(devVersion.basis),
      },
      // `@bike4mind/utils` is bundled rather than left external, and only main does this.
      // Main uses one subpath of it, `/artifactParser` - 20 kB that imports nothing but
      // `@bike4mind/common` and `@bike4mind/observability`. Externalizing it made
      // electron-builder ship that package's whole declared closure into the installer:
      // six AWS SDK clients, openai, jimp, tiktoken, xlsx, mammoth - roughly 150 MB of code
      // this app never calls, because the packaged tree is computed from package.json, not
      // from what the bundle reaches. `@bike4mind/observability` has no dependencies of its
      // own and is bundled with it so the emitted chunk has no undeclared external left.
      plugins: [
        externalizeDepsPlugin({ exclude: ['@bike4mind/utils', '@bike4mind/observability'] }),
        copyTreeSitterWasm(),
        copyManifoldEngine(),
        curatedBuildInfo({ devKeys: curatedDevKeys, manifestUrl: curatedUrl }),
      ],
    },
    preload: {
      resolve: { alias: { '@shared': sharedDir } },
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          // The app's preload and the two floating windows' narrow ones (main/floatingWindow.ts). All are
          // sandboxed, which cannot load a shared chunk, so mini.ts and orchestrateMini.ts import nothing
          // at runtime but electron (see their *_CHANNELS).
          input: {
            index: resolve(__dirname, 'src/preload/index.ts'),
            mini: resolve(__dirname, 'src/preload/mini.ts'),
            orchestrateMini: resolve(__dirname, 'src/preload/orchestrateMini.ts'),
          },
        },
      },
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
