import { describe, expect, it } from 'vitest';
import { capOutputMiddle } from './types';

describe('capOutputMiddle', () => {
  it('leaves output under the limit alone', () => {
    expect(capOutputMiddle('short', 100)).toBe('short');
  });

  it('keeps the start and the end, and stays within the limit', () => {
    const text = `START${'-'.repeat(5000)}END`;
    const capped = capOutputMiddle(text, 500);
    expect(capped.length).toBeLessThanOrEqual(500);
    expect(capped.startsWith('START')).toBe(true);
    expect(capped.endsWith('END')).toBe(true);
    expect(capped).toMatch(/\[\.\.\. \d+ characters omitted from the middle \.\.\.\]/);
  });

  it('keeps the exit line of a long command output', () => {
    const output = `$ build\n${'noise\n'.repeat(10_000)}error: boom\n[exit 1]`;
    expect(capOutputMiddle(output)).toMatch(/error: boom\n\[exit 1\]$/);
  });
});
