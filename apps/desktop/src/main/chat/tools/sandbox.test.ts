import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildProfile } from './sandbox';

describe('buildProfile', () => {
  it('denies writes everywhere before allowing them under each granted root', () => {
    const profile = buildProfile(['/Users/someone/code'], []);
    const denyAll = profile.indexOf('(deny file-write*)');
    const allowRoot = profile.indexOf('(allow file-write* (subpath "/Users/someone/code"))');

    expect(denyAll).toBeGreaterThan(-1);
    // Seatbelt is last-match-wins, so a blanket deny after the allow would revoke it.
    expect(allowRoot).toBeGreaterThan(denyAll);
  });

  /**
   * Regression guard for the case that makes ordering load-bearing: sharing the home folder
   * makes every credential store writable unless the denials come last.
   */
  it('keeps credential stores denied even when the folder above them is granted', () => {
    const profile = buildProfile([homedir()], []);
    const allowHome = profile.indexOf(`(allow file-write* (subpath "${homedir()}"))`);
    const denySsh = profile.indexOf(`(deny file-read* file-write* (subpath "${homedir()}/.ssh"))`);

    expect(denySsh).toBeGreaterThan(allowHome);
  });

  it('denies the paths the app protects regardless of what was granted', () => {
    const profile = buildProfile([homedir()], ['/Users/someone/Library/Application Support/b4m']);
    expect(profile).toContain(
      '(deny file-read* file-write* (subpath "/Users/someone/Library/Application Support/b4m"))'
    );
  });

  it('escapes quotes and backslashes so a path cannot end the profile string early', () => {
    const profile = buildProfile(['/tmp/od"d\\name'], []);
    expect(profile).toContain('(allow file-write* (subpath "/tmp/od\\"d\\\\name"))');
  });
});
