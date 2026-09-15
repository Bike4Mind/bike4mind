import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the `no-restricted-syntax` rule that bans Material UI palette tokens in the Joy SPA.
 *
 * Both halves of the rule are easy to break unnoticed: widen it and it starts flagging
 * `border.light` / `inbox.border.light`, which this theme really does define; narrow it and
 * `primary.main` sails through again. Neither shows up anywhere else, because a dead token throws
 * nothing at runtime - it just renders no CSS.
 *
 * So this runs the real config through eslint's Linter over fixture sources, rather than
 * re-implementing the selectors. That also covers the two things a regex check could not: that the
 * strings are valid *esquery* selectors at all, and that the rule still reaches every file under
 * apps/client/app - including its test files, which a later config block with a narrower glob
 * would silently exempt, flat config being last-rule-wins per rule id.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const config = (await import(path.join(REPO_ROOT, 'eslint.config.mjs'))).default;
// cwd matters: flat-config `files` globs resolve against it, and this package's vitest runs from
// packages/scripts, where `apps/client/app/**` would match nothing and every fixture would come
// back clean.
const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });

/** Rule ids reported for `source` when linted as `filename`. */
const lint = (source: string, filename = 'apps/client/app/components/Fixture.tsx') =>
  linter.verify(source, config, path.join(REPO_ROOT, filename)).map(message => message.ruleId);

const flags = (token: string, filename?: string) =>
  lint(`export const sx = { color: '${token}' };\n`, filename).includes('no-restricted-syntax');

// Dead: resolves to nothing, so the whole declaration is dropped.
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
  'action.disabledBackground',
  'action.hoverOpacity',
  'grey.700',
  'grey.A400',
  'error.mainChannel',
  'background.paper',
  'background.default',
  'text.disabled',
];

// Tokens this theme really defines, plus the near-misses that make a lazier regex wrong.
const LIVE = [
  'primary.plainColor',
  'primary.500',
  'primary.solidHoverBg',
  'primary.softHoverBg',
  'success.plainColor',
  'danger.outlinedBorder',
  'neutral.outlinedBorder',
  'neutral.softBg',
  'success.mainChannel',
  'common.white',
  'text.primary',
  'text.tertiary',
  'background.surface',
  'background.level2',
  'border.light',
  'border.solid',
  'inbox.border.light',
  // Not palette lookups at all - shapes a future non-style string could plausibly take.
  'error.message',
  'logo.dark',
];

describe('dead Material UI palette token guard', () => {
  it('lints the fixture at all, so a misconfigured Linter cannot pass vacuously', () => {
    expect(lint(`export const a = 'primary.main';\n`)).toContain('no-restricted-syntax');
    expect(lint(`export const a = 'primary.plainColor';\n`)).toEqual([]);
  });

  it.each(DEAD)('flags %s', token => {
    expect(flags(token)).toBe(true);
  });

  it.each(LIVE)('leaves %s alone', token => {
    expect(flags(token)).toBe(false);
  });

  it('reports a dead token once, not once per selector', () => {
    for (const token of DEAD) {
      const hits = lint(`export const sx = { color: '${token}' };\n`).filter(id => id === 'no-restricted-syntax');
      expect(`${token} reported ${hits.length}x`).toBe(`${token} reported 1x`);
    }
  });

  it('still covers test files under apps/client/app', () => {
    expect(flags('primary.main', 'apps/client/app/components/Fixture.test.tsx')).toBe(true);
  });

  it('still bans window.open in the same block, which last-rule-wins would otherwise drop', () => {
    expect(lint(`window.open('https://example.com');\n`)).toContain('no-restricted-syntax');
    expect(lint(`open('https://example.com');\n`)).toContain('no-restricted-globals');
  });
});
