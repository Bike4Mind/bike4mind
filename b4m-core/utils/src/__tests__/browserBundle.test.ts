import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { build, type Metafile, type Plugin } from 'esbuild';

const utilsRoot = fileURLToPath(new URL('../..', import.meta.url));

// Stubbing @bike4mind/common keeps the recorded env reads down to this package and observability.
const stubCommon: Plugin = {
  name: 'stub-common',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@bike4mind\/common$/ }, () => ({ path: 'common', namespace: 'stub' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents:
        "export const ARTIFACT_ATTRS_PATTERN = '';\n" +
        'export const ArtifactType = {};\n' +
        'export const ArtifactOperation = {};\n' +
        'export const mapMimeTypeToArtifactType = () => undefined;\n',
      loader: 'js',
    }));
  },
};

// metafile.inputs lists tree-shaken files too; only outputs[*].inputs reflects emitted bytes.
function emittedInputs(metafile: Metafile, match: (path: string) => boolean): string[] {
  return Object.values(metafile.outputs).flatMap(output =>
    Object.entries(output.inputs)
      .filter(([path, info]) => match(path) && info.bytesInOutput > 0)
      .map(([path]) => path)
  );
}

describe('esbuild bundles of utils', () => {
  const originalEnv = process.env;
  let tempDir: string | undefined;

  afterEach(() => {
    process.env = originalEnv;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reads no env keys when the bundle is evaluated', async () => {
    const result = await build({
      entryPoints: [join(utilsRoot, 'src/artifactParser.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      plugins: [stubCommon],
    });

    tempDir = mkdtempSync(join(tmpdir(), 'utils-browser-bundle-'));
    const bundlePath = join(tempDir, 'artifactParser.mjs');
    writeFileSync(bundlePath, result.outputFiles[0].text);

    const readKeys: string[] = [];
    process.env = new Proxy(
      { ...originalEnv },
      {
        get(target, key) {
          if (typeof key === 'string') readKeys.push(key);
          return Reflect.get(target, key);
        },
        has(target, key) {
          if (typeof key === 'string') readKeys.push(key);
          return Reflect.has(target, key);
        },
        ownKeys(target) {
          readKeys.push('<enumerate>');
          return Reflect.ownKeys(target);
        },
      }
    );
    const mod = await import(/* @vite-ignore */ pathToFileURL(bundlePath).href);

    expect(typeof mod.parseArtifacts).toBe('function');
    expect(readKeys).toEqual([]);
  });

  it('drops the whole utils barrel for an unused import (needs utils sideEffects: false)', async () => {
    // Without the flag esbuild keeps every barrel module whose top-level code it cannot prove pure
    // (most of them today). The js loader matters: the ts loader elides unused imports outright.
    const result = await build({
      stdin: {
        contents: `import { Logger } from ${JSON.stringify(join(utilsRoot, 'src/index.ts'))};\nexport const x = 1;\n`,
        resolveDir: utilsRoot,
        loader: 'js',
      },
      bundle: true,
      platform: 'node',
      packages: 'external',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });

    expect(emittedInputs(result.metafile, path => path !== '<stdin>')).toEqual([]);
  });

  it('leaves no observability bytes in a browser bundle for an unused Logger import', async () => {
    // Holds while either observability's sideEffects flag or the pure lazy globalInstance stays;
    // it does not isolate the flag.
    const result = await build({
      stdin: {
        contents: "import { Logger } from '@bike4mind/observability';\nexport const x = 1;\n",
        resolveDir: utilsRoot,
        loader: 'js',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });

    expect(emittedInputs(result.metafile, path => path.includes('observability'))).toEqual([]);
  });
});
