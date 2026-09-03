import { isObjectIdOrHexString } from 'mongoose';
import type { ILogger } from '@bike4mind/observability';

/** The session id arrays that reference ObjectId-keyed collections. Excludes artifactIds. */
export type ObjectIdArrayKind = 'knowledge' | 'tool' | 'agent';

/**
 * The subset of a session id array that can actually address a row by `_id`.
 *
 * `knowledgeIds`, `toolIds` and `agentIds` are declared `[{ type: String }]` on SessionModel, but
 * the collections they reference are ObjectId-keyed. A single non-castable entry makes Mongoose
 * reject the whole `$in` with a CastError - losing every other id in the call, not just the bad
 * one. (`artifactIds` is deliberately not covered: those are `artifact_<ts>_<rand>` and are matched
 * on a string `id` field.)
 *
 * Dropped rather than rejected, because callers routinely resubmit a STORED list: renaming a
 * notebook PUTs `{ ...session, name }`, tagging PUTs `{ ...session, tags }`, and `/api/ai/llm`
 * forwards client `fabFileIds` straight into session creation. Rejecting would make a notebook
 * holding a legacy entry impossible to rename, tag or attach to - a worse dead end than the
 * export failure this exists to prevent.
 *
 * `isObjectIdOrHexString`, not `isValidObjectId`: for string input the two agree, but the latter
 * also accepts a number and casts it to a fabricated id matching no stored row. See
 * FabFileModel.objectIdCasting.integration.test.ts, which pins both against a real server.
 *
 * The logger is required: an omitted one is how a drop turns silent, and a silently incomplete
 * result is the failure this is meant to replace, not reproduce.
 */
export const usableObjectIds = (ids: string[], kind: ObjectIdArrayKind, logger: Pick<ILogger, 'warn'>): string[] => {
  const usable = ids.filter(id => isObjectIdOrHexString(id));
  if (usable.length !== ids.length) {
    logger.warn(`Skipping ${kind} ids that cannot address a row by _id`, {
      skipped: ids.filter(id => !isObjectIdOrHexString(id)),
    });
  }
  return usable;
};
