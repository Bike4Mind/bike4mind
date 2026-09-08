import { describe, it, expect } from 'vitest';
import { getControlledScopes } from './slackManifestTemplate';

/**
 * Scopes are granted once at install and cannot be widened by a running server, so a feature that
 * needs a scope this list omits fails at runtime in the workspace rather than in CI. These pin the
 * scopes the Slack `@datalake add` surface depends on, named explicitly so that removing one shows up
 * as a failing expectation about a feature instead of a silent string deletion from a list of 19.
 */
describe('Slack bot scopes required by the @datalake add surface', () => {
  it.each([
    ['files:read', 'downloading the attachment on the FILE ingest path'],
    ['chat:write', 'the in-thread confirmation and refusal replies'],
    ['app_mentions:read', 'seeing the @datalake mention at all'],
    ['users:read.email', 'resolving the Slack actor to a platform user before any write gate runs'],
  ])('grants %s, needed for %s', scope => {
    expect(getControlledScopes().bot).toContain(scope);
  });

  it('keeps the scope set independent of any feature flag', () => {
    // The property that let `EnableDataLakeSlackAdd` go live without a reinstall: this function takes
    // no arguments, so no flag or setting can reach it to change what a workspace granted at install.
    expect(getControlledScopes.length).toBe(0);
  });

  it('returns an isolated copy, so a caller cannot mutate the granted set', () => {
    // `SLACK_BOT_SCOPES` is a module-level const built from this call. If the array were shared, one
    // caller pushing or splicing would silently change the scopes every later install requests.
    const first = getControlledScopes().bot;
    first.push('admin');
    expect(getControlledScopes().bot).not.toContain('admin');
  });
});
