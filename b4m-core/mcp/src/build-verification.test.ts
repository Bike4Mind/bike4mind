import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';

/**
 * Build verification tests - ensure the dist/ directory contains all required
 * artifacts. These catch build config regressions (e.g., missing entry points
 * in tsdown.config.ts) before they reach production.
 */
describe('Build verification', () => {
  const distDir = path.resolve(import.meta.dirname, '..', 'dist');

  describe('MCP server scripts must exist in dist/', () => {
    const servers = ['github', 'atlassian', 'linkedin', 'notion'];

    for (const server of servers) {
      it(`${server}/index.mjs should exist`, () => {
        const serverScript = path.join(distDir, server, 'index.mjs');
        expect(existsSync(serverScript), `Missing server script: ${serverScript}`).toBe(true);
      });
    }
  });

  describe('Library exports must exist in dist/', () => {
    const requiredFiles = ['index.mjs', 'index.cjs', 'index.d.mts', 'index.d.cts'];

    for (const file of requiredFiles) {
      it(`${file} should exist`, () => {
        expect(existsSync(path.join(distDir, file)), `Missing: dist/${file}`).toBe(true);
      });
    }
  });
});
