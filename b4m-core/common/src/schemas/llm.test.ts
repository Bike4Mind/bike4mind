import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { B4MLLMToolsList, b4mLLMTools, pairDataLakeTools } from './llm';
import { isToolAllowedByOrgPolicy, readOrgModelPolicy } from './orgModelPolicy';

const SAVE = 'save_content_to_data_lake';

describe('pairDataLakeTools', () => {
  it('returns an unchanged copy when the save tool is absent', () => {
    const belt = ['web_search', 'create_data_lake'];
    const out = pairDataLakeTools(belt);

    expect(out).toEqual(belt);
    expect(out).not.toBe(belt);
  });

  it('pairs list, read and create tools with the save tool', () => {
    const out = pairDataLakeTools([SAVE]);

    expect(out).toEqual(expect.arrayContaining([SAVE, 'list_my_data_lakes', 'create_data_lake']));
    expect(out).toHaveLength(3);
  });

  it('pairs list but not create when withCreate is false', () => {
    const out = pairDataLakeTools([SAVE], { withCreate: false });

    expect(out).toContain('list_my_data_lakes');
    expect(out).not.toContain('create_data_lake');
  });

  it('does not add a companion twice', () => {
    const out = pairDataLakeTools([SAVE, 'list_my_data_lakes', 'create_data_lake']);

    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(out.length);
  });

  it('never pairs a companion outside the allowlist', () => {
    const out = pairDataLakeTools([SAVE], { allowlist: [SAVE, 'list_my_data_lakes'] });

    expect(out).toContain('list_my_data_lakes');
    expect(out).not.toContain('create_data_lake');
  });

  it('keeps an already-present tool even if the allowlist omits it', () => {
    const out = pairDataLakeTools([SAVE, 'create_data_lake'], { allowlist: [SAVE] });

    expect(out).toContain('create_data_lake');
    expect(out).not.toContain('list_my_data_lakes');
  });
});

describe('persisted tool names outside the enum', () => {
  const OVERLAY = ['overlay_tool_a', 'overlay_tool_b'];

  it('parse where a tool list is read as open strings', () => {
    const parsed = z.array(z.union([b4mLLMTools, z.string()])).parse(['web_search', ...OVERLAY]);
    expect(parsed).toEqual(['web_search', ...OVERLAY]);
  });

  it('are kept by a stored org policy and not governed by it', () => {
    const policy = readOrgModelPolicy({ allowedTools: ['web_search', ...OVERLAY] });
    expect(policy).toMatchObject({ allowedTools: ['web_search', ...OVERLAY] });
    expect(B4MLLMToolsList as string[]).not.toContain(OVERLAY[0]);
    expect(isToolAllowedByOrgPolicy(readOrgModelPolicy({ allowedTools: ['web_search'] }), OVERLAY[0])).toBe(true);
  });
});
