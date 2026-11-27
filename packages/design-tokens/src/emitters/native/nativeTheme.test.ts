import { describe, expect, it } from 'vitest';
import { designTokens } from '../../tokens';
import { parseColor, primaryFamilyName, resolveNativeTheme, type ColorRoleSpec } from './nativeTheme';

describe('parseColor', () => {
  it('reads hex in every length the schema allows', () => {
    expect(parseColor('#0B6BCB')).toEqual({ red: 11, green: 107, blue: 203, alpha: 1 });
    expect(parseColor('#fff')).toEqual({ red: 255, green: 255, blue: 255, alpha: 1 });
    expect(parseColor('#00000080')).toEqual({ red: 0, green: 0, blue: 0, alpha: 0.502 });
  });

  it('reads rgb() and rgba()', () => {
    expect(parseColor('rgba(209, 228, 244, 0.85)')).toEqual({ red: 209, green: 228, blue: 244, alpha: 0.85 });
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ red: 1, green: 2, blue: 3, alpha: 1 });
  });

  it('refuses a token reference, which only a web palette can resolve', () => {
    expect(() => parseColor('neutral.200')).toThrow(/literal hex or rgba/);
  });
});

describe('resolveNativeTheme', () => {
  const theme = resolveNativeTheme(designTokens);
  const role = (name: string) => theme.colors.find(color => color.name === name);

  it('resolves scheme, ramp and alpha sources per mode', () => {
    expect(role('backgroundBody')).toMatchObject({
      light: { red: 0xfb, green: 0xfc, blue: 0xfe, alpha: 1 },
      dark: { red: 0x0e, green: 0x12, blue: 0x14, alpha: 1 },
    });
    expect(role('readingInk')?.dark).toEqual({ red: 209, green: 228, blue: 244, alpha: 0.85 });
    expect(theme.accentRole).toBe(role('accent'));
  });

  it('carries the web radius scale and an 8pt spacing ramp', () => {
    expect(theme.radii).toEqual([
      { name: 'xs', value: 2 },
      { name: 'sm', value: 6 },
      { name: 'md', value: 8 },
      { name: 'lg', value: 12 },
      { name: 'xl', value: 16 },
    ]);
    expect(theme.spacing.map(step => step.value)).toEqual([4, 8, 16, 24, 32, 48]);
  });

  it('converts rem sizes to points and names the primary font family', () => {
    expect(theme.typography.familyName).toBe('Libre Franklin');
    expect(theme.typography.sizes.find(size => size.name === 'md')?.value).toBe(16);
    expect(primaryFamilyName("'Inter', sans-serif")).toBe('Inter');
  });

  it('fails loudly on a role that points at a missing token', () => {
    const broken: ColorRoleSpec[] = [
      { name: 'accent', description: '', light: { ramp: 'brand', stop: '1' }, dark: { ramp: 'brand', stop: '800' } },
    ];
    expect(() => resolveNativeTheme(designTokens, broken)).toThrow(/stop brand\.1/);
  });

  it('refuses a scheme key that is a web palette reference', () => {
    const webOnly: ColorRoleSpec[] = [
      {
        name: 'accent',
        description: '',
        light: { scheme: 'background.sidebarItem' },
        dark: { scheme: 'background.body' },
      },
    ];
    expect(() => resolveNativeTheme(designTokens, webOnly)).toThrow(/literal hex or rgba/);
  });
});
