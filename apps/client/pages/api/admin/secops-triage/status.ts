import type { Request, Response } from 'express';
import { SecopsTriageConfigFieldsSchema, SecopsTriageConfigSchema, type SecopsTriageConfig } from '@bike4mind/common';
import { AdminSettings, secopsTriageRunRepository, type SecopsTriageRunItem } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { GitHubService } from '@bike4mind/server-utils/services/githubService';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import {
  checkSecopsTriageRepo,
  type SecopsTriageRepoCheck,
} from '@bike4mind/server-utils/security/secopsTriageRepoCheck';

const logger = new Logger({ metadata: { service: 'secops-triage-status' } });

const RECENT_RUN_LIMIT = 10;

export type SecopsTriageRunSummary = Omit<SecopsTriageRunItem, 'id' | 'stage' | 'startedAt'> & { startedAt: string };

export interface SecopsTriageStatusResponse {
  stage: string;
  enabled: boolean;
  dryRun: boolean;
  severityThreshold: SecopsTriageConfig['severityThreshold'];
  maxIssuesPerScan: number;
  github: {
    connected: boolean;
    repo: string;
    /** Null when there is no connection, or when the lookup failed (`checkError`). */
    check: SecopsTriageRepoCheck | null;
    checkError?: true;
  };
  /** Newest first. */
  recentRuns: SecopsTriageRunSummary[];
  /** The newest run of each scan source on this stage, newest first. */
  latestRunPerSource: SecopsTriageRunSummary[];
}

const savedField = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const toSummary = ({ id, stage, startedAt, ...run }: SecopsTriageRunItem): SecopsTriageRunSummary => ({
  ...run,
  startedAt: startedAt.toISOString(),
});

/** What the SecOps triage worker will find with the saved configuration, plus its recent runs on this stage. */
const handler = adminApi<Request, Response>({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read' },
}).get(async (_req: Request, res: Response) => {
  const stage = resolveStage();

  // Read and parsed the way the worker does. A config that does not parse is skipped by the worker;
  // its saved fields are still shown so the status explains why.
  const setting = await AdminSettings.findOne({ settingName: 'secopsTriageConfig' });
  const saved: unknown = setting?.settingValue ?? {};
  const parsed = SecopsTriageConfigSchema.safeParse(saved);
  const enabled = parsed.success ? parsed.data.enabled : savedField(saved, 'enabled') === true;
  const savedRepo = savedField(saved, 'githubRepo');
  const repo = parsed.success ? parsed.data.githubRepo : typeof savedRepo === 'string' ? savedRepo : '';
  const fields = SecopsTriageConfigFieldsSchema.safeParse(saved);
  const { dryRun, severityThreshold, maxIssuesPerScan } = fields.success
    ? fields.data
    : SecopsTriageConfigFieldsSchema.parse({});

  // A failed GitHub lookup is reported as `checkError` rather than failing the whole status.
  let github: SecopsTriageStatusResponse['github'];
  let githubService: GitHubService | null = null;
  try {
    githubService = await GitHubService.forSystem(logger);
    github = { connected: !!githubService, repo, check: null };
  } catch (error) {
    logger.warn('[SECOPS-TRIAGE-STATUS] System GitHub connection could not be loaded', { error: errorMessage(error) });
    github = { connected: false, repo, check: null, checkError: true };
  }
  if (githubService) {
    try {
      github = { connected: true, repo, check: await checkSecopsTriageRepo(githubService, repo) };
    } catch (error) {
      logger.warn('[SECOPS-TRIAGE-STATUS] Repository check failed', { error: errorMessage(error) });
      github = { connected: true, repo, check: null, checkError: true };
    }
  }

  const [runs, latestRuns] = await Promise.all([
    secopsTriageRunRepository.findRecentByStage(stage, RECENT_RUN_LIMIT),
    secopsTriageRunRepository.findLatestPerSourceByStage(stage),
  ]);

  const body: SecopsTriageStatusResponse = {
    stage,
    enabled,
    dryRun,
    severityThreshold,
    maxIssuesPerScan,
    github,
    recentRuns: runs.map(toSummary),
    latestRunPerSource: latestRuns.map(toSummary),
  };
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json(body);
});

export const config = { api: { externalResolver: true } };

export default handler;
