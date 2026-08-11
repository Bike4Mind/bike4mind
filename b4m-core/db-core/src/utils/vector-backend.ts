import { USE_DOCUMENTDB } from './documentdb-compat';

/**
 * Which ANN retrieval backend a deployment can use for Data Lake vector search.
 * - `atlas`: MongoDB Atlas, indexed automatically by `mongot` - can use `$vectorSearch`.
 * - `documentdb`: AWS DocumentDB - no Atlas Search, no `$vectorSearch`; permanent brute-force fallback.
 * - `community`: self-host on community MongoDB - no `$vectorSearch` unless the optional
 *   self-host OpenSearch container is wired up (tracked separately); brute-force fallback otherwise.
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
