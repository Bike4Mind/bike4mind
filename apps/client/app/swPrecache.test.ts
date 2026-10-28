// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { precacheGlobIgnores } from './swPrecache';

const ignored = (file: string) => precacheGlobIgnores.some(glob => path.matchesGlob(file, glob));

describe('precacheGlobIgnores', () => {
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
