import type { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';
import { resolveStage } from '@server/security/resolveStage';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { isPlaceholderValue } from '@bike4mind/common';
import axios from 'axios';

const logger = new Logger({ metadata: { service: 'cloud-prowler-api' } });

const WORKFLOW_FILE = 'prowler-only.yml';

const handler = baseApi<Request, Response>()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const stage = resolveStage();
    const snapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud-prowler');

    // Return null when no Prowler snapshot exists yet - expected on new deployments
    return res.status(200).json(snapshot ?? null);
  })
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const prowlerResource = Resource as typeof Resource & {
      SECOPS_PROWLER_WORKFLOW_TOKEN?: { value: string };
    };

    const githubToken =
      prowlerResource.SECOPS_PROWLER_WORKFLOW_TOKEN?.value || process.env.SECOPS_PROWLER_WORKFLOW_TOKEN;

    if (!githubToken || isPlaceholderValue(githubToken)) {
      return res.status(500).json({ error: 'Prowler workflow dispatch token is not configured.' });
    }

    const githubRepo = process.env.GITHUB_ZAP_REPO || 'MillionOnMars/lumina5';
    const ref = Resource.GITHUB_ZAP_REF?.value || process.env.GITHUB_ZAP_REF || 'main';

    const stage = resolveStage();
    // Map SST stage to the workflow environment input (dev = staging, production = production)
    const environment = stage === 'production' ? 'production' : 'dev';

    try {
      await axios.post(
        `https://api.github.com/repos/${githubRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        { ref, inputs: { environment } },
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'lumina5-security-dashboard',
          },
        }
      );

      logger.info('Prowler workflow dispatched', { environment, workflow: WORKFLOW_FILE, ref, githubRepo });
      return res.status(202).json({ queued: true, environment });
    } catch (error) {
      logger.error('Failed to dispatch Prowler workflow', {
        error: error instanceof Error ? error.message : String(error),
        githubRepo,
        workflow: WORKFLOW_FILE,
        ref,
      });

      return res.status(500).json({ error: 'Failed to trigger Prowler workflow.' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
