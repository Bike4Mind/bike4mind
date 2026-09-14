import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeProposalRepository,
  dataLakeRepository,
  dataLakeResearchRunRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { apiKeyService, dataLakeResearchService, dataLakeService, resolveWebSearchProvider } from '@bike4mind/services';
import { getAvailableModels, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { fetchAndParseURL } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import type { ResearchRunTotals } from '@bike4mind/common';

/**
 * Binds one queued research run (#1682) to the real world and executes it: the admin-configured
 * search provider, the deployment's model catalog, the ordinary URL fetcher, and the acquisition
 * queue's producer seam.
 *
 * The loop itself lives in `dataLakeResearchService.executeResearchRun` and is pure - everything
 * environment-shaped is here, which is also why this is the only file that has to change when a
 * scheduler (v2) becomes the thing that enqueues a run.
 */

/** What the loop reports back, so the handler can log a one-line outcome. */
export interface ResearchRunOutcome {
  /** False when the run row was not claimable - an SQS redelivery of work already done. */
  claimed: boolean;
}

/**
 * The one place the extraction contract is honored. `proposeDataLakeContent` requires the
 * candidate's text to be what the INGESTION door would extract from the same URL, and for a URL the
 * ingestion door is `createFabFileByUrl`: it writes `fetchAndParseURL`'s `textContent` to storage
 * with that `mimeType`, and the chunker's `text/*` branch then sets `getExtractedText()` to exactly
 * those bytes. So passing `textContent` through verbatim - not a re-render, not a summary - is what
 * makes the two hashes comparable.
 *
 * The PDF arm is the documented exception. There `textContent` is the raw PDF buffer, and the
 * chunker extracts from it with a PDF parser, so hashing what we hold would fingerprint bytes the
 * door will never produce - a hash guaranteed to differ from the member it is compared against.
 * Sending no text is the honest answer: source-keyed dedup (the queue's PRIMARY key) is unaffected,
 * and the cost is that a declined PDF's tombstone can never be cleared by the page changing.
 */
async function fetchSourceForProposal(url: string, logger: Logger) {
  try {
    const { title, textContent, mimeType } = await fetchAndParseURL(url, { logger });
    const isExtractableText = typeof textContent === 'string' && mimeType.startsWith('text/');
    return { title, text: isExtractableText ? textContent : undefined };
  } catch (error) {
    // Fail-soft per candidate: a dead link, a 403 or an SSRF refusal costs this one source, never
    // the run. The loop counts it as `fetchFailed` so the total is visible on the run card.
    logger.info('[lakeResearch] could not fetch candidate source', { url, error });
    return null;
  }
}

/**
 * Execute one queued run end to end. Idempotent at the claim: a redelivery of a run that already
 * ran finds it non-`queued` and returns `claimed: false` without spending anything.
 */
export async function runLakeResearch(
  runId: string,
  logger: Logger,
  options: { remainingTimeMs?: () => number } = {}
): Promise<ResearchRunOutcome> {
  const claimed = await dataLakeResearchRunRepository.claimForExecution(runId, new Date());
  if (!claimed) return { claimed: false };

  const settle = (input: Parameters<typeof dataLakeResearchRunRepository.settleRun>[1]) =>
    dataLakeResearchRunRepository.settleRun(runId, input);

  /**
   * The claim is a one-way door, so EVERY path from here on has to settle: a run left `running`
   * could never be re-claimed by a redelivery and would hold the one-at-a-time guard shut against
   * every later run on this lake. `failAndRethrow` is that guarantee for the faults, and each
   * settle-and-return below is it for the terminal operator facts.
   */
  const failAndRethrow = async (error: unknown, spent: number, totals: ResearchRunTotals): Promise<never> => {
    await settle({
      status: 'failed',
      completedAt: new Date(),
      spentMicroUsd: spent,
      totals,
      error: error instanceof Error ? error.message : 'The research run failed unexpectedly',
    });
    throw error;
  };

  // Deliberately NOT `.catch(() => null)`: a read fault is not an answer of "deleted". Swallowing it
  // would settle the run with a message naming a cause that did not happen, and record a database
  // outage as a benign user-facing outcome. The fault settles with its REAL message and rethrows, so
  // the queue's alarms see it.
  const lake = await dataLakeRepository
    .findById(claimed.dataLakeId)
    .catch(error => failAndRethrow(error, 0, claimed.totals));
  if (!lake) {
    // The lake genuinely went away between enqueue and execution. Terminal, not retryable.
    await settle({
      status: 'failed',
      completedAt: new Date(),
      spentMicroUsd: 0,
      totals: claimed.totals,
      error: 'The data lake this run targets no longer exists',
    });
    return { claimed: true };
  }

  const keyAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };

  // Mirrors what the loop last reported, so the `failed` settle below records the money actually
  // spent rather than zero. A run that dies after four judgments really did spend four judgments,
  // and reporting 0 would make the per-lake ceiling look untouched on the very run that proves it
  // is needed.
  let spentMicroUsd = 0;
  let totals: ResearchRunTotals = claimed.totals;

  try {
    const provider = await resolveWebSearchProvider(keyAdapters);
    if (!provider) {
      // Not thrown: an unconfigured deployment is an operator fact, not a transient fault, and
      // throwing would burn three SQS deliveries and a DLQ entry on a message that can never
      // succeed. The message a lake manager reads names what an admin has to do.
      await settle({
        status: 'failed',
        completedAt: new Date(),
        spentMicroUsd: 0,
        totals: claimed.totals,
        error:
          'Web search is not configured. An administrator needs to set a Serper API key or a SearXNG URL in Admin > API Keys.',
      });
      return { claimed: true };
    }

    const apiKeyTable = (await apiKeyService.getEffectiveLLMApiKeys(
      // The lake's OWNER, not the user who pressed Run: the run spends against the lake, and a
      // scheduled v2 run has no human behind it at all.
      lake.createdByUserId,
      keyAdapters,
      { logger }
    )) as ApiKeyTable;
    const models = await getAvailableModels(apiKeyTable);
    const judgeService = new dataLakeResearchService.RelevanceJudgeService(logger);
    // Resolved once, against the live catalog: a config naming a model this deployment has since
    // retired falls back rather than failing the whole run.
    const configuredModel = claimed.levers.model;
    const model =
      configuredModel && models.some(m => m.id === configuredModel)
        ? configuredModel
        : dataLakeResearchService.RELEVANCE_JUDGE_DEFAULT_MODEL;
    if (configuredModel && model !== configuredModel) {
      logger.warn('[lakeResearch] configured judge model is unavailable; falling back', {
        runId,
        configuredModel,
        model,
      });
    }

    const ports: dataLakeResearchService.ResearchRunPorts = {
      search: async (query, maxResults, recencyDays) => {
        const hits = await provider.search(query, maxResults, { recencyDays });
        return hits.map(hit => ({ title: hit.title, url: hit.url, snippet: hit.snippet }));
      },
      judge: candidate =>
        judgeService.judge({
          apiKeyTable,
          models,
          model,
          question: claimed.levers.query,
          title: candidate.title,
          url: candidate.url,
          snippet: candidate.snippet,
          endUserId: lake.createdByUserId,
        }),
      fetchSource: url => fetchSourceForProposal(url, logger),
      propose: candidate =>
        dataLakeService.proposeDataLakeContent(lake, candidate, {
          db: { dataLakeProposals: dataLakeProposalRepository, fabFiles: fabFileRepository },
        }),
      // Best-effort: a failed progress write must not end a run that is otherwise working - the
      // settle at the end writes the authoritative totals either way. Logged rather than dropped, so
      // "the card never moved" can be told apart from "the card never got written".
      onProgress: (spent, running) => {
        spentMicroUsd = spent;
        totals = running;
        return dataLakeResearchRunRepository
          .recordProgress(runId, spent, running)
          .catch(error => logger.warn('[lakeResearch] progress write failed; run continues', { runId, error }));
      },
      now: () => new Date(),
      remainingTimeMs: options.remainingTimeMs,
    };

    const result = await dataLakeResearchService.executeResearchRun(claimed.levers, runId, ports);

    await settle({
      status: 'completed',
      completedAt: new Date(),
      stopReason: result.stopReason,
      spentMicroUsd: result.spentMicroUsd,
      totals: result.totals,
    });
    logger.log('[lakeResearch] run finished', { runId, stopReason: result.stopReason, ...result.totals });
    return { claimed: true };
  } catch (error) {
    // The spend and totals the loop last reported, not zero - see `spentMicroUsd` above.
    return failAndRethrow(error, spentMicroUsd, totals);
  }
}
