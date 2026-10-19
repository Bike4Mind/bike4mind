import {
  BadRequestError,
  ForbiddenError,
  HTTPError,
  HttpStatus,
  type ISkill,
  type ISkillScanFinding,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { RequestHandler } from 'express';
import type { GlobalSkillScan } from '@server/utils/skillAccess';
import { enforceSubmitRateLimits, loadMarketSettings, meetsPublicAccountAge, toSnapshot } from './market';
import { reviewStatusFor, runDeterministicScan } from './scanRules';
import { scanSkillSnapshot, type ScanDeps } from './submitVersion';

const MAX_REASONS = 5;

const refuse = (lead: string, findings: ISkillScanFinding[]): never => {
  const reasons = [...new Set(findings.filter(f => f.severity !== 'low').map(f => f.message))].slice(0, MAX_REASONS);
  throw new BadRequestError(reasons.length ? `${lead} ${reasons.join('; ')}` : lead, { scanFindings: findings });
};

/**
 * Gate for a non-admin update to a global skill (`globalSkillScanFor` in skillAccess.ts picks the
 * mode). `content` runs the same Skill Market scan a listing version gets, held to the Public bar
 * since a global skill reaches everyone: only a result the market would publish to Public without a
 * human reviewer saves, and only from an account old enough to publish to Public. It shares the
 * market's submit rate limits, since each scan may cost a classifier call. `name` runs only the deterministic rules over the new name (no LLM call).
 * Throws on anything that may not save.
 *
 * Global saves have no listing version, so they can't join the market's audit queue; every content
 * scan is logged instead, with `auditSample` drawn at the market's `auditSampleRate`.
 */
export async function scanGlobalSkillUpdate(
  merged: ISkill,
  mode: Exclude<GlobalSkillScan, 'none'>,
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  deps: Pick<ScanDeps, 'getClassifier' | 'random'> & { logger: Logger; actorId: string }
): Promise<void> {
  const settings = await loadMarketSettings();
  if (!meetsPublicAccountAge(req.user!, settings)) {
    throw new ForbiddenError(
      `New accounts can change skills shared with everyone after ${settings.publicMinAccountAgeDays} days.`
    );
  }
  const rules = { highRiskTools: settings.highRiskTools, urlAllowlist: settings.urlAllowlist };

  if (mode === 'name') {
    const findings = runDeterministicScan(
      { name: merged.name, description: '', body: '', disableModelInvocation: false },
      rules
    );
    if (findings.some(f => f.severity === 'critical')) {
      refuse('This name did not pass the Skill Market safety scan, so it was not saved.', findings);
    }
    return;
  }

  await enforceSubmitRateLimits(req, res);
  const scan = await scanSkillSnapshot(toSnapshot(merged), settings, deps.getClassifier);
  const saves =
    scan.status === 'scored' && scan.tier !== 'failed' && reviewStatusFor(scan.tier, 'public') === 'auto_approved';

  deps.logger.info('Skill Market scan of a global skill update', {
    skillId: merged.id,
    actorId: deps.actorId,
    status: scan.status,
    tier: scan.status === 'scored' ? scan.tier : undefined,
    saved: saves,
    findings: scan.findings.map(f => ({ rule: f.rule, severity: f.severity, source: f.source })),
    model: scan.status === 'scored' ? scan.classifier?.model : scan.model,
    auditSample: saves && (deps.random ?? Math.random)() < settings.auditSampleRate,
  });

  if (scan.status === 'error') {
    throw new HTTPError(
      HttpStatus.ServiceUnavailable,
      'The safety scan could not finish, so nothing was saved. Try again.'
    );
  }
  if (saves) return;
  refuse(
    scan.tier === 'failed'
      ? 'This change did not pass the Skill Market safety scan, so it was not saved.'
      : 'This change needs a Skill Market reviewer before it reaches everyone, so it was not saved. Publish it through the Skill Market instead.',
    scan.findings
  );
}
