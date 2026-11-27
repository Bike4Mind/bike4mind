import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The renderer function runs author-supplied pages, so it is deployed without application
 * credentials (infra/queues.ts: PublishThumbnailRenderer) and its code must not reach for any:
 * no sst Resource, no Config, no @bike4mind/* package, no apps/client code, no AWS SDK. This walks
 * the static and dynamic import graph of the handler and fails on anything outside the allowlist,
 * so a convenient import added later cannot quietly pull secrets-reading code into the bundle.
 */

const MEDIA_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(MEDIA_DIR, 'publishThumbnailRenderer.ts');
/** Packages the renderer may load: the browser, the encoder, and schema validation. Nothing reads config. */
const ALLOWED_PACKAGES = new Set(['playwright-core', '@sparticuz/chromium', 'sharp', 'zod']);
/**
 * The only modules that may read the process environment: one copies an explicit allowlist into the
 * browser, the other reads the local Runtime API address it posts each outcome to.
 */
const MAY_READ_ENV = new Set(['launchLambdaChromium.ts', 'lambdaRuntimeExit.ts']);
const BUILTINS = new Set(builtinModules);

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map(entry => entry.fileName);
}

function resolveRelative(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  const candidate = [base, `${base}.ts`, path.join(base, 'index.ts')].find(p => existsSync(p) && p.endsWith('.ts'));
  if (!candidate) throw new Error(`cannot resolve ${specifier} from ${from}`);
  return candidate;
}

function walk(): { files: string[]; packages: string[]; violations: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const violations: string[] = [];
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const where = `${path.relative(MEDIA_DIR, file)} imports "${specifier}"`;
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (path.dirname(target) !== MEDIA_DIR) violations.push(`${where}, outside apps/workers/src/media`);
        else queue.push(target);
      } else if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
        continue;
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        packages.add(name);
        if (!ALLOWED_PACKAGES.has(name)) violations.push(where);
      }
    }
  }
  return { files: [...seen].map(f => path.relative(MEDIA_DIR, f)).sort(), packages: [...packages].sort(), violations };
}

describe('publish thumbnail renderer isolation', () => {
  const graph = walk();

  it('imports nothing beyond its siblings and the browser, encoder and schema packages', () => {
    expect(graph.violations).toEqual([]);
    expect(graph.files).toEqual([
      'lambdaRuntimeExit.ts',
      'launchLambdaChromium.ts',
      'publishThumbnailRenderer.ts',
      'renderEnvironment.ts',
      'renderHtmlThumbnail.ts',
      'thumbnailRendererContract.ts',
    ]);
    expect(graph.packages).toEqual(['@sparticuz/chromium', 'playwright-core', 'sharp', 'zod']);
  });

  it('never references sst resources or application config', () => {
    for (const file of graph.files) {
      const source = readFileSync(path.join(MEDIA_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/\bResource\.|\bConfig\.|@bike4mind\/|from ['"]sst['"]|@aws-sdk\//);
    }
  });

  it('reads the process environment only for the browser allowlist and the Runtime API address', () => {
    const readers = graph.files.filter(file => /process\.env/.test(readFileSync(path.join(MEDIA_DIR, file), 'utf8')));
    expect(readers.filter(file => !MAY_READ_ENV.has(file))).toEqual([]);
    const runtimeExit = readFileSync(path.join(MEDIA_DIR, 'lambdaRuntimeExit.ts'), 'utf8');
    expect(runtimeExit.match(/process\.env(?:\.\w+|\[[^\]]*\])?/g)).toEqual(['process.env.AWS_LAMBDA_RUNTIME_API']);
  });

  it('would catch a forbidden import', () => {
    const fake = ts.preProcessFile("import { Config } from '@bike4mind/server-utils/utils/config';", true, true);
    expect(fake.importedFiles.map(entry => entry.fileName)).toEqual(['@bike4mind/server-utils/utils/config']);
  });
});
