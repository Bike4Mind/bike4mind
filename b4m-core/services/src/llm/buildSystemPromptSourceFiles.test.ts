import { describe, it, expect } from 'vitest';
import { buildSystemPromptSourceFiles } from './buildSystemPromptSourceFiles';

describe('buildSystemPromptSourceFiles', () => {
  it('tags each bucket with its own source and resolves fileName from the map', () => {
    const fabFileNameById = new Map([
      ['file-admin', 'admin-prompt.md'],
      ['file-user', 'user-prompt.md'],
      ['file-session', 'session-prompt.md'],
    ]);

    const result = buildSystemPromptSourceFiles(fabFileNameById, {
      global: ['file-admin'],
      userEnabled: ['file-user'],
      project: ['file-project'],
      session: ['file-session'],
    });

    expect(result).toEqual([
      { fileId: 'file-admin', fileName: 'admin-prompt.md', source: 'admin', enabled: true },
      { fileId: 'file-user', fileName: 'user-prompt.md', source: 'user', enabled: true },
      { fileId: 'file-project', fileName: undefined, source: 'project', enabled: true },
      { fileId: 'file-session', fileName: 'session-prompt.md', source: 'session', enabled: true },
    ]);
  });

  it('never populates a content field, even when the caller tries to pass one through', () => {
    const result = buildSystemPromptSourceFiles(new Map(), {
      global: ['file-1'],
      userEnabled: [],
      project: [],
      session: [],
    });
    expect(result[0]).not.toHaveProperty('content');
  });

  it('returns an empty array when every bucket is empty', () => {
    const result = buildSystemPromptSourceFiles(new Map(), { global: [], userEnabled: [], project: [], session: [] });
    expect(result).toEqual([]);
  });

  it('leaves fileName undefined for an id missing from the map, rather than throwing', () => {
    const result = buildSystemPromptSourceFiles(new Map(), {
      global: [],
      userEnabled: [],
      project: [],
      session: ['deleted-file-id'],
    });
    expect(result).toEqual([{ fileId: 'deleted-file-id', fileName: undefined, source: 'session', enabled: true }]);
  });
});
