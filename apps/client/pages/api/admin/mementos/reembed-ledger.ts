import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope, MEMENTO_EMBEDDING_ID } from '@bike4mind/common';
import {
  MEMORY_PRINCIPAL_KINDS,
  memoryLedgerRepository,
  type MemoryPrincipalKind,
  type PrincipalCursor,
} from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { migrateLedgerVectorsForPrincipal } from '@server/memory/reembedMementos';

/**
 * Admin-only, dry-run-by-default repair for LEDGER vectors: backfills events written without one and
 * migrates ones in an older space, for every principal kind (see `migrateLedgerVectorsForPrincipal`).
 * The memento-side sibling is `reembed.ts`.
 *
 * Operator loop: POST `{ execute: true, after: nextAfter }` until `hasMore` is false. Paged by a
 * keyset cursor rather than reembed.ts's re-query-the-head scheme: the cursor only moves forward, so
 * a principal that can never be repaired is passed over instead of blocking everyone sorted after it,
 * and since it is keyed on values, repaired principals leaving the set cannot make the walk skip any.
 */
const BATCH_SIZE = 25;

// Same 60s-edge reasoning as reembed.ts's MAX_MEMENTOS_PER_REQUEST: one principal's chain is
// unbounded, so the ceiling is on provider calls, not principals.
const MAX_PROVIDER_CALLS_PER_REQUEST = 100;

// A diagnostic sample; `failed` carries the true count.
const MAX_REPORTED_EVENT_FAILURES = 50;

const bodySchema = z.object({
  execute: z.boolean().default(false),
  after: z
    .object({
      principalKind: z.enum(MEMORY_PRINCIPAL_KINDS as [MemoryPrincipalKind, ...MemoryPrincipalKind[]]),
      principalId: z.string(),
      ownerUserId: z.string(),
    })
    // nullish, not optional: the first page's `nextAfter` is null and the loop feeds it straight back.
    .nullish(),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const execute = parsed.data.execute;
  const after = parsed.data.after ?? undefined;

  const totals = {
    total: 0,
    alreadyCurrent: 0,
    truncated: 0,
    reembedded: 0,
    backfilled: 0,
    noFact: 0,
    noProviderKey: 0,
    failed: 0,
  };
  const failedPrincipals: Array<PrincipalCursor & { error: string }> = [];
  const failedEvents: string[] = [];

  const page = await memoryLedgerRepository.listPrincipalsNeedingVectors(MEMENTO_EMBEDDING_ID, {
    after,
    limit: BATCH_SIZE,
  });

  let cursor: PrincipalCursor | undefined = after;
  let spent = 0;
  let cutShort = false;
  let processedPrincipals = 0;

  for (const target of page) {
    // A dry run makes no provider call (its counts are "would"), so the ceiling is inert there.
    if (execute && spent >= MAX_PROVIDER_CALLS_PER_REQUEST) {
      cutShort = true;
      break;
    }
    processedPrincipals += 1;
    const label = `${target.principalKind}:${target.principalId}`;
    const budget = MAX_PROVIDER_CALLS_PER_REQUEST - spent;
    try {
      const stats = await migrateLedgerVectorsForPrincipal(
        { principal: { kind: target.principalKind, id: target.principalId }, ownerUserId: target.ownerUserId },
        execute ? { limit: budget } : { dryRun: true }
      );
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += stats[key];
      if (execute) spent += stats.providerCalls;
      for (const error of stats.errors) {
        if (failedEvents.length >= MAX_REPORTED_EVENT_FAILURES) break;
        failedEvents.push(`${label} ${error}`);
      }

      if (stats.stoppedAtLimit) {
        // Made progress, or only had the page's leftover budget: resume this principal next call (with
        // a full budget) by leaving the cursor before it. Made none on a full budget (every provider
        // call failed): resuming would repeat the same failures forever, so pass it.
        if (stats.backfilled + stats.reembedded + stats.truncated > 0 || budget < MAX_PROVIDER_CALLS_PER_REQUEST) {
          cutShort = true;
          break;
        }
        failedPrincipals.push({
          ...target,
          error: `no progress within provider budget${stats.errors[0] ? `: ${stats.errors[0]}` : ''}`,
        });
      } else if (stats.noProviderKey > 0) {
        // Its embeds cost no budget, so the rest of the page still runs; listed so the operator knows
        // it stays on every walk until the owner's embedding service can be built.
        failedPrincipals.push({
          ...target,
          error: `embedding service unavailable for owner ${target.ownerUserId}: ${stats.embedderError ?? 'unknown error'}`,
        });
      }
    } catch (err) {
      failedPrincipals.push({ ...target, error: err instanceof Error ? err.message : String(err) });
    }
    cursor = target;
  }

  return res.json({
    processedPrincipals,
    dryRun: !execute,
    ...totals,
    failedPrincipals,
    failedEvents,
    hasMore: cutShort || page.length === BATCH_SIZE,
    nextAfter: cursor ?? null,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
