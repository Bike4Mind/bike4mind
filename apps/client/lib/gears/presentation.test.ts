import { describe, it, expect } from 'vitest';
import { GEAR_KEYS } from './keys';
import { GEAR_PRESENTATION } from './presentation';

describe('GEAR_PRESENTATION', () => {
  it('defines presentation for every gear key', () => {
    expect(Object.keys(GEAR_PRESENTATION).sort()).toEqual([...GEAR_KEYS].sort());
  });

  it.each(GEAR_KEYS)('%s default cta does not claim to be a first-time action', key => {
    expect(GEAR_PRESENTATION[key].cta.trim()).not.toBe('');
    expect(GEAR_PRESENTATION[key].cta).not.toMatch(/your first/i);
  });

  it('pins the neutral copy for the destination gears', () => {
    expect(GEAR_PRESENTATION.projects.cta).toBe('Create a project');
    expect(GEAR_PRESENTATION.agents.cta).toBe('Build an agent');
    expect(GEAR_PRESENTATION.datalakes.cta).toBe('Create a data lake');
    expect(GEAR_PRESENTATION.files.cta).toBe('Upload a file');
  });
});
