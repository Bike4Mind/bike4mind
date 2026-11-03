// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DEPLOY_REVISION_HEADER, deployRevision, getDeployedRevision } from './deployRevision';

const REVISION = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);

const run = () => {
  const setHeader = vi.fn();
  const next = vi.fn();
  deployRevision({} as Request, { setHeader } as unknown as Response, next as NextFunction);
  return { setHeader, next };
};

afterEach(() => vi.unstubAllEnvs());

describe('deployRevision', () => {
  it('stamps the deployed revision', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', REVISION);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', '');

    const { setHeader, next } = run();

    expect(setHeader).toHaveBeenCalledWith(DEPLOY_REVISION_HEADER, REVISION);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to the build fingerprint when no revision is set', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', '');
    vi.stubEnv('B4M_BUILD_FINGERPRINT', FINGERPRINT);

    const { setHeader } = run();

    expect(setHeader).toHaveBeenCalledWith(DEPLOY_REVISION_HEADER, FINGERPRINT);
  });

  it('prefers the full build fingerprint over the core revision', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', REVISION);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', FINGERPRINT);

    const { setHeader } = run();

    expect(setHeader).toHaveBeenCalledWith(DEPLOY_REVISION_HEADER, FINGERPRINT);
  });

  it('changes identity when a new build shares the same core revision', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', REVISION);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', FINGERPRINT);
    const firstIdentity = getDeployedRevision();

    const nextFingerprint = 'c'.repeat(64);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', nextFingerprint);

    expect(firstIdentity).toBe(FINGERPRINT);
    expect(getDeployedRevision()).toBe(nextFingerprint);
  });

  it('uses the core revision when the fingerprint is malformed', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', REVISION);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', 'not-a-fingerprint');

    expect(run().setHeader).toHaveBeenCalledWith(DEPLOY_REVISION_HEADER, REVISION);
  });

  it('uses the fingerprint when the revision is malformed', () => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', 'main');
    vi.stubEnv('B4M_BUILD_FINGERPRINT', FINGERPRINT);

    const { setHeader } = run();

    expect(setHeader).toHaveBeenCalledWith(DEPLOY_REVISION_HEADER, FINGERPRINT);
  });

  it.each([
    ['both unset', '', ''],
    ['malformed revision and no fingerprint', 'main', ''],
    ['malformed revision and malformed fingerprint', 'main', 'not-a-fingerprint'],
  ])('sets no header and still continues with %s', (_label, revision, fingerprint) => {
    vi.stubEnv('B4M_DEPLOYED_REVISION', revision);
    vi.stubEnv('B4M_BUILD_FINGERPRINT', fingerprint);

    const { setHeader, next } = run();

    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
