import type { ModelIdAliasMap } from '@bike4mind/common';
import aliasFile from './modelIdAliases.json';

/**
 * The checked-in aggregator-join override map (spec sec 5.6). Lives here rather
 * than in the discovery service for the same reason the join itself lives in
 * `common`: `@bike4mind/services` cannot import `packages/database`, so the
 * driver loads the file and hands it to the aggregator sources.
 *
 * The wrapper carries the same `generatedAt` / `notice` header the other seeds
 * use; only `aliases` is the map itself.
 */
export interface ModelIdAliasFile {
  generatedAt: string;
  notice: string;
  aliases: ModelIdAliasMap;
}

export const modelIdAliasFile: ModelIdAliasFile = aliasFile;

/** Our model id -> the key each aggregator publishes it under. */
export const MODEL_ID_ALIASES: ModelIdAliasMap = aliasFile.aliases;
