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
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'packages');

    if (!snapshot) {
      throw new NotFoundError('No packages security snapshot found for this stage.');
    }

    const { score, counts } = computeCategoryScoreAndCounts('packages', snapshot.findings ?? []);
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

    const latest = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'packages');
    const { canRun, hoursRemaining } = getCooldownStatus(latest?.checkedAt);
    if (!canRun) {
      return res.status(429).json({
        canRun: false,
        reason: 'cooldown',
        hoursRemaining,
      });
    }

    const securityResources = Resource as typeof Resource & {
      SECOPS_PACKAGES_DISPATCH_TOKEN?: { value: string };
      GITHUB_ZAP_REF?: { value: string };
    };

    const githubToken =
      // Prefer SST Resource binding in deployed environments
      securityResources.SECOPS_PACKAGES_DISPATCH_TOKEN?.value || process.env.SECOPS_PACKAGES_DISPATCH_TOKEN;

    const githubRepo =
      process.env.GITHUB_PACKAGES_REPO ||
      process.env.GITHUB_CODE_REPO ||
      process.env.GITHUB_ZAP_REPO ||
      'MillionOnMars/lumina5';
    const workflowId = process.env.GITHUB_PACKAGES_WORKFLOW_ID || 'packages-audit.yml';
    const ref =
      // Prefer stage-specific ref from SST Secrets when available
      securityResources.GITHUB_ZAP_REF?.value || process.env.GITHUB_ZAP_REF || 'main';

    if (!githubToken || isPlaceholderValue(githubToken)) {
      return res.status(500).json({
        error: 'GitHub token for triggering packages audit workflow is not configured.',
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
      console.error('Error triggering GitHub packages audit workflow', {
        error,
        githubRepo,
        workflowId,
        ref,
      });

      return res.status(500).json({
        error: 'Failed to trigger packages audit workflow',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
