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
    expect(source).not.toMatch(/\blink\b/);
    expect(source).not.toMatch(/\bsecrets\b/);
    expect(source).not.toMatch(/\bpermissions\s*:/);
    expect(source).toMatch(/environment:\s*\{\s*\.\.\.DEFAULT_LAMBDA_ENVIRONMENT\s*\}/);
  });

  it('inherits no VPC, link or secret-bearing env from the global Function transform or defaults', () => {
    const config = stripComments(read('sst.config.ts'));
    const start = config.indexOf('$transform(sst.aws.Function');
    expect(start).toBeGreaterThan(-1);
    const block = config.slice(start, config.indexOf('\n    });', start));
    expect(block).not.toMatch(/\bvpc\b/i);
    expect(block).not.toMatch(/\blink\b/);

    const constants = stripComments(read('infra/constants.ts'));
    const defStart = constants.indexOf('export const DEFAULT_LAMBDA_ENVIRONMENT');
    expect(defStart).toBeGreaterThan(-1);
    const defs = constants.slice(defStart, constants.indexOf('\n};', defStart));
    const keys = [...defs.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter(k => /secret|token|password|key|uri/i.test(k))).toEqual([]);
  });

  it('is linked from web so it can be invoked', () => {
    expect(stripComments(read('infra/web.ts'))).toMatch(/link:\s*\[[^\]]*\bremoteMcpHandler\b/s);
  });
});
