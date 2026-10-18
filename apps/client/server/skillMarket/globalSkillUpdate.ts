import { BadRequestError, HTTPError, HttpStatus, type ISkill } from '@bike4mind/common';
import type { RequestHandler } from 'express';
import { enforceSubmitRateLimits, loadMarketSettings, toSnapshot } from './market';
import { reviewStatusFor } from './scanRules';
import { scanSkillSnapshot, type ScanDeps } from './submitVersion';

const MAX_REASONS = 5;

/**
 * Gate for a non-admin content change to a global skill (see `skillUpdateNeedsMarketScan` in
 * skillAccess.ts): the same Skill Market scan a listing version gets, held to the Public bar since
 * a global skill reaches everyone. Only a result the market would publish to Public without a human
 * reviewer saves; anything else throws. Rate-limited with the market's submit caps, since each scan
 * may cost a classifier call.
 */
export async function scanGlobalSkillUpdate(
  merged: ISkill,
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  deps: Pick<ScanDeps, 'getClassifier'>
): Promise<void> {
  await enforceSubmitRateLimits(req, res);
  const scan = await scanSkillSnapshot(toSnapshot(merged), await loadMarketSettings(), deps.getClassifier);

  if (scan.status === 'error') {
    throw new HTTPError(
      HttpStatus.ServiceUnavailable,
      'The safety scan could not finish, so nothing was saved. Try again.'
    );
  }
  if (scan.tier !== 'failed' && reviewStatusFor(scan.tier, 'public') === 'auto_approved') return;

  const reasons = [...new Set(scan.findings.filter(f => f.severity !== 'low').map(f => f.message))].slice(
    0,
    MAX_REASONS
  );
  const lead =
    scan.tier === 'failed'
      ? 'This change did not pass the Skill Market safety scan, so it was not saved.'
      : 'This change needs a Skill Market reviewer before it reaches everyone, so it was not saved. Publish it through the Skill Market instead.';
  throw new BadRequestError(reasons.length ? `${lead} ${reasons.join('; ')}` : lead, { scanFindings: scan.findings });
}
