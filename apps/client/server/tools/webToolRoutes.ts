import type { Request } from 'express';
import {
  UrlBlockedError,
  type WeatherToolRequest,
  type WebFetchToolRequest,
  type WebSearchToolRequest,
  type WebToolResultResponse,
} from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { RefusedFetchTargetError, webFetchBody } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { billedWebFetch, billedWebSearch } from '@bike4mind/server-utils/billing/billedWebTools';
import { resolveRequestUsageSource } from '@bike4mind/server-utils/utils/resolveRequestUsageSource';
import { runAuditedTool } from '@server/cli/runAuditedTool';

/**
 * The web search, web fetch and weather tools behind both doors: the SPA-internal /api/tools/* routes
 * (voice modal, desktop app) and the public /api/v1/tools/* contracts. Each door runs its own auth,
 * scope gate, outboundActionGate and toolRoutesRateLimit ahead of these; this module is the execution,
 * audit record and billing, so the doors cannot answer the same body differently.
 */

/** Each search is billed per call (billedWebSearch): a 422 insufficient_credits before the provider is called. */
export function runWebSearchTool(req: Request, body: WebSearchToolRequest): Promise<WebToolResultResponse> {
  return runAuditedTool('web_search', req.user!.id, req.logger, async () => {
    // billedWebSearch runs performWebSearch, so this honors the configured provider (SerpAPI or local
    // SearXNG) and its not-configured messaging, same as the tool.
    const { formattedResults } = await billedWebSearch(
      { caller: req, source: resolveRequestUsageSource(req) },
      { query: body.query, num_results: body.num_results }
    );
    return { result: formattedResults };
  });
}

/** Billed like runWebSearchTool. A refused target is the caller's input, so it is a 400, not a 500. */
export function runWebFetchTool(req: Request, body: WebFetchToolRequest): Promise<WebToolResultResponse> {
  return runAuditedTool('web_fetch', req.user!.id, req.logger, async () => {
    const { url, offset } = body;

    // Host only: never the path or query, which can carry secrets.
    const host = new URL(url).hostname;
    const logOutcome = (outcome: 'ok' | 'refused' | 'error') =>
      req.logger.withMetadata({ host, outcome }).info('web-fetch');

    // Frontend Lambda has a 60s timeout. Cap Firecrawl below it AND reserve headroom for the
    // llms.txt probe (up to LLMS_TXT_PROBE_TIMEOUT_MS, awaited after the scrape on a truncated
    // first read) plus response serialization, so a slow-but-successful fetch cannot tip over 60s.
    const result = await billedWebFetch(
      { caller: req, source: resolveRequestUsageSource(req) },
      { url, offset, maxTimeoutMs: 52_000 }
    ).catch((error: unknown) => {
      if (error instanceof RefusedFetchTargetError) {
        logOutcome('refused');
        throw new UrlBlockedError(error.message);
      }
      logOutcome('error');
      throw error;
    });

    logOutcome('ok');
    const content = webFetchBody(result);
    return { result: result.title ? `# ${result.title}\n\n${content}` : content };
  });
}

const WEATHER_TIMEOUT_MS = 10_000;

/** Not billed. A missing OpenWeather key or a provider failure is a 500. */
export function runWeatherTool(req: Request, body: WeatherToolRequest): Promise<WebToolResultResponse> {
  return runAuditedTool('weather_info', req.user!.id, req.logger, async () => {
    const { lat, lon, units = 'imperial' } = body;

    const openWeatherKey = await apiKeyService.getOpenWeatherKey({
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    });
    if (!openWeatherKey) {
      throw new Error('OpenWeather API key is not configured.');
    }

    let response: Response;
    try {
      response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${openWeatherKey}&units=${units}`,
        { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) }
      );
    } catch (fetchError) {
      if (fetchError instanceof Error && (fetchError.name === 'TimeoutError' || fetchError.name === 'AbortError')) {
        throw new Error(`Weather API request timed out after ${WEATHER_TIMEOUT_MS / 1000}s`);
      }
      throw fetchError;
    }

    if (!response.ok) {
      throw new Error(`OpenWeather error: ${response.statusText}`);
    }

    const data = await response.json();
    const temp = data?.main?.temp;
    const cityName = data?.name;
    const description = data?.weather?.[0]?.description;

    return { result: `Right now it's ${temp}\u00b0 in ${cityName}, with ${description}.` };
  });
}
