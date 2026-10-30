import type { NextFunction, Request, Response } from 'express';

/**
 * Stamped on every baseApi response so a long-lived tab can notice a deploy happened under it.
 * Must stay in sync with the lowercase literal in app/contexts/apiClient.ts.
 */
export const DEPLOY_REVISION_HEADER = 'X-Deployed-Revision';

// Same shapes /api/health accepts; a stage that sets neither gets no header (and no banner).
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** Prefer the full build identity: distinct builds can share the same core commit. */
export const getDeployedRevision = (): string | undefined => {
  const fingerprint = process.env.B4M_BUILD_FINGERPRINT;
  if (fingerprint && FINGERPRINT_PATTERN.test(fingerprint)) return fingerprint;
  const revision = process.env.B4M_DEPLOYED_REVISION;
  if (revision && REVISION_PATTERN.test(revision)) return revision;
  return undefined;
};

/** Never rejects: a missing or malformed value simply leaves the header off. */
export const deployRevision = (_req: Request, res: Response, next: NextFunction): void => {
  const revision = getDeployedRevision();
  if (revision) res.setHeader(DEPLOY_REVISION_HEADER, revision);
  next();
};
