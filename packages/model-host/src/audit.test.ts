import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditLog } from './audit';

describe('createAuditLog', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('keeps appending when the log was deleted just as it was due to rotate', async () => {
    dir = await mkdtemp(join(tmpdir(), 'b4m-audit-'));
    const { audit, path, flush } = createAuditLog(
      dir,
      () => {},
      () => new Date(0),
      300
    );
    audit({ event: 'create', detail: 'x'.repeat(200) });
    await flush();
    await rm(path);
    audit({ event: 'done', detail: 'y'.repeat(50) });
    audit({ event: 'remove', ref: 'tiny:1b' });
    await flush();
    const events = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).event);
    expect(events).toEqual(['done', 'remove']);
  });
});
