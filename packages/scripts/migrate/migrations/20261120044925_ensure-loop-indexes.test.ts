import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionModel, Inbox, WorkItem } from '@bike4mind/database';
import migration, { ensureIndexes, LOOP_INDEXES } from './20261120044925_ensure-loop-indexes';

const models = [
  [AgentExecutionModel, LOOP_INDEXES.agentExecution],
  [WorkItem, LOOP_INDEXES.workItem],
  [Inbox, LOOP_INDEXES.inbox],
] as const;

afterEach(() => vi.restoreAllMocks());

describe('loop indexes migration', () => {
  it('builds each named index with its schema options, and no other', async () => {
    const calls = models.map(([model]) => vi.spyOn(model.collection, 'createIndex').mockResolvedValue('ok'));
    await migration.up();
    models.forEach(([model, keys], i) => {
      expect(calls[i].mock.calls.map(([fields]) => fields)).toEqual(keys);
      for (const [fields, options] of calls[i].mock.calls) {
        const declared = model.schema.indexes().find(([key]) => JSON.stringify(key) === JSON.stringify(fields));
        expect(options).toEqual(declared?.[1]);
      }
    });
  });

  it('throws when a schema no longer declares a named index', async () => {
    vi.spyOn(Inbox.collection, 'createIndex').mockResolvedValue('ok');
    await expect(ensureIndexes(Inbox, [{ gone: 1 }])).rejects.toThrow('declares no {"gone":1} index');
  });
});
