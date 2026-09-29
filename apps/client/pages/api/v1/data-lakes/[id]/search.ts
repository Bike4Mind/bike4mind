/**
 * POST /api/v1/data-lakes/{id}/search - semantic search over ONE lake.
 *
 * The public twin of POST /api/data-lakes/semantic-search, sharing its core (runLakeSemanticSearch)
 * and its rate-limit bucket. What differs is the scope: the SPA searches every lake the caller can
 * retrieve from plus their own and shared files, while this searches only the target lake's
 * members. The scope is the retrieval resolver's own output NARROWED to the target lake, never a
 * scope built from the lake document, so a lake the caller can read but is not entitled to retrieve
 * from stays unsearchable here too. Auth mode, scopes and validation come from `searchDataLakeContract`.
 */
import { searchDataLakeContract, type DataLakeSearchResponse, type IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { adminSettingsRepository, dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { HTTPError, NotFoundError } from '@server/utils/errors';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { resolveRetrievalLakeScope, type RetrievalLakeScope } from '@server/dataLakes/resolveRetrievalLakeScope';
import { runLakeSemanticSearch } from '@server/dataLakes/runLakeSemanticSearch';
import { SEMANTIC_SEARCH_RATE_LIMIT } from '@server/dataLakes/semanticSearchRateLimit';
import { resolveDefaultEmbeddingModel } from '@server/utils/resolveDefaultEmbeddingModel';

/**
 * The caller's retrieval scope cut down to the one lake, or null when that lake is not in it.
 * `narrowLakeAccessToSession` returns the scope UNCHANGED when the tag names none of its lakes, so
 * the result is checked, not trusted: anything but exactly the target lake means it was not there.
 */
function scopeToLake(
  scope: RetrievalLakeScope,
  lake: Pick<IDataLakeDocument, 'datalakeTag'>
): RetrievalLakeScope | null {
  const narrowed = dataLakeService.narrowLakeAccessToSession(scope, [lake.datalakeTag]);
  const onlyTarget =
    narrowed.lakes.length > 0 &&
    narrowed.lakes.every(candidate => candidate.datalakeTag === lake.datalakeTag) &&
    narrowed.dataLakeTags.every(tag => tag === lake.datalakeTag);
  return onlyTarget ? narrowed : null;
}

const handler = nextRouteForContract(searchDataLakeContract, {
  rateLimit: rateLimit(SEMANTIC_SEARCH_RATE_LIMIT),
})
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const { query, top_k, min_score, tags } = req.validated;
    const ctx = await toAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(req.validatedParams.id, ctx, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        settings: adminSettingsRepository,
      },
      logger: req.logger,
    });

    const embeddingModel = await resolveDefaultEmbeddingModel(req.logger, 'v1-data-lake-search');

    // Same disconnect handling as the SPA route: `close` also fires on a normal end, so only a
    // close before the response was written counts as the caller leaving.
    let clientAborted = false;
    req.on('close', () => {
      if (!res.writableEnded) clientAborted = true;
    });

    const scope = scopeToLake(await resolveRetrievalLakeScope(req), lake);
    // Readable but not retrievable (e.g. an entitlement that grants the listing but not search):
    // the contract reports that as the same 404 as an invisible lake.
    if (!scope) throw new NotFoundError('Data lake not found');

    const outcome = await runLakeSemanticSearch(req, {
      query,
      topK: top_k,
      minScore: min_score,
      tags: tags ?? [],
      embeddingModel,
      embeddingModelExplicit: false,
      scope,
      restrictToDataLake: true,
      isAborted: () => clientAborted,
    });

    if (outcome.kind === 'aborted') return res.end();
    if (outcome.kind === 'provider_not_configured') {
      throw new HTTPError(503, outcome.message, { errorCode: 'provider_not_configured' });
    }

    const body: DataLakeSearchResponse =
      outcome.kind === 'empty'
        ? {
            results: [],
            embedding_model: outcome.embeddingModel,
            partial_results: false,
            retrieval_unavailable: { indexing_files: 0, paused_files: 0 },
          }
        : {
            results: outcome.search.results.map(result => ({
              chunk_id: result.chunkId,
              file_id: result.fileId,
              file_name: result.fileName,
              chunk_text: result.chunkText,
              score: result.score,
            })),
            embedding_model: outcome.search.embeddingModel,
            partial_results: dataLakeService.isPartialSearch(outcome.search),
            retrieval_unavailable: {
              indexing_files: outcome.search.retrievalUnavailable.indexing.count,
              paused_files: outcome.search.retrievalUnavailable.paused.count,
            },
          };
    return res.json(body);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
