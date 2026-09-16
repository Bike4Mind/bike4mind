import { USE_DOCUMENTDB } from './documentdb-compat';

/**
 * Which ANN retrieval backend a deployment can use for Data Lake vector search.
 * - `atlas`: MongoDB Atlas, indexed automatically by `mongot` - can use `$vectorSearch`.
 * - `documentdb`: AWS DocumentDB - no Atlas Search, no `$vectorSearch`; permanent brute-force fallback.
 * - `community`: self-host on community MongoDB - no `$vectorSearch` unless the optional
 *   self-host OpenSearch container is wired up (see `selfHostOpenSearchEnabled`); brute-force
 *   fallback otherwise.
 */
export enum VectorBackend {
  ATLAS = 'atlas',
  DOCUMENTDB = 'documentdb',
  COMMUNITY = 'community',
}

/**
 * Precedence mirrors the other backend-detection helpers in this module: DocumentDB compat mode
 * wins first (it is the deployment's Mongo wire-protocol target), then self-host, else Atlas is
 * assumed - every hosted stage runs on Atlas.
 */
export const getVectorBackend = (): VectorBackend => {
  if (USE_DOCUMENTDB()) return VectorBackend.DOCUMENTDB;
  if (process.env.B4M_SELF_HOST === 'true') return VectorBackend.COMMUNITY;
  return VectorBackend.ATLAS;
};

export const supportsAtlasVectorSearch = (): boolean => getVectorBackend() === VectorBackend.ATLAS;

/**
 * Whether a self-host deployment has an OpenSearch container wired up for ANN retrieval.
 * `B4M_SELF_HOST=true` alone does not imply the container exists - it must be opted into
 * separately, and `OPENSEARCH_ENDPOINT` must actually be set for there to be somewhere to query.
 */
export const selfHostOpenSearchEnabled = (): boolean =>
  getVectorBackend() === VectorBackend.COMMUNITY &&
  process.env.B4M_SELF_HOST_OPENSEARCH === 'true' &&
  !!process.env.OPENSEARCH_ENDPOINT;

/**
 * Whether the self-host OpenSearch ANN path must confirm a file's chunks are actually resident
 * in the index before serving it from there, rather than the pre-residency behavior of trusting
 * the Mongo-side vectorization stamp alone. Defaults OFF: a deployment that already has
 * `B4M_SELF_HOST_OPENSEARCH` on and a fully-indexed corpus wrote every one of those chunks before
 * `retrievalIndexConfirmedModel` existed, so gating on it by default would silently revert that
 * corpus's whole ANN path to brute-force scan on upgrade, with no route back short of a full
 * re-chunk (see SELF_HOST.md). Turn this on only after re-chunking the corpus under this version
 * (re-upload, or POST /api/files/reprocess), so every stamped file's residency claim is real.
 */
export const selfHostOpenSearchResidencyRequired = (): boolean =>
  process.env.B4M_SELF_HOST_OPENSEARCH_REQUIRE_RESIDENCY === 'true';
