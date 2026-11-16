import { describe, expect, it } from 'vitest';
import { ModuleBundleSchema } from './drafts';
import { OverrideBundleSchema } from './overrideUnits';
import { CoreTutorialVisibilitySchema } from './visibility';

describe('CoreTutorialVisibilitySchema', () => {
  it.each([{ entitlement: 'meetings:pro' }, { public: true }])('accepts %o', v => {
    expect(CoreTutorialVisibilitySchema.safeParse(v).success).toBe(true);
  });

  it.each([{}, { entitlement: '' }, { public: false }, { entitlement: 'x', public: true }, null, 'x'])(
    'refuses %o',
    v => {
      expect(CoreTutorialVisibilitySchema.safeParse(v).success).toBe(false);
    }
  );
});

describe('bundle owner field', () => {
  it('is optional on the override bundle', () => {
    expect(OverrideBundleSchema.shape.owner.safeParse(undefined).success).toBe(true);
    expect(OverrideBundleSchema.shape.owner.safeParse('core').success).toBe(true);
    expect(OverrideBundleSchema.shape.owner.safeParse('').success).toBe(false);
  });

  it('is optional on the module bundle', () => {
    expect(ModuleBundleSchema.shape.owner.safeParse(undefined).success).toBe(true);
  });
});
