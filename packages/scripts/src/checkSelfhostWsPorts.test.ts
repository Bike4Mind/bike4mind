import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The self-host ws gateway serves browsers on 3001 and its management API on 3002
 * (selfhost/ws-gateway/gateway.mjs). Only 3001 may be published, and every service that pushes
 * through the gateway pins the 3002 endpoint in `environment:` so an older env file still pointing
 * at 3001 cannot win. The Kubernetes side of the same contract is in
 * selfhost/kubernetes/tests/test_package.py.
 *
 * Text-matched rather than YAML-parsed, like the other compose guards here: the repo has no YAML
 * parser dependency.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPOSE = readFileSync(path.join(REPO_ROOT, 'compose.selfhost.yaml'), 'utf8');

const PUSHING_SERVICES = ['app', 'agentexecutor', 'chatcompletion', 'worker', 'subscriber-fanout'];

/** The lines of one top-level service, from its `  name:` line up to the next service or section. */
const serviceBlock = (name: string): string[] => {
  const lines = COMPOSE.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`service ${name} not found in compose.selfhost.yaml`);
  const end = lines.findIndex((line, i) => i > start && /^( {2}[\w-]+:|\S)/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
};

/** The `- 'host:container'` entries under a service's `ports:` key. */
const portEntries = (block: string[]): string[] => {
  const start = block.findIndex(line => /^ {4}ports:\s*$/.test(line));
  if (start === -1) return [];
  const entries: string[] = [];
  for (const line of block.slice(start + 1)) {
    const entry = line.match(/^ {6}- ['"]?([^'"#]+?)['"]?\s*$/);
    if (!entry) break;
    entries.push(entry[1]);
  }
  return entries;
};

describe('compose.selfhost.yaml ws gateway ports', () => {
  it('publishes only the browser port of the ws gateway', () => {
    const entries = portEntries(serviceBlock('ws'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/:3001$/);
  });

  it('runs the management API on its own port', () => {
    expect(serviceBlock('ws')).toContain("      MANAGEMENT_PORT: '3002'");
  });

  it.each(PUSHING_SERVICES)('pins the management endpoint for %s', name => {
    expect(serviceBlock(name)).toContain('      WEBSOCKET_MANAGEMENT_ENDPOINT: http://ws:3002');
  });
});
