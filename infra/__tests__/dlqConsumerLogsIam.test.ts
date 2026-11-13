/**
 * @vitest-environment node
 *
 * The admin DLQ logs link reads consumer Lambda configs from the web function. infra/ is an SST
 * program and does not load outside `sst`, so this is a text match like remoteMcpIsolation.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
const source = read('infra/web.ts');

function statementFor(action: string): string {
  const at = source.indexOf(`'${action}'`);
  expect(at, `${action} statement`).toBeGreaterThan(-1);
  const start = source.lastIndexOf('{', at);
  return source.slice(start, source.indexOf('}', at) + 1);
}

function consumerList(): string[] {
  const body = source.match(/const dlqConsumerFunctionArns = \[([^\]]*)\]\.map\(/)?.[1];
  expect(body, 'dlqConsumerFunctionArns list').toBeDefined();
  return (body ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

describe('web function DLQ consumer log permissions', () => {
  it('grants lambda:ListEventSourceMappings', () => {
    expect(statementFor('lambda:ListEventSourceMappings')).toMatch(/resources:\s*\[\s*'\*'\s*\]/);
  });

  it('grants GetFunctionConfiguration only on the subscriber function ARNs, never a pattern', () => {
    const statement = statementFor('lambda:GetFunctionConfiguration');
    expect(statement).toMatch(/resources:\s*dlqConsumerFunctionArns\s*\}/);
    expect(statement).not.toContain('*');
    expect(source).toMatch(
      /const dlqConsumerFunctionArns = \[[^\]]*\]\.map\(subscription => subscription\.nodes\.function\.arn\);/
    );
    expect(source).toMatch(/role:\s*web\.nodes\.server\.nodes\.role\.name/);
  });

  it('lists every core queue subscriber', () => {
    const listed = new Set(consumerList());
    const infraFiles = readdirSync(path.join(REPO_ROOT, 'infra'))
      .filter(f => f.endsWith('.ts'))
      .map(f => read(`infra/${f}`));
    const subscribeCalls = infraFiles.flatMap(src => [...src.matchAll(/\w+Queue\.subscribe\(/g)]);
    const expected = infraFiles.flatMap(src =>
      [...src.matchAll(/^(?:export )?const (\w+Subscription) = \w+Queue\.subscribe\(/gm)].map(m => m[1])
    );
    expect(expected.length).toBeGreaterThan(30);
    // An unassigned subscribe cannot be listed, so its consumer would silently get no logs link.
    expect(expected).toHaveLength(subscribeCalls.length);
    expect(expected.filter(name => !listed.has(name))).toEqual([]);
  });

  it('grants GetFunctionConfiguration nowhere else', () => {
    expect(source.match(/lambda:GetFunctionConfiguration/g)).toHaveLength(1);
  });

  it('hardcodes no account id', () => {
    expect(source).not.toMatch(/\b\d{12}\b/);
  });
});
