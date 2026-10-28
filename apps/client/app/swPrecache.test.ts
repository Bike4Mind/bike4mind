// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PUBLIC_PRECACHE_CEILING,
  precacheGlobIgnores,
  precacheManifestTransforms,
  rejectExtensionlessEntries,
} from './swPrecache';

const ignored = (file: string) => precacheGlobIgnores.some(glob => path.matchesGlob(file, glob));

type ManifestEntry = { url: string };
type GetManifest = (options: {
  globDirectory: string;
  globPatterns: string[];
  globIgnores: string[];
  manifestTransforms?: typeof precacheManifestTransforms;
}) => Promise<{ manifestEntries: ManifestEntry[] }>;

/** Resolves through the installed integration so the probe uses its exact build dependency. */
async function loadGetManifest(): Promise<GetManifest> {
  const require = createRequire(import.meta.url);
  const serwistRequire = createRequire(require.resolve('@serwist/turbopack/package.json'));
  const { getManifest }: { getManifest: GetManifest } = await import(
    pathToFileURL(serwistRequire.resolve('@serwist/build')).href
  );
  return getManifest;
}

function writeFixture(files: string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'sw-precache-'));
  for (const file of files) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file);
  }
  return directory;
}

const urls = (result: { manifestEntries: ManifestEntry[] }) => result.manifestEntries.map(entry => entry.url).sort();

describe('precacheGlobIgnores', () => {
  it('excludes PDF data with the manifest builder Serwist actually uses', async () => {
    const getManifest = await loadGetManifest();
    const files = [
      'public/pdfjs-assets-6.3.289/cmaps/LICENSE',
      'public/pdfjs-assets-6.3.289/wasm/LICENSE_OPENJPEG.txt',
      'public/pdfjs-assets-6.3.289/standard_fonts/FoxitSerif.pfb',
      'public/pdfjs-assets-7.0.0/iccs/profile.icc',
      'public/pdf.worker-6.3.289.min.mjs',
      'public/favicon.ico',
      '.next/static/chunks/main.js',
    ];
    const directory = writeFixture(files);
    try {
      const options = { globDirectory: directory, globPatterns: ['public/**/*', '.next/static/**/*'] };
      const baseline = await getManifest({ ...options, globIgnores: [] });
      expect(urls(baseline)).toEqual([...files].sort());
      const filtered = await getManifest({ ...options, globIgnores: precacheGlobIgnores });
      expect(urls(filtered)).toEqual([
        '.next/static/chunks/main.js',
        'public/favicon.ico',
        'public/pdf.worker-6.3.289.min.mjs',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('drops every pdf.js data file, including the extensionless licenses, from the precache', () => {
    for (const file of [
      'public/pdfjs-assets-6.3.289/cmaps/LICENSE',
      'public/pdfjs-assets-6.3.289/wasm/LICENSE_JBIG2',
      'public/pdfjs-assets-6.3.289/standard_fonts/FoxitSerif.pfb',
      'public/pdfjs-assets-6.3.289/cmaps/UniJIS-UCS2-H.bcmap',
      'public/pdfjs-assets-7.0.0/iccs/CGATS001Compat-v2-micro.icc',
    ]) {
      expect(ignored(file), file).toBe(true);
    }
  });

  it('keeps the worker, the offline page assets and the rest of public/ precached', () => {
    for (const file of [
      'public/pdf.worker-6.3.289.min.mjs',
      'public/favicon.ico',
      'public/manifest.json',
      '.next/static/chunks/main.js',
    ]) {
      expect(ignored(file), file).toBe(false);
    }
  });
});

describe('rejectExtensionlessEntries', () => {
  it('passes a manifest where every entry has an extension through unchanged', () => {
    const manifest = [{ url: 'public/favicon.ico' }, { url: '.next/static/chunks/main.js' }];
    expect(rejectExtensionlessEntries(manifest)).toEqual({ manifest, warnings: [] });
  });

  it('names every extensionless entry, dotfiles included', () => {
    expect(() =>
      rejectExtensionlessEntries([
        { url: 'public/favicon.ico' },
        { url: 'public/fonts/LICENSE' },
        { url: 'public/fonts/.complete' },
      ])
    ).toThrow(/2 file\(s\) without an extension.*public\/fonts\/LICENSE, public\/fonts\/\.complete/);
  });

  it('fails the manifest build itself, not just a warning, when an extensionless file reaches public/', async () => {
    const getManifest = await loadGetManifest();
    const directory = writeFixture(['public/favicon.ico', 'public/fonts/LICENSE']);
    try {
      await expect(
        getManifest({
          globDirectory: directory,
          globPatterns: ['public/**/*'],
          globIgnores: precacheGlobIgnores,
          manifestTransforms: precacheManifestTransforms,
        })
      ).rejects.toThrow('public/fonts/LICENSE');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the real public/ directory', () => {
  // Runs the same builder and guard the route uses against the checked-in and generated public/
  // files, so a new extensionless file or a new asset dump fails here before it fails every install.
  it('passes the precache guard and stays under the entry ceiling', async () => {
    const getManifest = await loadGetManifest();
    const result = await getManifest({
      globDirectory: fileURLToPath(new URL('..', import.meta.url)),
      globPatterns: ['public/**/*'],
      globIgnores: precacheGlobIgnores,
      manifestTransforms: precacheManifestTransforms,
    });
    expect(result.manifestEntries.length).toBeGreaterThan(0);
    expect(result.manifestEntries.length).toBeLessThanOrEqual(PUBLIC_PRECACHE_CEILING);
  });
});
