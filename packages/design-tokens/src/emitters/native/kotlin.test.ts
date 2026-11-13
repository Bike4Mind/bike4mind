import { describe, expect, it } from 'vitest';
import { designTokens } from '../../tokens';
import { emitters } from '../index';
import { emitKotlin, kotlinEmitter, KOTLIN_TOKENS_FILE } from './kotlin';

describe('kotlin emitter', () => {
  const files = emitKotlin(designTokens);
  const kotlin = files[KOTLIN_TOKENS_FILE] ?? '';

  it('is registered under its target name', () => {
    expect(emitters.kotlin).toBe(kotlinEmitter);
    expect(Object.keys(files)).toEqual([KOTLIN_TOKENS_FILE]);
  });

  it('declares its own color pair type and writes each role as a light/dark pair', () => {
    expect(kotlin).toContain('data class BrandColorPair(val light: Color, val dark: Color)');
    expect(kotlin).toContain(
      'val accent = BrandColorPair(\n            light = Color(0xFF0B6BCB),\n            dark = Color(0xFF61AFEF),\n        )'
    );
  });

  it('writes translucent colors with their alpha byte', () => {
    expect(kotlin).toContain('dark = Color(0xD9D1E4F4),');
  });

  it('writes the radius, spacing and type ramps with Compose units', () => {
    expect(kotlin).toContain('val md = 8.dp');
    expect(kotlin).toContain('val xxl = 48.dp');
    expect(kotlin).toContain('const val familyName = "Libre Franklin"');
    expect(kotlin).toContain('val md = 16.sp');
    expect(kotlin).toContain('val lg: Int = 600');
  });

  it('suffixes float literals so they compile as Float, not Double', () => {
    expect(kotlin).toContain('val md: Float = 1.5f');
    expect(kotlin).not.toMatch(/: Float = \d+\.\d+\s*$/m);
  });

  it('is ASCII only, as the repo requires of added source lines', () => {
    expect([...kotlin].every(char => char === '\n' || (char >= ' ' && char <= '~'))).toBe(true);
  });
});
