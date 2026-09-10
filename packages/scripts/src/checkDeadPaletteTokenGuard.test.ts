import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the `no-restricted-syntax` rule that bans Material UI palette tokens in the Joy SPA.
 *
 * The rule is a pair of regexes embedded in esquery selector strings, and both halves of it are
 * easy to break in a way nothing else notices: widen it and it starts flagging `border.light` /
 * `inbox.border.light`, which this theme really does define; narrow it and `primary.main` sails
 * through again. Neither shows up as a test failure anywhere else, because a dead token throws
 * nothing at runtime - it just silently renders no CSS.
 *
 * So this pulls the selectors out of the real config and exercises the real regexes, rather than
 * restating them. It also pins that they live in the SAME rule entry as the window.open selectors:
 * flat config is last-rule-wins per rule id, so a well-meaning "separate concerns" block declaring
 * its own no-restricted-syntax for apps/client/app/** would silently delete the other guard.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const config = (await import(path.join(REPO_ROOT, 'eslint.config.mjs'))).default;

const clientUiBlock = config.find(
  (block: { files?: string[] }) => block.files?.length === 1 && block.files[0] === 'apps/client/app/**/*.{ts,tsx}'
);

type Entry = { selector: string; message: string };
const selectors: Entry[] = (clientUiBlock?.rules?.['no-restricted-syntax'] ?? []).slice(1);
const paletteSelectors = selectors.filter(entry => entry.message.startsWith('Material UI palette token'));

/** The union of the palette selectors: what the rule flags, as a single testable predicate. */
const flags = (value: string) =>
  paletteSelectors.some(entry => {
    const pattern = entry.selector.match(/^Literal\[value=\/(.+)\/\]$/)?.[1];
    if (!pattern) throw new Error(`selector is not a Literal value regex: ${entry.selector}`);
    return new RegExp(pattern).test(value);
  });

const DEAD = [
  'primary.main',
  'danger.main',
  'success.main',
  'warning.main',
  'neutral.main',
  'error.main',
  'info.main',
  'primary.light',
  'neutral.light',
  'primary.dark',
  'success.contrastText',
  'info.300',
  'secondary.500',
  'action.hover',
  'grey.700',
];

// Tokens this theme really defines, plus the near-misses that make a lazier regex wrong.
const LIVE = [
  'primary.plainColor',
  'primary.500',
  'primary.solidHoverBg',
  'success.softColor',
  'danger.outlinedBorder',
  'neutral.plainHoverBg',
  'success.mainChannel',
  'common.white',
  'text.primary',
  'background.surface',
  'background.backdrop',
  'border.light',
  'border.solid',
  'inbox.border.light',
  // Not a palette lookup at all - a shape a future non-style string could plausibly take.
  'error.message',
  'logo.dark',
];

describe('dead Material UI palette token guard', () => {
  it('is wired into the apps/client/app block', () => {
    expect(clientUiBlock, 'expected an eslint block scoped to apps/client/app/**/*.{ts,tsx}').toBeDefined();
    expect(paletteSelectors.length).toBeGreaterThan(0);
  });

  it('shares the rule entry with the window.open guard, which last-rule-wins would otherwise drop', () => {
    expect(selectors.some(entry => entry.message.includes('openInNewTab()'))).toBe(true);
  });

  it.each(DEAD)('flags %s', token => {
    expect(flags(token)).toBe(true);
  });

  it.each(LIVE)('leaves %s alone', token => {
    expect(flags(token)).toBe(false);
  });

  it('reports each dead token exactly once', () => {
    for (const token of DEAD) {
      const hits = paletteSelectors.filter(entry =>
        new RegExp(entry.selector.match(/^Literal\[value=\/(.+)\/\]$/)![1]).test(token)
      );
      expect(`${token} matched by ${hits.length} selector(s)`).toBe(`${token} matched by 1 selector(s)`);
    }
  });
});
