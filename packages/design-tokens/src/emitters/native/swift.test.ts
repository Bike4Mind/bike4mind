import { describe, expect, it } from 'vitest';
import { designTokens } from '../../tokens';
import { emitters } from '../index';
import { emitSwift, swiftEmitter, SWIFT_ACCENT_COLOR_FILE, SWIFT_TOKENS_FILE } from './swift';

describe('swift emitter', () => {
  const files = emitSwift(designTokens);
  const swift = files[SWIFT_TOKENS_FILE] ?? '';

  it('is registered under its target name', () => {
    expect(emitters.swift).toBe(swiftEmitter);
    expect(Object.keys(files).sort()).toEqual([SWIFT_ACCENT_COLOR_FILE, SWIFT_TOKENS_FILE].sort());
  });

  it('writes each color role as a light/dark pair, with alpha only when translucent', () => {
    expect(swift).toContain(
      'public static let accent = BrandColorPair(\n      light: BrandRGBA(0x0B6BCB), dark: BrandRGBA(0x61AFEF))'
    );
    expect(swift).toContain('dark: BrandRGBA(0xD1E4F4, alpha: 0.85))');
  });

  it('writes the radius, spacing and type ramps', () => {
    expect(swift).toContain('public static let md: CGFloat = 8');
    expect(swift).toContain('public static let xxl: CGFloat = 48');
    expect(swift).toContain('public static let familyName = "Libre Franklin"');
    expect(swift).toContain('public static let lg: Int = 600');
  });

  it('is ASCII only, as the repo requires of Swift sources', () => {
    expect([...swift].every(char => char === '\t' || char === '\n' || (char >= ' ' && char <= '~'))).toBe(true);
  });

  it('writes the accent as an asset-catalog color set with a dark appearance', () => {
    const colorSet: unknown = JSON.parse(files[SWIFT_ACCENT_COLOR_FILE] ?? '');
    expect(colorSet).toMatchObject({
      colors: [
        { color: { components: { red: '0x0B', green: '0x6B', blue: '0xCB', alpha: '1.000' } } },
        {
          appearances: [{ appearance: 'luminosity', value: 'dark' }],
          color: { components: { red: '0x61', green: '0xAF', blue: '0xEF' } },
        },
      ],
    });
  });
});
