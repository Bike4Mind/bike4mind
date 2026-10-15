import { describe, expect, it } from 'vitest';
import {
  AI_EDIT_VERSION_RETENTION_DEFAULT,
  AI_EDIT_VERSION_RETENTION_MAX,
  resolveAiEditVersionRetention,
} from './aiEditVersionRetention';

describe('resolveAiEditVersionRetention', () => {
  it.each([undefined, null, '', 'abc', NaN])('falls back to the default for %s', value => {
    expect(resolveAiEditVersionRetention(value)).toBe(AI_EDIT_VERSION_RETENTION_DEFAULT);
  });

  it('floors and clamps numeric input', () => {
    expect(resolveAiEditVersionRetention(0)).toBe(1);
    expect(resolveAiEditVersionRetention('-3')).toBe(1);
    expect(resolveAiEditVersionRetention(4.9)).toBe(4);
    expect(resolveAiEditVersionRetention('7')).toBe(7);
    expect(resolveAiEditVersionRetention(1e6)).toBe(AI_EDIT_VERSION_RETENTION_MAX);
  });
});
