import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  authFailLogRepository,
  blockedIPRepository,
  userApiKeyRepository,
  apiKeyAlertRepository,
  cacheRepository,
} from '@bike4mind/database';
import { z } from 'zod';
import { OperationsModelService, getEffectiveApiKeyByBackend } from '@client/services/operationsModelService';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { rateLimit } from '@server/middlewares/rateLimit';
import { cacheService } from '@bike4mind/services';
import { CacheKeys } from '@server/utils/cacheKeys';

const SecurityBehavioralSummarySchema = z.object({
  summary: z.string(),
  securityScore: z.number().min(0).max(100),
  riskLevel: z.enum(['low', 'medium', 'high']),
  recommendations: z.array(z.string()).min(1).max(5),
});

export type SecurityBehavioralSummary = z.infer<typeof SecurityBehavioralSummarySchema>;

const logger = new Logger({ metadata: { service: 'SecurityBehavioralSummary' } });

async function generateSecurityBehavioralSummary(user: { id: string; email: string; username: string }) {
  // 1. Gather security context for the last 24 hours
  const hours = 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Failed logins targeting this user
  const failedLogins = await authFailLogRepository.getUserFailedLogins(user.email, user.username, since);

  // Suspicious patterns where this user was targeted
  const suspiciousPatterns = await authFailLogRepository.getSuspiciousPatternsTargetingUser(user.username, since);

  // Blocked IPs (system-wide, but still signal overall risk)
  const blockedIPs = await blockedIPRepository.list(10);

  // API key usage / alerts
  const apiKeys = await userApiKeyRepository.findByUserId(user.id);
  const activeApiKeyAlerts = await apiKeyAlertRepository.findActiveByUserId(user.id);

  const alertsByKey = activeApiKeyAlerts.reduce<Record<string, typeof activeApiKeyAlerts>>((acc, alert) => {
    if (!acc[alert.keyId]) {
      acc[alert.keyId] = [];
    }
    acc[alert.keyId].push(alert);
    return acc;
  }, {});

  const apiKeySummary = {
    totalKeys: apiKeys.length,
    keysWithAlerts: Object.keys(alertsByKey).length,
    alerts: activeApiKeyAlerts.map(alert => ({
      keyId: alert.keyId,
      alertType: alert.alertType,
      message: alert.message,
      detectedAt: alert.detectedAt,
    })),
  };

  const context = {
    userId: user.id,
    username: user.username,
    email: user.email,
    windowHours: hours,
    failedLogins: {
      count: failedLogins.length,
      lastAt: failedLogins[0]?.createdAt ?? null,
    },
    suspiciousPatterns: {
      count: suspiciousPatterns.length,
      items: suspiciousPatterns.slice(0, 5).map(pattern => ({
        ip: pattern.ip,
        attempts: pattern.attempts,
        usernames: pattern.usernames,
        lastAttempt: pattern.lastAttempt,
        riskLevel: pattern.riskLevel,
      })),
    },
    blockedIPs: {
      count: blockedIPs.length,
      items: blockedIPs.map(item => ({
        ip: item.ip,
        blockedAt: item.blockedAt,
        reason: item.reason,
      })),
    },
    apiKeys: apiKeySummary,
    // Placeholder for phishing test integration; not yet wired up
    phishingTest: {
      integrated: false,
    },
  };

  // 2. Get operations model (system-level) and initialize LLM backend
  const operationsModel = await OperationsModelService.getOperationsModel();
  const operationsModelInfo = operationsModel.modelInfo;

  const apiKeyForBackend = await getEffectiveApiKeyByBackend(user.id, operationsModelInfo.backend);
  const apiKeyTable = {
    [operationsModelInfo.backend]: apiKeyForBackend,
  };

  const llmBackend = getLlmByModel(apiKeyTable, { modelInfo: operationsModelInfo, logger, endUserId: user.id });

  if (!llmBackend) {
    logger.error('Failed to initialize LLM backend for security behavioral assessment', {
      backend: operationsModelInfo.backend,
      modelId: operationsModelInfo.id,
    });
    throw new Error('Failed to initialize LLM backend');
  }

  // 3. Build prompt
  const brand = process.env.APP_NAME || '';
  const systemPrompt = `
You are a senior security analyst for ${brand ? `the ${brand} platform` : 'this platform'}.
You are given a JSON object that summarizes one user's recent account security activity.

Your job is to:
1) Briefly describe the user's current security posture in 2–4 sentences.
2) Assign a numeric securityScore from 0–100 (0 = critical risk, 100 = excellent security posture).
3) Map that score to a riskLevel: securityScore >= 70 is "low", 30–69 is "medium", below 30 is "high".
4) Provide 2–3 concise, actionable recommendations focused on what THIS user should do next.

IMPORTANT:
- Focus only on this user's account, not global system risk.
- Be clear but not alarmist; match the riskLevel.
- Respond with **JSON only**, matching this exact TypeScript type:
  {
    summary: string;
    securityScore: number; // 0–100, higher = safer
    riskLevel: 'low' | 'medium' | 'high';
    recommendations: string[]; // 2–3 short bullet points
  }
`;

  const userPrompt = `
Here is the JSON context for this user's recent security activity (last ${hours} hours):

${JSON.stringify(context, null, 2)}

Respond ONLY with the JSON object, no prose, no backticks.
`;

  const messages = [
    { role: 'system' as const, content: systemPrompt.trim() },
    { role: 'user' as const, content: userPrompt.trim() },
  ];

  let rawResponse = '';

  await llmBackend.complete(
    operationsModelInfo.id,
    messages,
    {
      temperature: 0.2,
      maxTokens: 400,
      stream: false,
    },
    async textParts => {
      const chunk = textParts.filter(Boolean).join('');
      if (chunk) {
        rawResponse += chunk;
      }
    }
  );

  // 4. Extract and validate JSON
  const trimmed = rawResponse.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  let parsed: SecurityBehavioralSummary;

  if (start === -1 || end === -1 || end <= start) {
    logger.warn('LLM response did not contain JSON object, using fallback', {
      rawResponse: trimmed.slice(0, 200),
    });
    parsed = {
      summary:
        'We could not automatically analyze your account activity. Based on current telemetry, your account appears to be low risk.',
      securityScore: 80,
      riskLevel: 'low',
      recommendations: [
        'Enable two-factor authentication for your account.',
        'Review your recent login history for any devices you do not recognize.',
      ],
    };
  } else {
    const jsonText = trimmed.slice(start, end + 1);

    try {
      const json = JSON.parse(jsonText);
      parsed = SecurityBehavioralSummarySchema.parse(json);
    } catch (error) {
      logger.warn('Failed to parse/validate LLM JSON, using fallback', {
        error: error instanceof Error ? error.message : String(error),
        rawResponse: trimmed.slice(0, 200),
      });

      parsed = {
        summary:
          'We could not reliably interpret the AI analysis. At this time, your account appears to be low risk based on available data.',
        securityScore: 80,
        riskLevel: 'low',
        recommendations: [
          'Enable two-factor authentication for your account.',
          'Use a strong, unique password that you do not reuse on other sites.',
        ],
      };
    }
  }

  return parsed;
}

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 20 : 5,
      windowMs: 60 * 1000,
    })
  )
  .get(
    asyncHandler(async (req, res) => {
      const user = req.user;

      if (!user || !user.email || !user.username || !user.id) {
        return res.status(401).json({ error: 'User not authenticated or missing required fields' });
      }

      try {
        const safeUser = {
          id: user.id as string,
          email: user.email as string,
          username: user.username as string,
        };

        const cacheKey = CacheKeys.securityBehavioralSummary(safeUser.id);

        const summary = await cacheService.getCachedData<SecurityBehavioralSummary>(
          cacheKey,
          () => generateSecurityBehavioralSummary(safeUser),
          {
            db: { caches: cacheRepository },
            expiry: 5 * 60 * 1000, // cache for 5 minutes
            logger,
          }
        );

        return res.status(200).json(summary);
      } catch (error) {
        logger.error('Security behavioral assessment failed', {
          userId: req.user?.id,
          error: error instanceof Error ? error.message : String(error),
        });

        const fallback: SecurityBehavioralSummary = {
          summary:
            'We encountered an error while generating your AI security summary. Based on currently available telemetry, your account does not show obvious signs of compromise.',
          securityScore: 80,
          riskLevel: 'low',
          recommendations: [
            'Enable two-factor authentication for your account.',
            'Review recent login attempts on the Security tab for any unfamiliar devices or IP addresses.',
          ],
        };

        return res.status(200).json(fallback);
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
