import { type AttachmentLakeAccess, type IUserDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { resolveRetrievalLakeScopeForUser } from '@server/dataLakes/resolveRetrievalLakeScope';
import type { Logger } from '@bike4mind/observability';

/**
 * The agent door's lake arms, as a lazy memo (parity with the chat door's `attachmentLakeAccess`).
 * Resolved through `resolveRetrievalLakeScopeForUser` since the executor has no `req`.
 *
 * Opted OUT of the privileged static-registry bypass (`staticRegistryBypass: false`): that widening
 * escalates registry reach from passages (semantic-search) to whole inlined documents, and the chat
 * attachment door structurally cannot follow it, so inheriting it here would ship the two
 * attachment doors disagreeing for exactly the caller class most likely to notice.
 *
 * Returns a THUNK, and the caller must keep it one: a handoff is a FRESH invocation (published to
 * the continuation queue, not an in-process resume), so laziness - not the memo - is what avoids
 * resolving on a wake that will not use it. Build one per invocation and never hoist it to module
 * scope, where it would survive warm-container reuse keyed on nothing and leak one user's lake
 * buckets into the next user's run.
 *
 * `resolveRetrievalLakeScopeForUser` has no fail-safe of its own (unlike the chat door's
 * `getAccessibleDataLakeAccess`), so the catch is load-bearing: an unhandled throw would fail the
 * whole run rather than degrading to ownership-only.
 */
export function createAttachmentLakeAccess(
  user: IUserDocument,
  logger: Logger
): () => Promise<AttachmentLakeAccess> {
  let memo: Promise<AttachmentLakeAccess> | undefined;

  return () =>
    (memo ??= (async (): Promise<AttachmentLakeAccess> => {
      try {
        const scope = await resolveRetrievalLakeScopeForUser(user, {
          logger,
          staticRegistryBypass: false,
        });
        const lakeMemberships = dataLakeService.lakeMembershipsFrom(scope.lakes);
        dataLakeService.warnIfManyLakeMemberships(lakeMemberships, logger, 'attachment-resolution:agent');
        return {
          lakeMemberships,
          dataLakeTags: scope.dataLakeTags,
          dataLakeTagPrefixes: scope.dataLakeTagPrefixes,
        };
      } catch (err) {
        // Degrade to today's ownership-only behaviour. Widening on error is never correct here,
        // and neither is failing the run.
        logger.warn('[AttachmentLakeAccess] Resolution failed; falling back to ownership-only', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {};
      }
    })());
}
