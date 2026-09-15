import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Makes the MCP registry entry's pairings real rather than documented.
 *
 * docs/MCP-REGISTRY.md states both of these as MUSTs, and neither was checked
 * anywhere - so the entry sat pinned to a version that did not exist yet, which
 * is the same class of failure the packaging fix addressed (a registry entry
 * pointing at something nobody can install), one layer up.
 */
const repoRoot = resolve(__dirname, '../../..');
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8'));

describe('MCP registry entry', () => {
  const pkg = readJson('packages/cli/package.json');
  const server = readJson('mcp-registry/server.json');

  it('declares mcpName matching the registry server name', () => {
    // The registry validates ownership by fetching the published package and
    // comparing its mcpName to server.json's name. A mismatch fails the publish.
    expect(pkg.mcpName).toBe(server.name);
  });

  it('pins the version the CLI is actually at', () => {
    // Never forward-date this. changesets decides the next version at release
    // time (a minor changeset landing first makes it 0.21.0, not 0.20.2), so a
    // guess here points the registry at a version that was never published.
    // Bump server.json in the same commit that bumps the package.
    expect(server.version).toBe(pkg.version);
  });

  it('keeps the nested package version in step with the top-level one', () => {
    expect(server.packages[0].version).toBe(server.version);
  });

  it('points at the published package name', () => {
    expect(server.packages[0].identifier).toBe(pkg.name);
  });
});
