import { describe, it, expect } from 'vitest';
import { buildSystemPromptSourceFiles } from './buildSystemPromptSourceFiles';

describe('buildSystemPromptSourceFiles', () => {
  it('tags each bucket with its own source and resolves fileName from the map', () => {
    const fabFileNameById = new Map([
      ['file-admin', 'admin-prompt.md'],
      ['file-user', 'user-prompt.md'],
    ]);

    const result = buildSystemPromptSourceFiles(fabFileNameById, {
      global: ['file-admin'],
      userEnabled: ['file-user'],
      project: ['file-project'],
    });

    expect(result).toEqual([
      { fileId: 'file-admin', fileName: 'admin-prompt.md', source: 'admin', enabled: true },
      { fileId: 'file-user', fileName: 'user-prompt.md', source: 'user', enabled: true },
      { fileId: 'file-project', fileName: undefined, source: 'project', enabled: true },
    ]);
  });

  it('never populates a content field, even when the caller tries to pass one through', () => {
    const result = buildSystemPromptSourceFiles(new Map(), {
      global: ['file-1'],
      userEnabled: [],
      project: [],
    });
    expect(result[0]).not.toHaveProperty('content');
  });

  it('returns undefined (not an empty array) when every bucket is empty', () => {
    // QuestModel.ts declares this field `default: undefined` specifically so it is never
    // persisted empty - an explicit [] would defeat that.
    const result = buildSystemPromptSourceFiles(new Map(), { global: [], userEnabled: [], project: [] });
    expect(result).toBeUndefined();
  });

  it('leaves fileName undefined for an id missing from the map, rather than throwing', () => {
    const result = buildSystemPromptSourceFiles(new Map(), {
      global: [],
      userEnabled: [],
      project: ['deleted-file-id'],
    });
    expect(result).toEqual([{ fileId: 'deleted-file-id', fileName: undefined, source: 'project', enabled: true }]);
  });

  it('does not include a session bucket - session-scoped file ids are workbench attachments, not system prompts', () => {
    // Non-empty buckets: an all-empty fixture now returns undefined (see the test above), which
    // would make `.every(...)` vacuously true regardless of whether a session bucket exists.
    const result = buildSystemPromptSourceFiles(new Map(), {
      global: ['file-admin'],
      userEnabled: ['file-user'],
      project: ['file-project'],
    });
    expect(result?.every(entry => entry.source !== ('session' as never))).toBe(true);
  });
});
