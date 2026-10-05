import { describe, expect, it } from 'vitest';
import { describeAlways, shortenDirectory } from './approvalScope';
import type { ApprovalAlways } from './tools/types';

const HOME = '/Users/jude';
const CWD = '/Users/jude/Javascript/bike4mind';

function always(patterns: string[], directories: string[] = []): ApprovalAlways {
  return {
    namespace: 'bash_execute',
    commands: patterns.map(pattern => ({ text: pattern.replace(' *', ''), pattern })),
    directories,
  };
}

describe('describeAlways', () => {
  it('has nothing to say about a command that grants nothing', () => {
    expect(describeAlways(always([]), CWD, HOME)).toBeUndefined();
  });

  it('names the patterns a command would allow', () => {
    expect(describeAlways(always(['git status *']), CWD, HOME)?.shown).toBe('`git status *`');
  });

  it('counts the patterns past the third rather than listing them', () => {
    const scope = describeAlways(always(['a *', 'b *', 'c *', 'd *', 'e *']), CWD, HOME);
    expect(scope?.shown).toBe('`a *`, `b *`, `c *`, 2 more');
    expect(scope?.full).toContain('`e *`');
  });

  it('says a repeated sub-command once', () => {
    expect(describeAlways(always(['ls *', 'ls *']), CWD, HOME)?.shown).toBe('`ls *`');
  });

  /**
   * The case that made the prompt unreadable: two sub-commands and two directories, one of them
   * the working directory itself, every path written out in full inside the button's own label.
   */
  it('shortens the directories from the screenshot', () => {
    const scope = describeAlways(
      always(['ls *', 'head *'], ['/Users/jude/Javascript', '/Users/jude/Javascript/bike4mind']),
      CWD,
      HOME
    );
    expect(scope?.shown).toBe('`ls *`, `head *`, ~/Javascript/*, ./*');
    expect(scope?.full).toBe('`ls *`, `head *`, /Users/jude/Javascript/*, /Users/jude/Javascript/bike4mind/*');
  });

  it('keeps the scope bounded when a command reaches many long directories', () => {
    const directories = [
      '/Users/jude/Javascript/optihashi/packages/infrastructure/stacks',
      '/Users/jude/Javascript/bike4mind/apps/client/app/components',
      '/Users/jude/Javascript/elsewhere/a/very/deeply/nested/directory/indeed',
      '/Users/jude/Documents/archive/2024/quarter-one/attachments',
      '/opt/homebrew/Cellar/node/22.0.0/lib/node_modules/npm/node_modules',
    ];
    const patterns = ['ls *', 'head *', 'cat *', 'wc *', 'du *'];
    const wide = describeAlways(always(patterns, directories), CWD, HOME);

    // Eight items at most: three of each kind, plus the two counts that stand in for the rest.
    expect(wide?.shown.split(', ')).toHaveLength(8);
    expect(wide?.shown).toContain('2 more');
    expect(wide?.shown.length).toBeLessThan(wide?.full.length ?? 0);

    // The bound that matters: more directories change the count, not the length of the line.
    const wider = describeAlways(always(patterns, [...directories, '/etc/nginx', '/opt/local']), CWD, HOME);
    const count = /, \d+ more$/;
    expect(wider?.shown.replace(count, '')).toBe(wide?.shown.replace(count, ''));
    expect(wider?.shown.endsWith(', 4 more')).toBe(true);

    // Every directory is still accounted for behind the tooltip, at its real path.
    for (const directory of directories) expect(wider?.full).toContain(directory);
  });

  it('keeps every directory and its full path in the text behind the tooltip', () => {
    const directories = ['/Users/jude/Javascript/optihashi', '/Users/jude/Javascript/bike4mind/apps/desktop'];
    const scope = describeAlways(always(['ls *'], directories), CWD, HOME);
    expect(scope?.full).toBe(
      '`ls *`, /Users/jude/Javascript/optihashi/*, /Users/jude/Javascript/bike4mind/apps/desktop/*'
    );
    expect(scope?.shown).toBe('`ls *`, ~/Javascript/optihashi/*, ./apps/desktop/*');
  });
});

describe('shortenDirectory', () => {
  it('collapses the home folder', () => {
    expect(shortenDirectory('/Users/jude/Javascript/optihashi', CWD, HOME)).toBe('~/Javascript/optihashi');
    expect(shortenDirectory(HOME, CWD, HOME)).toBe('~');
  });

  it('prefers a path relative to the working directory when it is shorter', () => {
    expect(shortenDirectory('/Users/jude/Javascript/bike4mind/apps/desktop', CWD, HOME)).toBe('./apps/desktop');
    expect(shortenDirectory(CWD, CWD, HOME)).toBe('.');
  });

  /** A climb out of the working directory is longer than the path it replaces and says less. */
  it('does not climb out of the working directory to look relative', () => {
    expect(shortenDirectory('/etc/nginx', CWD, HOME)).toBe('/etc/nginx');
    expect(shortenDirectory('/Users/jude/Documents', CWD, HOME)).toBe('~/Documents');
  });

  it('leaves a path with neither prefix alone', () => {
    expect(shortenDirectory('/opt/homebrew/bin', CWD, HOME)).toBe('/opt/homebrew/bin');
  });
});
