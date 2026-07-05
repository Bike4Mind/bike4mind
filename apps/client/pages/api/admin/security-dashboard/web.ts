import type { Request, Response } from 'express';
import { isPlaceholderValue } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Resource } from 'sst';
import { securityDashboardSnapshotRepository, type ISecurityDashboardSnapshotDocument } from '@bike4mind/database';
import axios from 'axios';
import { getCooldownStatus } from '@server/security/cooldown';
import { resolveStage } from '@server/security/resolveStage';
import { computeCategoryScoreAndCounts, computeDeterministicStatus } from '@server/security/securityDashboardScoring';
import { getTargetUrlForStage } from '@server/integrations/github/githubWorkflowTrigger';

export interface WebSecuritySnapshotResponse extends ISecurityDashboardSnapshotDocument {}

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const latestOwasp = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web-owasp');
    const latestLegacy =
      latestOwasp ?? (await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web')); // backwards compatibility

    if (!latestLegacy) {
      return res.status(404).json({ error: 'No website security scan has been recorded yet for this stage.' });
    }

    const { score, counts } = computeCategoryScoreAndCounts('web', latestLegacy.findings ?? []);
    const status = computeDeterministicStatus(counts, score);

    return res.status(200).json({
      ...latestLegacy,
      score,
      status,
    });
  })
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const targetUrl = getTargetUrlForStage(stage);

    const latest = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web-owasp');
    const { canRun, hoursRemaining } = getCooldownStatus(latest?.checkedAt);
    if (!canRun) {
      return res.status(429).json({
        canRun: false,
        reason: 'cooldown',
        hoursRemaining,
      });
    }

    const githubToken =
      // Prefer SST Resource binding in deployed environments
      Resource.SECOPS_ZAP_DISPATCH_TOKEN?.value || process.env.SECOPS_ZAP_DISPATCH_TOKEN;
    const githubRepo = process.env.GITHUB_ZAP_REPO || 'MillionOnMars/lumina5';
    const workflowId = process.env.GITHUB_ZAP_WORKFLOW_ID || 'website-owasp-zap.yml';
    const ref =
      // Prefer stage-specific ref from SST Secrets when available
      Resource.GITHUB_ZAP_REF?.value || process.env.GITHUB_ZAP_REF || 'main';

    if (!githubToken || isPlaceholderValue(githubToken)) {
      return res.status(500).json({
        error: 'GitHub token for triggering ZAP workflow is not configured.',
      });
    }

    try {
      await axios.post(
        `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflowId}/dispatches`,
        {
          ref,
          inputs: {
            reason: 'manual',
            target: targetUrl,
            stage,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'lumina5-security-dashboard',
          },
        }
      );

      return res.status(202).json({ canRun: true, queued: true });
    } catch (error) {
      console.error('Error triggering GitHub ZAP workflow', {
        error,
        githubRepo,
        workflowId,
        ref,
      });

      return res.status(500).json({
        error: 'Failed to trigger ZAP website security scan workflow',
        message: error instanceof Error ? error.message : String(error),
        details: {
          githubRepo,
          workflowId,
          ref,
        },
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
