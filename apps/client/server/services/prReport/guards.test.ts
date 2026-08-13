import { describe, it, expect } from 'vitest';

import { assertRepoFormat, createAssertChatTargetFormat } from './guards';

describe('assertRepoFormat - SSRF guard', () => {
  it('accepts a well-formed owner/repo', () => {
    expect(() => assertRepoFormat('Bike4Mind/bike4mind')).not.toThrow();
    expect(() => assertRepoFormat('MillionOnMars/blueprints')).not.toThrow();
    expect(() => assertRepoFormat('a/b')).not.toThrow();
    expect(() => assertRepoFormat('my-org/my.repo_name-2')).not.toThrow();
  });

  it('rejects a relative path segment', () => {
    // The traversal case. GitHubService's own parseRepo permits `.` in its per-segment
    // character class, so `owner/..` passes THERE - which is why this guard exists.
    expect(() => assertRepoFormat('owner/..')).toThrow(/relative path segment/);
    expect(() => assertRepoFormat('../repo')).toThrow();
    expect(() => assertRepoFormat('owner/.')).toThrow(/relative path segment/);
  });

  it('rejects an empty segment', () => {
    expect(() => assertRepoFormat('/repo')).toThrow();
    expect(() => assertRepoFormat('owner/')).toThrow();
    expect(() => assertRepoFormat('/')).toThrow();
  });

  it('rejects anything that is not exactly two segments', () => {
    expect(() => assertRepoFormat('owner')).toThrow();
    expect(() => assertRepoFormat('owner/repo/extra')).toThrow();
  });

  it('rejects an unset or non-string value', () => {
    expect(() => assertRepoFormat('')).toThrow(/not configured/);
    expect(() => assertRepoFormat(undefined as unknown as string)).toThrow(/not configured/);
  });

  it('is anchored, so a URL cannot smuggle a valid-looking repo through', () => {
    expect(() => assertRepoFormat('https://evil.example.com/?x=owner/repo')).toThrow();
    expect(() => assertRepoFormat('evil.example.com/owner/repo')).toThrow();
    expect(() => assertRepoFormat('owner/repo?x=1')).toThrow();
    expect(() => assertRepoFormat('owner/repo#frag')).toThrow();
    expect(() => assertRepoFormat('owner/repo\n')).toThrow();
  });

  it('rejects surrounding whitespace rather than silently trimming it', () => {
    expect(() => assertRepoFormat(' owner/repo')).toThrow(/whitespace/);
  });
});

describe('createAssertChatTargetFormat - egress guard', () => {
  const TARGET = { token: 'xoxb-super-secret-token', channel: 'C0DIGEST1' };

  it('accepts a target whose API host is on the allowlist', () => {
    const guard = createAssertChatTargetFormat({ allowedHosts: ['slack.com'] });
    expect(() => guard(TARGET)).not.toThrow();
  });

  it('FAILS CLOSED with no allowlist configured', () => {
    // The degrade-to-allow-any path is how a guard silently stops guarding. This is also
    // every deployment's first-run state, which is why it has its own terminal shape.
    expect(() => createAssertChatTargetFormat({ allowedHosts: [] })(TARGET)).toThrow(/no egress allowlist/);
    expect(() => createAssertChatTargetFormat({ allowedHosts: undefined as unknown as string[] })(TARGET)).toThrow(
      /no egress allowlist/
    );
  });

  it('rejects a host that is not on the allowlist', () => {
    const guard = createAssertChatTargetFormat({
      allowedHosts: ['slack.com'],
      apiBaseUrl: 'https://exfil.example.com/api/',
    });

    expect(() => guard(TARGET)).toThrow(/not on the egress allowlist/);
  });

  it('rejects a non-HTTPS destination', () => {
    const guard = createAssertChatTargetFormat({
      allowedHosts: ['chat.internal.test'],
      apiBaseUrl: 'http://chat.internal.test/api/',
    });

    expect(() => guard(TARGET)).toThrow(/not HTTPS/);
  });

  it('supports a self-hosted host the operator names', () => {
    const guard = createAssertChatTargetFormat({
      allowedHosts: ['chat.internal.test'],
      apiBaseUrl: 'https://chat.internal.test/api/',
    });

    expect(() => guard(TARGET)).not.toThrow();
  });

  it('rejects a missing or incomplete destination', () => {
    const guard = createAssertChatTargetFormat({ allowedHosts: ['slack.com'] });

    expect(() => guard(null)).toThrow(/no destination configured/);
    expect(() => guard(undefined)).toThrow(/no destination configured/);
    expect(() => guard({ token: '', channel: 'C1' })).toThrow(/no destination configured/);
    expect(() => guard({ token: 'xoxb-x', channel: '' })).toThrow(/no destination configured/);
  });

  it('never echoes the rejected value in its message', () => {
    // The guard is handed the whole credential, so an error built from its input would
    // return that credential to the browser.
    const guard = createAssertChatTargetFormat({
      allowedHosts: ['slack.com'],
      apiBaseUrl: 'https://exfil.example.com/api/',
    });

    try {
      guard(TARGET);
      throw new Error('expected the guard to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(TARGET.token);
      expect(message).not.toContain(TARGET.channel);
      expect(message).not.toContain('exfil.example.com');
    }
  });
});
