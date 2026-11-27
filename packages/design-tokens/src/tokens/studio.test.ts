import { describe, expect, it } from 'vitest';
import { STUDIO_COLOR_ROLES, STUDIO_PALETTES, studioColor, studioCssVariables } from './studio';

describe('studio tokens', () => {
  it('defines every color role in both modes', () => {
    for (const mode of ['dark', 'light'] as const) {
      expect(Object.keys(STUDIO_PALETTES[mode]).sort()).toEqual([...STUDIO_COLOR_ROLES].sort());
    }
  });

  it('emits colors, radii and the caller-supplied fonts as --studio-* variables', () => {
    const variables = studioCssVariables('light', { ui: 'system-ui', mono: 'monospace' });
    expect(variables['--studio-canvas']).toBe(STUDIO_PALETTES.light.canvas);
    expect(variables['--studio-radius-lg']).toBe('12px');
    expect(variables['--studio-font-ui']).toBe('system-ui');
    expect(studioColor('accent')).toBe('var(--studio-accent)');
  });
});
