import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';

// Env keys the Logger constructor in @bike4mind/observability reads.
const LOGGER_ENV_KEYS = ['IS_LOCAL', 'NODE_ENV', 'SST_LIVE', 'LOG_JSON', 'LOG_PRETTY', 'LOG_LEVEL'];
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

describe('browser bundle of artifactParser', () => {
  const originalEnv = process.env;
  let tempDir: string | undefined;

  afterEach(() => {
    process.env = originalEnv;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reads none of the Logger env keys when the bundle is evaluated', async () => {
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
      }
    );
    const mod = await import(/* @vite-ignore */ pathToFileURL(bundlePath).href);

    expect(typeof mod.parseArtifacts).toBe('function');
    expect(readKeys.filter(key => LOGGER_ENV_KEYS.includes(key))).toEqual([]);
  });

  it('leaves no observability bytes in the output for an unused Logger import', async () => {
    const result = await build({
      stdin: {
        contents: "import { Logger } from '@bike4mind/observability';\nexport const x = 1;\n",
        resolveDir: utilsRoot,
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });

    // metafile.inputs lists tree-shaken files too; only outputs[*].inputs reflects emitted bytes.
    const emittedObservability = Object.values(result.metafile.outputs).flatMap(output =>
      Object.entries(output.inputs).filter(([path, info]) => path.includes('observability') && info.bytesInOutput > 0)
    );
    expect(emittedObservability).toEqual([]);
  });
});
