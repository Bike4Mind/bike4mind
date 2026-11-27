import { describe, it, expect } from 'vitest';
import { GEAR_KEYS } from './keys';
import { GEAR_PRESENTATION } from './presentation';

describe('GEAR_PRESENTATION', () => {
  it('defines presentation for every gear key', () => {
    expect(Object.keys(GEAR_PRESENTATION).sort()).toEqual([...GEAR_KEYS].sort());
  });

  // A claimed card still shows its default copy, so none of it may read as first-time.
  it.each(GEAR_KEYS)('%s default copy does not claim to be a first-time action', key => {
    const { title, tagline, intro, cta } = GEAR_PRESENTATION[key];
    expect(cta.trim()).not.toBe('');
    for (const copy of [title, tagline, intro, cta]) {
      expect(copy).not.toMatch(/your first/i);
    }
  });

  it('pins the neutral copy for the destination gears', () => {
    expect(GEAR_PRESENTATION.projects.cta).toBe('Create a project');
    expect(GEAR_PRESENTATION.agents.cta).toBe('Build an agent');
    expect(GEAR_PRESENTATION.datalakes.cta).toBe('Create a data lake');
    expect(GEAR_PRESENTATION.files.cta).toBe('Upload a file');
  });
});
