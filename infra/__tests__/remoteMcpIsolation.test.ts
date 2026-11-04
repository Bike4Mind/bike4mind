/**
 * @vitest-environment node
 *
 * remoteMcpHandler calls user-supplied hosts, so it must hold no VPC route and no secrets. infra/ is
 * an SST program and does not load outside `sst`, so this is a text match like mcpInstallCoverage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('remoteMcpHandler isolation', () => {
  const source = stripComments(read('infra/remoteMcp.ts'));

  it('is the worker entry, declared once', () => {
    expect(source.match(/new sst\.aws\.Function\(/g)).toHaveLength(1);
    expect(source).toContain("'apps/workers/src/mcp/remoteMcpCall.handler'");
  });

  it('has no VPC and links no resources', () => {
    expect(source).not.toMatch(/\bvpc\b/i);
    expect(source).not.toMatch(/\blink\s*:/);
    expect(source).not.toMatch(/\bsecrets\b/);
  });

  it('is linked from web so it can be invoked', () => {
    expect(stripComments(read('infra/web.ts'))).toMatch(/link:\s*\[[^\]]*\bremoteMcpHandler\b/s);
  });
});
