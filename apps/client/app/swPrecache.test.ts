// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { precacheGlobIgnores } from './swPrecache';

const ignored = (file: string) => precacheGlobIgnores.some(glob => path.matchesGlob(file, glob));

describe('precacheGlobIgnores', () => {
  it('excludes PDF data with the manifest builder Serwist actually uses', async () => {
    // Resolve through the installed integration so the probe uses its exact build dependency.
    const require = createRequire(import.meta.url);
    const serwistRequire = createRequire(require.resolve('@serwist/turbopack/package.json'));
    const {
      getManifest,
    }: {
      getManifest: (options: {
        globDirectory: string;
        globPatterns: string[];
        globIgnores: string[];
      }) => Promise<{ manifestEntries: { url: string }[] }>;
    } = await import(pathToFileURL(serwistRequire.resolve('@serwist/build')).href);
    const directory = mkdtempSync(path.join(tmpdir(), 'sw-precache-'));
    const files = [
      'public/pdfjs-assets-6.3.289/cmaps/LICENSE',
      'public/pdfjs-assets-6.3.289/wasm/LICENSE_OPENJPEG.txt',
      'public/pdfjs-assets-6.3.289/standard_fonts/FoxitSerif.pfb',
      'public/pdfjs-assets-7.0.0/iccs/profile.icc',
      'public/pdf.worker-6.3.289.min.mjs',
      'public/favicon.ico',
      '.next/static/chunks/main.js',
    ];
    try {
      for (const file of files) {
        const destination = path.join(directory, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file);
      }
      const options = { globDirectory: directory, globPatterns: ['public/**/*', '.next/static/**/*'] };
      const baseline = await getManifest({ ...options, globIgnores: [] });
      expect(baseline.manifestEntries.map(entry => entry.url).sort()).toEqual([...files].sort());
      const filtered = await getManifest({ ...options, globIgnores: precacheGlobIgnores });
      expect(filtered.manifestEntries.map(entry => entry.url).sort()).toEqual([
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
