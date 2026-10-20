import { describe, it, expect } from 'vitest';
import {
  dataLakeConfigListResponseSchema,
  dataLakeListResponseSchema,
  dataLakeResponseSchema,
} from './dataLakeResponse';

const RAW_KEYS = { _id: 'raw-object-id', __v: 7, notInSchema: 'secret' };

describe('dataLakeResponseSchema', () => {
  it('keeps lake fields and strips Mongo internals and undeclared keys', () => {
    const lastSyncAt = new Date('2026-10-01T00:00:00Z');
    const lake = { id: 'lake1', name: 'Docs', systemPrompt: 'Be terse.', lastSyncAt, ...RAW_KEYS };

    expect(dataLakeResponseSchema.parse(lake)).toEqual({
      id: 'lake1',
      name: 'Docs',
      systemPrompt: 'Be terse.',
      lastSyncAt,
    });
  });

  it('does not add keys a reader projection left out', () => {
    const reader = { id: 'lake1', name: 'Docs' };

    expect(dataLakeResponseSchema.parse(reader)).not.toHaveProperty('systemPrompt');
  });

  it('strips per row in the archived/deleted list shape', () => {
    const parsed = dataLakeListResponseSchema.parse({ data: [{ id: 'a', ...RAW_KEYS }, { id: 'b' }] });

    expect(parsed).toEqual({ data: [{ id: 'a' }, { id: 'b' }] });
  });
});

describe('dataLakeConfigListResponseSchema', () => {
  it('keeps the manager-only projection fields and the retrievability label', () => {
    const row = {
      id: 'lake1',
      slug: 'docs',
      name: 'Docs',
      fileTagPrefix: 'docs:',
      datalakeTag: 'datalake:docs',
      isOwn: true,
      isCreator: true,
      canPreauthorize: false,
      canRebuild: true,
      canManageSettings: true,
      canManageMemory: false,
      pendingProposalCount: 2,
      retrievable: true,
      ...RAW_KEYS,
    };

    const { _id: _rawId, __v: _version, notInSchema: _extra, ...expected } = row;
    expect(dataLakeConfigListResponseSchema.parse({ data: [row] })).toEqual({ data: [expected] });
  });
});
