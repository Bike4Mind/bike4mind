import type { NextFunction, Request, Response } from 'express';

/** Stamped on every API response so a long-lived tab can notice a deploy happened under it. */
export const DEPLOY_REVISION_HEADER = 'X-Deployed-Revision';

// Same shapes /api/health accepts; a stage that sets neither gets no header (and no banner).
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** This process's deploy identity, preferring the commit over the build fingerprint. */
export const getDeployedRevision = (): string | undefined => {
  const revision = process.env.B4M_DEPLOYED_REVISION;
  if (revision && REVISION_PATTERN.test(revision)) return revision;
  const fingerprint = process.env.B4M_BUILD_FINGERPRINT;
  if (fingerprint && FINGERPRINT_PATTERN.test(fingerprint)) return fingerprint;
  return undefined;
};

/** Never rejects: a missing or malformed value simply leaves the header off. */
export const deployRevision = (_req: Request, res: Response, next: NextFunction): void => {
  const revision = getDeployedRevision();
  if (revision) res.setHeader(DEPLOY_REVISION_HEADER, revision);
  next();
};
