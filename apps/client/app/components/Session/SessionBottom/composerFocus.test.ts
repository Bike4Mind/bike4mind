import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { shouldBlurComposerAfterSend } from './composerFocus';

const stubPointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }));

describe('shouldBlurComposerAfterSend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps focus in the composer on a fine pointer (keyboard and mouse)', () => {
    stubPointer(false);
    expect(shouldBlurComposerAfterSend()).toBe(false);
  });

  it('blurs on a touch device to hide the on-screen keyboard', () => {
    stubPointer(true);
    expect(shouldBlurComposerAfterSend()).toBe(true);
  });
});

// Source-level, like the other useSendMessage.*.test.ts guards: the hook consumes ~15 providers.
describe('useSendMessage - post-send blur', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('only blurs the composer behind the touch check', () => {
    const blurs = source.match(/lexicalInputRef\.current\?\.blur\(\)/g) ?? [];
    expect(blurs).toHaveLength(1);
    expect(source).toMatch(
      /if \(shouldBlurComposerAfterSend\(\)\) \{\s*setTimeout\(\(\) => \{\s*lexicalInputRef\.current\?\.blur\(\);/
    );
  });
});
