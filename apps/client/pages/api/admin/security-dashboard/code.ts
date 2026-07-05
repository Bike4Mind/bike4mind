import axios from 'axios';
import { isPlaceholderValue } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { Resource } from 'sst';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';
import { getCooldownStatus } from '@server/security/cooldown';
import { resolveStage } from '@server/security/resolveStage';
import { computeCategoryScoreAndCounts, computeDeterministicStatus } from '@server/security/securityDashboardScoring';

import type { Request, Response } from 'express';

const handler = baseApi<Request, Response>()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'code-semgrep');

    if (!snapshot) {
      throw new NotFoundError('No code analysis snapshot found for this stage.');
    }

    const { score, counts } = computeCategoryScoreAndCounts('code', snapshot.findings ?? []);
    const status = computeDeterministicStatus(counts, score);

    return res.status(200).json({
      ...snapshot,
      score,
      status,
    });
  })
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();

    const latest = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'code-semgrep');
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

    const githubRepo = process.env.GITHUB_CODE_REPO || process.env.GITHUB_ZAP_REPO || 'MillionOnMars/lumina5';
    const workflowId = process.env.GITHUB_CODE_WORKFLOW_ID || 'code-semgrep.yml';
    const ref =
      // Prefer stage-specific ref from SST Secrets when available
      Resource.GITHUB_ZAP_REF?.value || process.env.GITHUB_ZAP_REF || 'main';

    if (!githubToken || isPlaceholderValue(githubToken)) {
      return res.status(500).json({
        error: 'GitHub token for triggering code analysis workflow is not configured.',
      });
    }

    try {
      await axios.post(
        `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflowId}/dispatches`,
        {
          ref,
          inputs: {
            reason: 'manual',
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
      console.error('Error triggering GitHub Semgrep code analysis workflow', {
        error,
        githubRepo,
        workflowId,
        ref,
      });

      return res.status(500).json({
        error: 'Failed to trigger Semgrep code analysis workflow',
        message: error instanceof Error ? error.message : String(error),
        details: {
          githubRepo,
          workflowId,
          ref,
        },
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
