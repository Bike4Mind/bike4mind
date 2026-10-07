import { describe, expect, it } from 'vitest';
import { pairDataLakeTools } from './llm';

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
