import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const walked = vi.hoisted(() => ({ reads: 0 }));

// Each folder read is slowed so a walk over the fixture outlasts the deadline by a wide margin.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    walked.reads++;
    await new Promise(resolve => setTimeout(resolve, 2));
    return actual.readdir(...args);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const { scanShell } = await import('./shellScan');

describe('a scan past its deadline', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-scan-deadline-')));
    for (let index = 0; index < 400; index++) await mkdir(join(root, 'tree', `d${index}`), { recursive: true });
  });

  it('stops walking once it has answered', async () => {
    const started = Date.now();
    expect(await scanShell('cp -r tree out', root, [root], 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    const atExpiry = walked.reads;
    expect(atExpiry).toBeGreaterThan(0);
    let longest = 0;
    let last = Date.now();
    const until = last + 200;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const now = Date.now();
      longest = Math.max(longest, now - last);
      last = now;
    }
    expect(walked.reads - atExpiry).toBeLessThanOrEqual(1);
    expect(longest).toBeLessThan(50);
  });

  it('reads a long brace word in one pass', async () => {
    const started = Date.now();
    await scanShell(`a{${','.repeat(16000)}`, root, [root]);
    expect(Date.now() - started).toBeLessThan(150);
    expect((await scanShell('C{D,}PATH=x ls', root, [root]))?.unread).toBe(true);
  });
});
