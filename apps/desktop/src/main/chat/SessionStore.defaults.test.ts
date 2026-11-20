import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalModePreference } from './ApprovalModePreference';
import { PromptCacheTtlPreference } from './PromptCacheTtlPreference';
import { SessionStore } from './SessionStore';

describe('read-only new-session defaults', () => {
  it.each(['ask', 'auto', 'full'] as const)(
    'reuses normalized remembered %s preferences without creating a session',
    async remembered => {
      const base = await mkdtemp(join(tmpdir(), 'b4m-draft-defaults-'));
      const sessions = join(base, 'sessions');
      const approvalFile = join(base, 'approval.json');
      const cacheFile = join(base, 'cache.json');
      const approvals = new ApprovalModePreference(approvalFile);
      const cache = new PromptCacheTtlPreference(cacheFile);
      await approvals.record(remembered);
      await cache.record('1h');
      const before = await Promise.all([readFile(approvalFile, 'utf8'), readFile(cacheFile, 'utf8')]);
      const store = new SessionStore(sessions, 'build-model', 'launch', undefined, approvals, 'high', cache);
      const defaults = await store.defaultsForNewSession('effective-model');
      expect(defaults).toEqual({
        model: 'effective-model',
        approvalMode: remembered === 'full' ? 'auto' : remembered,
        reasoningEffort: 'high',
        promptCacheTtl: '1h',
      });
      await expect(stat(sessions)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await Promise.all([readFile(approvalFile, 'utf8'), readFile(cacheFile, 'utf8')])).toEqual(before);
      expect(await store.create('effective-model')).toMatchObject(defaults);
    }
  );
});
