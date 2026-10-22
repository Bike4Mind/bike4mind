import { describe, expect, it } from 'vitest';
import { INTEGRATION_CATALOG, PLANNED_INTEGRATION_IDS } from './catalog';
import { describeRequestedIntegration } from './demand';

describe('describeRequestedIntegration', () => {
  it('names a roadmap entry from the catalog and reports it as planned', () => {
    const id = PLANNED_INTEGRATION_IDS[0];
    expect(describeRequestedIntegration(id)).toEqual({ name: INTEGRATION_CATALOG[id].name, stage: 'planned' });
  });

  it('keeps an entry promoted out of the roadmap, flagged with its current stage', () => {
    expect(describeRequestedIntegration('github')).toEqual({ name: 'GitHub', stage: INTEGRATION_CATALOG.github.stage });
    expect(INTEGRATION_CATALOG.github.stage).not.toBe('planned');
  });

  it.each(['no-longer-in-the-catalog', '__proto__', 'toString', 'constructor'])(
    'falls back to the raw id with no stage for %s',
    id => {
      expect(describeRequestedIntegration(id)).toEqual({ name: id, stage: null });
    }
  );
});
