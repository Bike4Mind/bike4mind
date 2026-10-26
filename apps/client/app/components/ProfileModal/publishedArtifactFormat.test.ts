import { describe, it, expect } from 'vitest';
import { formatViews, sourceKindLabel } from './publishedArtifactFormat';

describe('sourceKindLabel', () => {
  it('names the three source kinds for people, not for storage', () => {
    expect(sourceKindLabel('bundle')).toBe('Bundle');
    expect(sourceKindLabel('reply')).toBe('Reply');
    expect(sourceKindLabel('fabfile')).toBe('File');
  });

  it('falls back to the raw value so a kind added server-side still shows', () => {
    expect(sourceKindLabel('notebook')).toBe('notebook');
  });

  it('does not read inherited object keys as kinds', () => {
    expect(sourceKindLabel('constructor')).toBe('constructor');
  });
});

describe('formatViews', () => {
  it('prints small counts whole and large counts compact', () => {
    expect(formatViews(1284)).toBe('1284');
    expect(formatViews(12_345)).not.toContain('12345');
  });
});
