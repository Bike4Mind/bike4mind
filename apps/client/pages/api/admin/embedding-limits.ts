import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { envKey } from '@bike4mind/auth/apiKeyService';
import { adminSettingsRepository } from '@bike4mind/database';
import { getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import {
  ApiKeyScope,
  ModelBackend,
  parseEmbeddingRateLimitHeaders,
  hasUsableLimits,
  type EmbeddingRateLimitSnapshot,
} from '@bike4mind/common';
import { resolveDefaultEmbeddingModel } from '@server/utils/resolveDefaultEmbeddingModel';

/**
 * GET /api/admin/embedding-limits
 *
 * What the configured embedding provider says its CURRENT rate limits are, for the platform admin
 * tuning the data-lake throughput levers against them.
 *
 * The point is that this asks with the credential the environment already holds. A tier is a
 * property of the provider organization, so it cannot be read from the codebase, and the only
 * alternative - a human exporting a production key to run curl by hand - is exactly what should
 * not be necessary to configure a lever correctly.
 *
 * Costs one minimal embedding call per request (a few tokens). Admin-gated rather than cached
 * because it is a deliberate, infrequent action and a stale reading is worse than no reading: the
 * number's whole job is to be current when someone is about to set a lever from it.
 *
 * NEVER returns key material, not even a fragment - the response carries provider limits only.
 */

/** A provider whose limits cannot be read this way, and why - so the UI explains rather than blanks. */
export interface EmbeddingLimitsUnavailable {
  supported: false;
  provider: string;
  model: string;
  reason: string;
}

export interface EmbeddingLimitsAvailable {
  supported: true;
  provider: string;
  model: string;
  limits: EmbeddingRateLimitSnapshot;
  measuredAt: string;
}

export type EmbeddingLimitsResponse = EmbeddingLimitsAvailable | EmbeddingLimitsUnavailable;

/** Smallest input that still produces a real, billable embedding call - the headers only come
 *  back on a genuine request, so there is no zero-cost way to ask. */
const PROBE_INPUT = 'rate limit probe';

/**
 * The PLATFORM embedding credentials: the admin setting, then the self-host env fallback. Mirrors
 * the tail of getEffectiveLLMApiKeys minus its personal-key arm, which is the part that would make
 * this reading describe the wrong account (see the call site).
 *
 * The env arms go through `envKey` rather than reading process.env directly, because that is where
 * the B4M_SELF_HOST gate lives. Reading process.env here would have handed a cloud stage an
 * environment credential the baseline it claims to mirror would never have used.
 */
async function resolvePlatformEmbeddingKeys() {
  const [openaiSetting, voyageSetting, ollamaSetting] = await Promise.all([
    adminSettingsRepository.getSettingsValue('openaiDemoKey'),
    adminSettingsRepository.getSettingsValue('voyageApiKey'),
    adminSettingsRepository.getSettingsValue('ollamaBackend'),
  ]);
  // Returns the TRIMMED value, not the original: this previously tested trim-truthiness and then
  // returned the untrimmed string, so a setting saved with surrounding whitespace reached the
  // outbound Authorization header, which undici rejects outright.
  const str = (value: unknown) => {
    if (typeof value !== 'string') return null;
    return value.trim() || null;
  };
  return {
    openai: str(openaiSetting) ?? envKey('OPENAI_API_KEY'),
    voyageai: str(voyageSetting),
    ollama: str(ollamaSetting) ?? envKey('OLLAMA_BASE_URL'),
  };
}

/**
 * requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key before req.user
 * is set, so a key issued for a narrow integration cannot spend the platform embedding credential
 * on a billable probe just because its owner is an admin. JWT/browser callers still go through the
 * isAdmin check below.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const logger = req.logger;
    const model = await resolveDefaultEmbeddingModel(logger, 'embedding-limits');
    const provider = getProviderFromModel(model);

    // Deliberately NOT getEffectiveLLMApiKeys(req.user.id). That resolver prefers the CALLER's
    // personal key over the platform one, and data-lake ingest resolves per FILE OWNER - so an
    // admin who happens to hold a personal key would be shown their own organization's ceiling
    // while the lever they are about to set governs work that runs on the platform key. Measuring
    // the platform credential is the only reading that describes what this lever actually bounds.
    const apiKeyTable = await resolvePlatformEmbeddingKeys();
    const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);

    if (missing) {
      return res.json({
        supported: false,
        provider,
        model,
        reason: `No ${missing} credential is configured, so there is no account whose limits could be read.`,
      } satisfies EmbeddingLimitsUnavailable);
    }

    // Bedrock authenticates through the AWS credential chain and publishes quotas through the
    // Service Quotas API, not response headers; Ollama is a local server with no quota at all.
    // Both are legitimate configurations, so they get an explanation rather than an error.
    if (provider === ModelBackend.Bedrock) {
      return res.json({
        supported: false,
        provider,
        model,
        reason: 'Bedrock publishes quotas through AWS Service Quotas rather than response headers.',
      } satisfies EmbeddingLimitsUnavailable);
    }
    if (provider === ModelBackend.Ollama) {
      return res.json({
        supported: false,
        provider,
        model,
        reason: 'Ollama runs locally and imposes no provider rate limit.',
      } satisfies EmbeddingLimitsUnavailable);
    }

    // The dispatch below is a binary, so without this arm a fifth backend would be probed at
    // VoyageAI's endpoint with VoyageAI's key and the answer reported as its own ceiling.
    // resolveEmbeddingConfig switches exhaustively, so a new backend fails the build there; this
    // covers the runtime path that a non-exhaustive ternary leaves open.
    if (provider !== ModelBackend.OpenAI && provider !== ModelBackend.VoyageAI) {
      return res.json({
        supported: false,
        provider,
        model,
        reason: `Reading rate limits from ${provider} is not implemented.`,
      } satisfies EmbeddingLimitsUnavailable);
    }

    const isOpenAI = provider === ModelBackend.OpenAI;
    const url = isOpenAI ? 'https://api.openai.com/v1/embeddings' : 'https://api.voyageai.com/v1/embeddings';
    const apiKey = isOpenAI ? config.openaiApiKey : config.voyageApiKey;

    let probe: globalThis.Response;
    try {
      probe = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: PROBE_INPUT }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A failed probe is UNKNOWN, never "no limits" - reporting it as unsupported would let an
      // admin read a network blip as "this provider has no ceiling" and raise a lever on it.
      //
      // The provider error text is deliberately NOT echoed to either sink. A credential carrying an
      // interior control byte makes undici throw with the whole outbound header set inside its
      // message, so err.message can contain `Bearer <key>` in full - and the contract at the top of
      // this file is that no key material is ever returned. The error name plus the transport code
      // is what an operator actually needs, and neither can carry the header.
      const name = err instanceof Error ? err.name : 'UnknownError';
      const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
      logger?.warn(`[embedding-limits] probe to ${provider} failed: ${name}${code ? ` (${code})` : ''}`);
      return res.json({
        supported: false,
        provider,
        model,
        reason: `Could not reach ${provider}. This is unknown, not unlimited.`,
      } satisfies EmbeddingLimitsUnavailable);
    }

    const limits = parseEmbeddingRateLimitHeaders(probe.headers);

    // A 429 still carries the headers, and is in fact the most informative moment to read them,
    // so it is not treated as a failure. Any other non-OK status means the numbers cannot be
    // trusted to describe this account.
    if (!probe.ok && probe.status !== 429) {
      logger?.warn(`[embedding-limits] ${provider} returned ${probe.status}`);
      return res.json({
        supported: false,
        provider,
        model,
        reason: `${provider} returned HTTP ${probe.status} for the probe.`,
      } satisfies EmbeddingLimitsUnavailable);
    }

    if (!hasUsableLimits(limits)) {
      logger?.warn(`[embedding-limits] ${provider} responded without rate-limit headers`);
      return res.json({
        supported: false,
        provider,
        model,
        reason: `${provider} did not return rate-limit headers on this response.`,
      } satisfies EmbeddingLimitsUnavailable);
    }

    return res.json({
      supported: true,
      provider,
      model,
      limits,
      measuredAt: new Date().toISOString(),
    } satisfies EmbeddingLimitsAvailable);
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
