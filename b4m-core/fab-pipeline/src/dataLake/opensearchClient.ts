import { Logger } from '@bike4mind/observability';
import { Client } from '@opensearch-project/opensearch';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';
import { withRetry } from './retry';

/** Per-request timeout (ms) so a stalled OpenSearch call fails fast instead of hanging. */
const OPENSEARCH_REQUEST_TIMEOUT_MS = 30_000;

// Bounded exponential-backoff retry policy for transient OpenSearch failures. The bounds
// (and the jitter in `withRetry`) are deliberately conservative: this client is called
// concurrently per document (see BaseSearchIndex.processInParallel), so during a real
// cluster-pressure event every worker retries at once. Backoff + jitter spread that load
// out instead of amplifying it, and polaris-side backpressure remains the primary throttle.
const OPENSEARCH_RETRY_MAX_RETRIES = 5;
const OPENSEARCH_RETRY_INITIAL_DELAY_MS = 200;
const OPENSEARCH_RETRY_MAX_DELAY_MS = 10_000;

/**
 * Whether an OpenSearch failure is transient and worth retrying with backoff:
 * - `429` - rate limiting / circuit breaker (`circuit_breaking_exception`)
 * - `502` / `503` / `504` - service unavailable / gateway errors
 * - connection / timeout / no-living-connections errors (opensearch-js named error classes)
 *
 * Non-transient failures (4xx validation/mapping errors, intentional `RequestAbortedError`)
 * are NOT retried - retrying them just wastes attempts and re-pressures the cluster.
 */
export function isTransientOpenSearchError(error: Error): boolean {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }

  // Connection-level failures surface as named error classes from opensearch-js.
  if (['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'].includes(error.name)) {
    return true;
  }

  // Circuit breaker / unavailable connections can also surface only in the message.
  const message = error.message?.toLowerCase() ?? '';
  return message.includes('circuit_breaking_exception') || message.includes('no living connections');
}

/**
 * Extract a `Retry-After` delay (ms) from an opensearch-js `ResponseError`, if the cluster
 * sent one. opensearch-js exposes response headers on `error.headers` (and `error.meta.headers`).
 * `Retry-After` is either a number of seconds or an HTTP date. Returns null when absent/unparseable.
 */
export function getOpenSearchRetryAfterMs(error: Error): number | null {
  const e = error as { headers?: Record<string, unknown>; meta?: { headers?: Record<string, unknown> } };
  const raw = e.headers?.['retry-after'] ?? e.meta?.headers?.['retry-after'];
  if (raw == null) {
    return null;
  }

  const seconds = parseInt(String(raw), 10);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(String(raw));
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

export class OpenSearchClient {
  /**
   * The underlying opensearch-js client. Public on purpose: consumers (e.g. polaris) use it
   * directly for read/search operations this class does not wrap. NOTE: calls made through
   * this field bypass the retry/backoff in the wrapper methods below - prefer the wrapped
   * methods (`indexDocument`, `indexExists`, ...) for writes, and only reach in for reads.
   */
  public client: Client;

  /**
   * `selfHosted: true` builds a plain client for a docker-compose self-host container reachable
   * over HTTP with security disabled (see compose.selfhost.yaml) - it has no AWS endpoint to
   * sign requests against, unlike the managed AWS OpenSearch Service the default path targets.
   */
  constructor(endpoint: string, options?: { selfHosted?: boolean }) {
    this.client = options?.selfHosted
      ? new Client({
          node: `http://${endpoint}`,
          requestTimeout: OPENSEARCH_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
        })
      : new Client({
          ...AwsSigv4Signer({
            region: 'us-east-2',
            service: 'es',
            getCredentials: () => {
              const credentialsProvider = defaultProvider();
              return credentialsProvider();
            },
          }),
          node: `https://${endpoint}`,
          requestTimeout: OPENSEARCH_REQUEST_TIMEOUT_MS,
          // Disable the client's built-in retry - it does not retry 429 and skips non-idempotent
          // writes, so it gives a pressured cluster no relief. We own retry via `withRetry` below.
          maxRetries: 0,
        });
  }

  /**
   * Wrap an OpenSearch call with bounded exponential backoff on transient `429`/`503` and
   * connection errors, so a pressured cluster (e.g. tripped circuit breaker) gets relief
   * instead of an immediate failure on the first response.
   */
  private withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      isRetryable: isTransientOpenSearchError,
      getRetryAfterMs: getOpenSearchRetryAfterMs,
      maxRetries: OPENSEARCH_RETRY_MAX_RETRIES,
      initialDelayMs: OPENSEARCH_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: OPENSEARCH_RETRY_MAX_DELAY_MS,
      logger: {
        warn: (msg, meta) => Logger.globalInstance.warn(`[OpenSearchClient] ${msg}`, meta ?? ''),
      },
    });
  }

  async createIndex(indexName: string, settings: Record<string, any>) {
    Logger.globalInstance.log('creating index', indexName, settings);
    await this.withRetry(() =>
      this.client.indices.create({
        index: indexName,
        body: {
          // knn:true is the baseline every vector index needs; merge in any caller-provided
          // index-level settings (e.g. knn.algo_param.ef_search) instead of discarding them.
          settings: { knn: true, ...settings.settings },
          mappings: settings.mappings,
        },
      })
    );
  }

  async indexExists(indexName: string): Promise<boolean> {
    const response = await this.withRetry(() => this.client.indices.exists({ index: indexName }));
    return response.body;
  }

  /**
   * k-NN vector search. `filter` restricts candidates to a subset (e.g. fabFileId/embeddingModel)
   * BEFORE k-NN ranks them - it must sit inside the `knn` clause itself (OpenSearch's lucene-
   * engine efficient filtering), not as a separate post-filter stage. A per-model index is
   * shared across every file using that model, so a caller scoped to a handful of files needs
   * the filter applied during the HNSW/exact traversal, not after a global top-k pass - a
   * post-filter would rank the whole index first and could return zero in-scope hits even when
   * the caller's files ARE indexed, since their chunks may not make the global top-k.
   */
  async knnQuery(
    indexName: string,
    vector: number[],
    k: number,
    filter?: Record<string, any>
  ): Promise<Array<{ id: string; score: number; source: Record<string, any> }>> {
    const query = { knn: { vector: filter ? { vector, k, filter } : { vector, k } } };
    const response = await this.withRetry(() =>
      this.client.search({
        index: indexName,
        body: { size: k, query },
      })
    );
    return response.body.hits.hits.map((hit: { _id: string; _score: number; _source: Record<string, any> }) => ({
      id: hit._id,
      score: hit._score,
      source: hit._source,
    }));
  }

  async deleteIndex(indexName: string) {
    await this.withRetry(() => this.client.indices.delete({ index: indexName }));
  }

  async indexDocument<T extends { id: string }>(indexName: string, document: T) {
    await this.withRetry(() => this.client.index({ index: indexName, id: document.id, body: document }));
  }

  async updateDocument<T extends { id: string }>(indexName: string, document: Partial<T> & { id: string }) {
    await this.withRetry(() => this.client.update({ index: indexName, id: document.id, body: document }));
  }

  async upsertDocument<T extends { id: string }>(indexName: string, document: T) {
    await this.withRetry(() =>
      this.client.update({ index: indexName, id: document.id, body: { doc: document, doc_as_upsert: true } })
    );
  }

  async deleteDocument(indexName: string, id: string) {
    await this.withRetry(() => this.client.delete({ index: indexName, id: id }));
  }

  async deleteDocumentByQuery(indexName: string, query: any) {
    await this.withRetry(() => this.client.deleteByQuery({ index: indexName, body: query }));
  }

  async createSearchPipeline(pipelineName: string, pipelineConfig: any) {
    await this.withRetry(() =>
      this.client.transport.request({
        method: 'PUT',
        path: `/_search/pipeline/${pipelineName}`,
        body: pipelineConfig,
      })
    );
  }

  async deleteSearchPipeline(pipelineName: string) {
    await this.withRetry(() =>
      this.client.transport.request({
        method: 'DELETE',
        path: `/_search/pipeline/${pipelineName}`,
      })
    );
  }

  async getSearchPipeline(pipelineName?: string) {
    const path = pipelineName ? `/_search/pipeline/${pipelineName}` : '/_search/pipeline';
    const response = await this.withRetry(() =>
      this.client.transport.request({
        method: 'GET',
        path,
      })
    );
    return response.body;
  }

  async close() {
    await this.client.close();
  }
}
