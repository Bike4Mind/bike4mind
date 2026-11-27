import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ok, envelope } from './results';
import { selectTools } from './register';
import { defineTool } from './tool';
import { parseToolsets, UnknownToolsetError } from './toolsets';

const ids = (raw: Parameters<typeof parseToolsets>[0]) => [...parseToolsets(raw)].sort();

describe('parseToolsets', () => {
  it('parses comma and space separated, trimmed, lower-cased, deduped', () => {
    expect(ids(' About , JOBS about')).toEqual(['about', 'jobs']);
  });
  it('always includes jobs', () => expect(ids('about')).toEqual(['about', 'jobs']));
  it('handles all, default, empty and undefined', () => {
    expect(ids('all')).toEqual(['about', 'jobs']);
    expect(ids('default')).toEqual(['about', 'jobs']);
    expect([...parseToolsets('all', [])].sort()).toEqual(['about', 'jobs']);
    expect([...parseToolsets('default', [])]).toEqual(['jobs']);
    expect([...parseToolsets('', [])]).toEqual(['jobs']);
    expect(ids('')).toEqual(['about', 'jobs']);
    expect(ids(undefined)).toEqual(['about', 'jobs']);
  });
  it('accepts a repeated query param as an array', () => expect(ids(['about', 'jobs'])).toEqual(['about', 'jobs']));
  it('throws a typed error naming the valid ids', () => {
    const run = () => parseToolsets('about,nope,zzz');
    expect(run).toThrow(UnknownToolsetError);
    expect(run).toThrow(/nope, zzz.*about/);
  });
});

const fixture = (name: string, scope: string | null, toolset: 'about' | 'jobs' = 'about') =>
  defineTool({
    name,
    title: name,
    description: name,
    toolset,
    scope,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
    outputSchema: envelope(z.object({})),
    handler: async () => ok({}),
  });

describe('selectTools', () => {
  const tools = [
    fixture('zz_keyless', null),
    fixture('aa_chat', 'ai:chat'),
    fixture('mm_files', 'files:read'),
    fixture('bb_jobs', null, 'jobs'),
  ];
  const names = (ctx: Parameters<typeof selectTools>[0]) => selectTools(ctx, tools).map(t => t.name);

  it('keeps keyless tools when the key holds no scopes', () => {
    expect(names({ toolsets: parseToolsets('all'), scopes: [] })).toEqual(['bb_jobs', 'zz_keyless']);
  });
  it('drops tools whose scope is not held and keeps the rest, sorted', () => {
    expect(names({ toolsets: parseToolsets('all'), scopes: ['ai:chat'] })).toEqual([
      'aa_chat',
      'bb_jobs',
      'zz_keyless',
    ]);
  });
  it("treats 'all' as unfiltered", () => {
    expect(names({ toolsets: parseToolsets('all'), scopes: 'all' })).toHaveLength(4);
  });
  it('filters by toolset', () => {
    expect(names({ toolsets: new Set(['jobs']), scopes: 'all' })).toEqual(['bb_jobs']);
  });
  it('is stable across calls', () => {
    const ctx = { toolsets: parseToolsets('all'), scopes: 'all' as const };
    expect(names(ctx)).toEqual(names(ctx));
  });
});
