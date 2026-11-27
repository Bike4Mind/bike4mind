import { describe, it, expect } from 'vitest';
import { resolveEnvironmentBanner } from './environmentBanner';

describe('resolveEnvironmentBanner', () => {
  it('detects local development from a bare localhost host', () => {
    expect(resolveEnvironmentBanner('localhost', 'bike4mind.com')).toEqual({
      environment: 'local',
      environmentName: 'Local Development',
    });
  });

  it('detects local development when the host carries a port (localhost:)', () => {
    expect(resolveEnvironmentBanner('localhost:3000', 'bike4mind.com')).toEqual({
      environment: 'local',
      environmentName: 'Local Development',
    });
  });

  it('detects staging from the staging substring', () => {
    expect(resolveEnvironmentBanner('app.staging.bike4mind.com', 'staging.bike4mind.com')).toEqual({
      environment: 'staging',
      environmentName: 'Staging Environment',
    });
  });

  // Regression: preview hosts exactly equal `app.${NEXT_PUBLIC_SERVER_DOMAIN}`
  // (per-PR domain `pr<N>.preview.<domain>`), so before the preview guard they fell into
  // the production branch and were mislabeled "Production".
  it('detects preview env and does NOT mislabel it as Production', () => {
    expect(resolveEnvironmentBanner('app.pr9490.preview.bike4mind.com', 'pr9490.preview.bike4mind.com')).toEqual({
      environment: 'preview',
      environmentName: 'Preview Environment',
    });
  });

  // The preview check anchors on `.preview.`, not a bare `preview` substring, so a
  // production vanity domain containing "preview" stays Production.
  it('does NOT mislabel a production domain that merely contains "preview" as Preview', () => {
    expect(resolveEnvironmentBanner('app.previewco.com', 'previewco.com')).toEqual({
      environment: 'production',
      environmentName: 'Production Environment',
    });
  });

  it('detects production when the host exactly matches app.<serverDomain>', () => {
    expect(resolveEnvironmentBanner('app.bike4mind.com', 'bike4mind.com')).toEqual({
      environment: 'production',
      environmentName: 'Production Environment',
    });
  });

  it('works for a non-bike4mind brand production domain (open-core)', () => {
    expect(resolveEnvironmentBanner('app.groktool.com', 'groktool.com')).toEqual({
      environment: 'production',
      environmentName: 'Production Environment',
    });
  });

  it('falls back to Unknown when no branch matches', () => {
    expect(resolveEnvironmentBanner('app.bike4mind.com', 'other.com')).toEqual({
      environment: 'unknown',
      environmentName: 'Unknown Environment',
    });
  });

  it('does not flag production when serverDomain is empty/undefined (avoids app.undefined match)', () => {
    expect(resolveEnvironmentBanner('app.somewhere.com', '')).toEqual({
      environment: 'unknown',
      environmentName: 'Unknown Environment',
    });
    expect(resolveEnvironmentBanner('app.somewhere.com', undefined)).toEqual({
      environment: 'unknown',
      environmentName: 'Unknown Environment',
    });
  });

  it('prioritizes staging over production when both could match', () => {
    // A hypothetical staging host whose serverDomain would also satisfy the production
    // exact-match. Staging must win because it is checked first.
    expect(resolveEnvironmentBanner('app.staging.bike4mind.com', 'staging.bike4mind.com')).toEqual({
      environment: 'staging',
      environmentName: 'Staging Environment',
    });
  });
});
