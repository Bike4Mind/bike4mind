import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Resource } from 'sst';
import { securityDashboardSnapshotRepository, cacheRepository } from '@bike4mind/database';
import { z } from 'zod';
import crypto from 'crypto';
import { OperationsModelService } from '@client/services/operationsModelService';
import { cacheService } from '@bike4mind/services';
import { CacheKeys } from '@server/utils/cacheKeys';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'AdminSecurityDashboardAiAssessment' } });

const RawRecommendationSchema = z.object({
  id: z.string().optional(),
  category: z.enum(['database', 'packages', 'waf', 'cloud', 'secrets', 'code', 'web', 'misc']),
  priority: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1),
  rationale: z.string().min(1),
  suggestedAction: z.string().min(1),
});

type RawRecommendation = z.infer<typeof RawRecommendationSchema>;

function stableRecommendationId(rec: RawRecommendation): string {
  const material = `${rec.category}|${rec.priority}|${rec.title}|${rec.suggestedAction}`;
  return `rec-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

type NormalizedRecommendation = Omit<RawRecommendation, 'id'> & { id: string };

const RecommendationSchema = RawRecommendationSchema.transform<NormalizedRecommendation>(rec => {
  const id = rec.id?.trim() || stableRecommendationId(rec);
  return { ...rec, id };
});

const AiSecurityAssessmentSchema = z.object({
  overallSummary: z.string().min(1),
  recommendations: z.array(RecommendationSchema).max(6),
});

export type AiSecurityAssessment = Omit<z.infer<typeof AiSecurityAssessmentSchema>, 'recommendations'> & {
  recommendations: NormalizedRecommendation[];
  generatedAt: string;
  nextAssessmentAt: string;
};

type SeverityCounts = { critical: number; high: number; medium: number; low: number };

function countsFromFindings(
  findings: Array<{ severity?: string | null | undefined }> | undefined | null
): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings ?? []) {
    const sev = typeof f?.severity === 'string' ? f.severity.toLowerCase() : '';
    if (sev === 'critical') counts.critical += 1;
    else if (sev === 'high') counts.high += 1;
    else if (sev === 'medium') counts.medium += 1;
    else if (sev === 'low') counts.low += 1;
  }
  return counts;
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

type LatestSnapshots = {
  effectiveWeb: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
  code: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
  packages: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
  secrets: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
  cloud: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
  waf: Awaited<ReturnType<typeof securityDashboardSnapshotRepository.findLatestByStageAndScanType>> | null;
};

async function fetchLatestSnapshots(stage: string): Promise<LatestSnapshots> {
  const [webOwasp, webLegacy, code, packages, secrets, cloud, waf] = await Promise.all([
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web-owasp'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'code-semgrep'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'packages'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'secrets'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud'),
    securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'waf'),
  ]);

  return {
    effectiveWeb: webOwasp ?? webLegacy,
    code,
    packages,
    secrets,
    cloud,
    waf,
  };
}

async function generateAiAssessment(stage: string, snapshots: LatestSnapshots): Promise<AiSecurityAssessment> {
  const { effectiveWeb, code, packages, secrets, cloud, waf } = snapshots;

  const categories = [
    {
      id: 'web' as const,
      enabled: true,
      failedCounts: countsFromFindings(effectiveWeb?.findings),
      lastCheckedAt: effectiveWeb?.checkedAt ? effectiveWeb.checkedAt.toISOString() : null,
    },
    {
      id: 'code' as const,
      enabled: true,
      failedCounts: countsFromFindings(code?.findings),
      lastCheckedAt: code?.checkedAt ? code.checkedAt.toISOString() : null,
    },
    {
      id: 'packages' as const,
      enabled: true,
      failedCounts: countsFromFindings(packages?.findings),
      lastCheckedAt: packages?.checkedAt ? packages.checkedAt.toISOString() : null,
    },
    {
      id: 'secrets' as const,
      enabled: true,
      failedCounts: countsFromFindings(secrets?.findings),
      lastCheckedAt: secrets?.checkedAt ? secrets.checkedAt.toISOString() : null,
    },
    {
      id: 'cloud' as const,
      enabled: true,
      failedCounts: countsFromFindings(cloud?.findings),
      lastCheckedAt: cloud?.checkedAt ? cloud.checkedAt.toISOString() : null,
    },
    {
      id: 'waf' as const,
      enabled: Boolean(waf),
      failedCounts: countsFromFindings(waf?.findings),
      lastCheckedAt: waf?.checkedAt ? waf.checkedAt.toISOString() : null,
    },
  ];

  // Sanitize AI input: counts + timestamps only (no raw findings, no finding titles/descriptions).
  const aiInput = {
    stage,
    overallSnapshot: {
      categories: categories.map(c => ({
        id: c.id,
        enabled: c.enabled,
        failedCounts: c.failedCounts,
        lastCheckedAt: c.lastCheckedAt,
      })),
    },
  };

  const operationsModel = await OperationsModelService.getOperationsModel();
  const { modelId, llm, modelInfo } = operationsModel;

  if (!llm) {
    throw new Error('Failed to initialize LLM');
  }

  const brand = process.env.APP_NAME || '';
  const systemPrompt = `
You are a senior security analyst for ${brand ? `the ${brand} platform` : 'this platform'}.

You will receive a JSON object with security scan *aggregates only* (counts by severity and timestamps) for multiple categories.

Your task:
1) Write a concise overallSummary (2–4 sentences) describing the current security posture for this stage.
2) Provide 3–5 prioritized recommendations. Each recommendation must be actionable and grounded only in the provided categories/counts/timestamps.

Constraints:
- Do NOT invent findings or controls that are not present.
- If a category is disabled or has never been scanned (lastCheckedAt is null), call that out and suggest enabling/running the scan.
- Do NOT include any raw findings or file/code references.
- Output JSON only, matching this exact shape:
{
  overallSummary: string;
  recommendations: Array<{
    id?: string;
    category: 'database' | 'packages' | 'waf' | 'cloud' | 'secrets' | 'code' | 'web' | 'misc';
    priority: 'high' | 'medium' | 'low';
    title: string;
    rationale: string;
    suggestedAction: string;
  }>;
}
`.trim();

  const userPrompt = `
Here is the aggregated security snapshot:

${JSON.stringify(aiInput, null, 2)}

Respond ONLY with the JSON object, no prose, no backticks.
`.trim();

  let rawResponse = '';
  await llm.complete(
    modelId,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.2,
      maxTokens: 900,
      stream: false,
    },
    async parts => {
      const chunk = parts.filter(Boolean).join('');
      if (chunk) rawResponse += chunk;
    }
  );

  const trimmed = rawResponse.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  let parsed: z.infer<typeof AiSecurityAssessmentSchema>;
  if (start === -1 || end === -1 || end <= start) {
    logger.error('AI assessment did not contain JSON object, using fallback', {
      modelId: modelInfo.id,
      rawResponseHash: sha256(trimmed),
      rawResponseLength: trimmed.length,
      rawResponsePreview: trimmed.slice(0, 200),
    });
    parsed = {
      overallSummary:
        'AI assessment is temporarily unavailable. Review the category cards for the latest deterministic scan results.',
      recommendations: [],
    };
  } else {
    try {
      const jsonText = trimmed.slice(start, end + 1);
      const json = JSON.parse(jsonText);
      parsed = AiSecurityAssessmentSchema.parse(json);
    } catch (error) {
      logger.error('Failed to parse/validate AI assessment JSON, using fallback', {
        modelId: modelInfo.id,
        error: error instanceof Error ? error.message : String(error),
        rawResponseHash: sha256(trimmed),
        rawResponseLength: trimmed.length,
        rawResponsePreview: trimmed.slice(0, 200),
      });
      parsed = {
        overallSummary:
          'AI assessment is temporarily unavailable. Review the category cards for the latest deterministic scan results.',
        recommendations: [],
      };
    }
  }

  const generatedAt = new Date().toISOString();
  const ttlMinutes = 60;
  const nextAssessmentAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  const recommendations = (parsed.recommendations ?? []).slice(0, 5);

  return {
    overallSummary: parsed.overallSummary,
    recommendations,
    generatedAt,
    nextAssessmentAt,
  };
}

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const stage = Resource.App.stage;

  // Cache is keyed by a hash of (counts + timestamps + enabled flags).
  const snapshots = await fetchLatestSnapshots(stage);
  const { effectiveWeb, code, packages, secrets, cloud, waf } = snapshots;

  const cacheFingerprint = {
    stage,
    categories: [
      {
        id: 'web',
        enabled: true,
        lastCheckedAt: effectiveWeb?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(effectiveWeb?.findings),
      },
      {
        id: 'code',
        enabled: true,
        lastCheckedAt: code?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(code?.findings),
      },
      {
        id: 'packages',
        enabled: true,
        lastCheckedAt: packages?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(packages?.findings),
      },
      {
        id: 'secrets',
        enabled: true,
        lastCheckedAt: secrets?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(secrets?.findings),
      },
      {
        id: 'cloud',
        enabled: true,
        lastCheckedAt: cloud?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(cloud?.findings),
      },
      {
        id: 'waf',
        enabled: Boolean(waf),
        lastCheckedAt: waf?.checkedAt?.toISOString() ?? null,
        counts: countsFromFindings(waf?.findings),
      },
    ],
  };

  const fingerprintHash = sha256(JSON.stringify(cacheFingerprint));
  const cacheKey = CacheKeys.securityDashboardAiAssessment(stage, fingerprintHash);

  const assessment = await cacheService.getCachedData<AiSecurityAssessment>(
    cacheKey,
    () => generateAiAssessment(stage, snapshots),
    {
      db: { caches: cacheRepository },
      expiry: 60 * 60 * 1000, // 60 minutes
      logger,
    }
  );

  return res.status(200).json(assessment);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
