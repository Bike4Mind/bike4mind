import { describe, it, expect } from 'vitest';
import { CORE_TUTORIALS, resolveCoreTutorial } from '../registry';

describe('resolveCoreTutorial', () => {
  it('returns null for an unknown id', () => {
    expect(resolveCoreTutorial('no-such-module')).toBeNull();
  });

  it.each(['example-overlay', 'another-overlay'])('returns null for the overlay id %s', id => {
    expect(resolveCoreTutorial(id)).toBeNull();
  });

  it('resolves every entry of the core array, and only those', () => {
    for (const tutorial of CORE_TUTORIALS) expect(resolveCoreTutorial(tutorial.id)).toBe(tutorial);
  });
});
