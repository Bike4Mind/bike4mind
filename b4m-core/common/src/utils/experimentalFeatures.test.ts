import { describe, expect, it } from 'vitest';
import { isExperimentalFeatureEnabled } from './experimentalFeatures';

describe('isExperimentalFeatureEnabled', () => {
  it('reads a flag off a MAP - the hydrated Mongoose shape', () => {
    // The regression this exists to prevent: UserModel declares experimentalFeatures as
    // `{ type: Map, of: Boolean }`, so a hydrated user carries a Map. Dot access on a Map yields
    // undefined without throwing, which silently reported every flag as OFF - Mementos V2 was never
    // injected into a chat prompt even for a user who had opted in.
    const user = { preferences: { experimentalFeatures: new Map([['enableMementosV2', true]]) } };

    expect(isExperimentalFeatureEnabled(user, 'enableMementosV2')).toBe(true);
    // ...and this is what the old dot-access reader actually saw:
    expect(
      (user.preferences.experimentalFeatures as unknown as Record<string, boolean>).enableMementosV2
    ).toBeUndefined();
  });

  it('reads a flag off a plain object - the .lean() / JSON shape', () => {
    expect(
      isExperimentalFeatureEnabled(
        { preferences: { experimentalFeatures: { enableMementosV2: true } } },
        'enableMementosV2'
      )
    ).toBe(true);
  });

  it('falls back to the legacy top-level bag', () => {
    expect(
      isExperimentalFeatureEnabled({ experimentalFeatures: new Map([['enableMementosV2', true]]) }, 'enableMementosV2')
    ).toBe(true);
  });

  it('is false for an unset flag, an explicit false, or a missing user', () => {
    expect(isExperimentalFeatureEnabled({ preferences: { experimentalFeatures: new Map() } }, 'enableMementosV2')).toBe(
      false
    );
    expect(
      isExperimentalFeatureEnabled(
        { preferences: { experimentalFeatures: new Map([['enableMementosV2', false]]) } },
        'enableMementosV2'
      )
    ).toBe(false);
    expect(isExperimentalFeatureEnabled(null, 'enableMementosV2')).toBe(false);
    expect(isExperimentalFeatureEnabled(undefined, 'enableMementosV2')).toBe(false);
    expect(isExperimentalFeatureEnabled({}, 'enableMementosV2')).toBe(false);
  });

  it('does not treat a truthy non-true value as enabled', () => {
    expect(
      isExperimentalFeatureEnabled(
        { preferences: { experimentalFeatures: { enableMementosV2: 'yes' } } } as never,
        'enableMementosV2'
      )
    ).toBe(false);
  });
});
