import { describe, expect, it } from 'vitest';
import { designTokens } from '../tokens';
import { emitJoyThemeFragment, joyEmitter } from './joy';
import { emitters } from './index';

describe('joy emitter', () => {
  const fragment = emitJoyThemeFragment(designTokens);

  it('is registered under its target name', () => {
    expect(emitters.joy).toBe(joyEmitter);
    expect(joyEmitter.emit(designTokens)).toEqual(fragment);
  });

  it('maps interaction tones to Joy variant names, emitting exactly the defined keys', () => {
    // Each mode overrides a different subset; an extra emitted key would
    // override a Joy default and change the rendered theme.
    expect(Object.keys(fragment.colorSchemes.dark.palette.primary).sort()).toEqual(
      [
        'softBg',
        'softActiveBg',
        'softHoverBg',
        'softHoverColor',
        'solidDisabledBg',
        'solidDisabledColor',
        'softColor',
      ].sort()
    );
    expect(Object.keys(fragment.colorSchemes.light.palette.primary).sort()).toEqual(
      [
        'solidBg',
        'solidColor',
        'softBg',
        'softActiveBg',
        'softActiveColor',
        'softHoverBg',
        'softHoverColor',
        'softColor',
      ].sort()
    );
    expect(Object.keys(fragment.colorSchemes.light.palette.success).sort()).toEqual(
      ['solidBg', 'outlinedColor', 'mainChannel'].sort()
    );
    expect(Object.keys(fragment.colorSchemes.light.palette.neutral).sort()).toEqual(
      ['solidBg', 'solidBorder', 'solidColor', 'softColor', 'plainActiveBg'].sort()
    );
  });

  it('carries the semantic groups and scalar tokens through', () => {
    expect(fragment.colorSchemes.dark.palette.divider).toBe(designTokens.color.schemes.dark.divider);
    expect(fragment.colorSchemes.light.palette.text).toEqual(designTokens.color.schemes.light.text);
    expect(fragment.colorSchemes.light.palette.background.sidebarItem).toBe('neutral.200');
    expect(fragment.fontFamily.body).toContain('Libre Franklin');
    expect(fragment.borderRadius).toBe(8);
  });

  it('emits the metric slots Joy reads, plus motion as a custom key', () => {
    expect(fragment.fontSize).toEqual(designTokens.typography.fontSize);
    expect(fragment.fontWeight).toEqual(designTokens.typography.fontWeight);
    expect(fragment.lineHeight).toEqual(designTokens.typography.lineHeight);
    expect(fragment.spacing).toBe(8);
    expect(fragment.radius.md).toBe('8px');
    expect(Object.keys(fragment.radius)).toEqual(Object.keys(designTokens.radii));
    expect(fragment.shadow.xs).toBe(
      'var(--joy-shadowRing, 0 0 #000), 0px 1px 2px 0px rgba(var(--joy-shadowChannel, 21 21 21) / var(--joy-shadowOpacity, 0.08))'
    );
    expect(fragment.shadow.sm.split('), ')).toHaveLength(3);
    expect(Object.keys(fragment.shadow)).toEqual(Object.keys(designTokens.shadows.levels));
    expect(fragment.motion).toEqual(designTokens.motion);
  });
});
