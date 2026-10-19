// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getMcpToolText, isMcpToolError } from './isMcpToolError';

describe('isMcpToolError', () => {
  it('is true only for isError === true', () => {
    expect(isMcpToolError({ isError: true, content: [] })).toBe(true);
    expect(isMcpToolError({ isError: 'true' })).toBe(false);
    expect(isMcpToolError({ content: [] })).toBe(false);
    expect(isMcpToolError(null)).toBe(false);
    expect(isMcpToolError('Error: x')).toBe(false);
  });
});

describe('getMcpToolText', () => {
  it('returns the first text block', () => {
    expect(getMcpToolText({ content: [{ type: 'text', text: 'Error: x' }] })).toBe('Error: x');
  });

  it('returns undefined for other shapes', () => {
    expect(getMcpToolText({ content: [] })).toBeUndefined();
    expect(getMcpToolText('x')).toBeUndefined();
  });
});
