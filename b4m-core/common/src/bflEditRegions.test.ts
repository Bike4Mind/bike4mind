import { describe, it, expect } from 'vitest';
import {
  BflEditRegionSchema,
  validateBflEditRegions,
  MAX_BFL_EDIT_REGIONS,
  EditImageRequestBodySchema,
  type BflEditRegion,
} from './llm';

const validRegion: BflEditRegion = { prompt: 'make it blue', bbox: [0.1, 0.2, 0.8, 0.9] };

describe('BflEditRegionSchema', () => {
  it('accepts a valid region', () => {
    expect(BflEditRegionSchema.parse(validRegion)).toEqual(validRegion);
  });

  it('rejects an empty prompt', () => {
    expect(BflEditRegionSchema.safeParse({ prompt: '', bbox: [0, 0, 1, 1] }).success).toBe(false);
  });

  it('rejects a bbox with wrong arity', () => {
    expect(BflEditRegionSchema.safeParse({ prompt: 'hi', bbox: [0, 0, 1] }).success).toBe(false);
    expect(BflEditRegionSchema.safeParse({ prompt: 'hi', bbox: [0, 0, 1, 1, 1] }).success).toBe(false);
  });
});

describe('validateBflEditRegions', () => {
  it('returns no issues for valid regions', () => {
    expect(validateBflEditRegions([validRegion])).toEqual([]);
  });

  it('returns no issues for an empty array', () => {
    expect(validateBflEditRegions([])).toEqual([]);
  });

  it('rejects coordinates below 0', () => {
    const issues = validateBflEditRegions([{ prompt: 'x', bbox: [-0.1, 0.2, 0.8, 0.9] }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('y_min');
    expect(issues[0]).toContain('[0, 1]');
  });

  it('rejects coordinates above 1', () => {
    const issues = validateBflEditRegions([{ prompt: 'x', bbox: [0.1, 0.2, 1.5, 0.9] }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('y_max');
  });

  it('rejects degenerate box where y_min >= y_max', () => {
    const issues = validateBflEditRegions([{ prompt: 'x', bbox: [0.8, 0.2, 0.8, 0.9] }]);
    expect(issues.some(i => i.includes('y_min') && i.includes('y_max'))).toBe(true);
  });

  it('rejects degenerate box where x_min >= x_max', () => {
    const issues = validateBflEditRegions([{ prompt: 'x', bbox: [0.1, 0.9, 0.8, 0.2] }]);
    expect(issues.some(i => i.includes('x_min') && i.includes('x_max'))).toBe(true);
  });

  it('rejects more than MAX_BFL_EDIT_REGIONS boxes', () => {
    const regions: BflEditRegion[] = Array.from({ length: MAX_BFL_EDIT_REGIONS + 1 }, (_, i) => ({
      prompt: `region ${i}`,
      bbox: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number],
    }));
    const issues = validateBflEditRegions(regions);
    expect(issues.some(i => i.includes(`${MAX_BFL_EDIT_REGIONS}`))).toBe(true);
  });

  it('accepts exactly MAX_BFL_EDIT_REGIONS boxes', () => {
    const regions: BflEditRegion[] = Array.from({ length: MAX_BFL_EDIT_REGIONS }, (_, i) => ({
      prompt: `region ${i}`,
      bbox: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number],
    }));
    expect(validateBflEditRegions(regions)).toEqual([]);
  });

  it('reports multiple issues in one pass', () => {
    const issues = validateBflEditRegions([{ prompt: 'x', bbox: [-0.1, 1.5, 0.3, 0.2] }]);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('validates each region independently', () => {
    const issues = validateBflEditRegions([
      validRegion,
      { prompt: 'bad', bbox: [0.9, 0.2, 0.1, 0.9] },
    ]);
    expect(issues.some(i => i.includes('[1]'))).toBe(true);
    expect(issues.every(i => !i.includes('[0]'))).toBe(true);
  });
});

describe('EditImageRequestBodySchema edit_regions field', () => {
  it('accepts a body with edit_regions', () => {
    const result = EditImageRequestBodySchema.safeParse({
      sessionId: 's1',
      image: 'https://example.com/img.png',
      prompt: 'edit it',
      model: 'flux-pro-1.0-fill',
      edit_regions: [validRegion],
    });
    expect(result.error?.issues?.filter(i => i.path[0] === 'edit_regions') ?? []).toEqual([]);
  });

  it('accepts a body without edit_regions', () => {
    const result = EditImageRequestBodySchema.safeParse({
      sessionId: 's1',
      image: 'https://example.com/img.png',
      prompt: 'edit it',
      model: 'flux-pro-1.0-fill',
    });
    expect(result.error?.issues?.filter(i => i.path[0] === 'edit_regions') ?? []).toEqual([]);
  });

  it('rejects invalid bbox tuple in edit_regions', () => {
    const result = EditImageRequestBodySchema.safeParse({
      sessionId: 's1',
      image: 'https://example.com/img.png',
      prompt: 'edit it',
      model: 'flux-pro-1.0-fill',
      edit_regions: [{ prompt: 'hi', bbox: [0, 0, 1] }],
    });
    const regionIssues = result.error?.issues?.filter(i => String(i.path[0]) === 'edit_regions') ?? [];
    expect(regionIssues.length).toBeGreaterThan(0);
  });
});
