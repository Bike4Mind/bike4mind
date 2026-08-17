import {
  type AccessContext,
  type IDataLakeAccessGrantRepository,
  type IDataLakeDocument,
  type IDataLakeRepository,
} from '@bike4mind/common';
import { SLACK_MOCK_USER_ID } from '@bike4mind/slack';
import { dataLakeService } from '@bike4mind/services';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/**
 * The authorize-first prologue shared by both `@datalake add` ingest paths (FILE and LINK).
 *
 * Ordering is the security property: the actor is authorized BEFORE a single byte is downloaded or
 * fetched, and before any FabFile row is created. Extracted here rather than duplicated so the two
 * paths cannot drift - a gate that is correct for attachments and stale for links would be worse
 * than no sharing at all, and LINK ingest runs the identical resolve-gate-status-tag sequence.
 *
 * The gate is the SAME one the web doors use (`assertLakeWriteAccess` -> `canManageLake` =
 * admin-or-creator, plus `assertCanWriteDataLakeTags` as defense in depth). Slack gets no bypass:
 * reading a lake in the web app does not let you write to it, and reaching it from Slack must not
 * change that.
 */

/** The resolved B4M user behind the Slack message. Never built from the Slack event body. */
export interface SlackIngestActor {
  id: string;
  isAdmin?: boolean;
  tags?: string[] | null;
  email?: string | null;
  emailVerified?: boolean | null;
}

/** Refusals every ingest path can produce. Each path unions its own content-specific reasons. */
export type LakeWriteRefusalReason = 'unlinked_actor' | 'lake_not_found' | 'not_authorized' | 'lake_not_writable';

export interface LakeWriteRefusal {
  ok: false;
  reason: LakeWriteRefusalReason;
  message: string;
}

export interface LakeAuthzDeps {
  // `find` is required by the fallback tagger, the others by the write gate.
  dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug' | 'findByDatalakeTag' | 'find'>;
  /**
   * The lake's access grants, which `assertLakeWriteAccess` resolves so a CURATOR or a transferred
   * owner may ingest and not only the original creator. Declared on the shared prologue rather than
   * on one ingest path, so FILE and LINK cannot diverge on who is allowed to write - the same reason
   * this module exists at all.
   */
  dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  /** Entitlement keys for the actor; admins skip resolution, mirroring `toAccessContext`. */
  resolveEntitlementKeys(actor: SlackIngestActor): Promise<string[]>;
  /** Authoritative org membership set for the actor, mirroring `toAccessContext` (#1674). */
  resolveMembershipOrgIds(userId: string): Promise<string[]>;
  logger: {
    info: (message: string, meta?: unknown) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, meta?: unknown) => void;
  };
}

/**
 * Build the management `AccessContext` server-side from the resolved user, mirroring
 * `server/dataLakes/toAccessContext.ts`. Identity and permissions come from the B4M user record,
 * never from the Slack payload, which is attacker-controlled for anyone who can post in a channel.
 */
export async function buildSlackAccessContext(
  actor: SlackIngestActor,
  deps: Pick<LakeAuthzDeps, 'resolveEntitlementKeys' | 'resolveMembershipOrgIds'>
): Promise<AccessContext> {
  const isAdmin = !!actor.isAdmin;
  return {
    userId: actor.id,
    isAdmin,
    userTags: actor.tags ?? [],
    organizationIds: await deps.resolveMembershipOrgIds(actor.id),
    entitlementKeys: isAdmin ? [] : await deps.resolveEntitlementKeys(actor),
  };
}

/**
 * Refuse the `SLACK_BYPASS_USER_LOOKUP` stand-in, which corresponds to no real account, so no
 * permission decision about it is meaningful. Refused by identity rather than by reading the env
 * var, so a workspace that has the bypass switched on cannot write into anyone's lake.
 *
 * Returns null when the actor is a real user. Callers MUST run this before anything else.
 */
export function refuseMockActor(
  actor: SlackIngestActor,
  lakeSlug: string,
  deps: Pick<LakeAuthzDeps, 'logger'>
): LakeWriteRefusal | null {
  if (actor.id !== SLACK_MOCK_USER_ID) return null;

  deps.logger.error('Refusing @datalake add for the SLACK_BYPASS_USER_LOOKUP mock user', { lakeSlug });
  return {
    ok: false,
    reason: 'unlinked_actor',
    message: 'This Slack workspace is running with user lookup bypassed, so files cannot be added to a data lake.',
  };
}

export type LakeWriteAuthorization =
  { ok: true; lake: IDataLakeDocument; datalakeTag: string; ctx: AccessContext } | LakeWriteRefusal;

/**
 * Resolve the target lake and authorize the actor to write to it, returning the lake and the
 * meta-tag to stamp. No side effect is permitted before this succeeds.
 */
export async function authorizeLakeForWrite(
  actor: SlackIngestActor,
  lakeSlug: string,
  deps: LakeAuthzDeps
): Promise<LakeWriteAuthorization> {
  const ctx = await buildSlackAccessContext(actor, deps);

  let lake: IDataLakeDocument;
  try {
    lake = await dataLakeService.assertLakeWriteAccess(lakeSlug, ctx, {
      db: { dataLakes: deps.dataLakes, dataLakeAccessGrants: deps.dataLakeAccessGrants },
    });
  } catch (err) {
    // Branch on the error CLASS, not the message. Matching /not found/i sent two reachable cases
    // down the wrong arm: a built-in lake (BadRequestError "...built into the platform and is
    // read-only") was reported as "ask an admin", advice no admin can satisfy because built-in
    // lakes are read-only for everyone; and an unguarded `findBySlug` failure - a DB outage - was
    // reported to the user as a permission denial and logged at info instead of error.
    if (err instanceof NotFoundError) {
      deps.logger.info('@datalake add refused: lake not found or unreadable', { lakeSlug });
      return {
        ok: false,
        reason: 'lake_not_found',
        message: `No Data Lake \`${lakeSlug}\` found. Use \`@datalake list\` to see the lakes you can add to.`,
      };
    }

    if (err instanceof BadRequestError) {
      // Surface the thrown message: it distinguishes "built into the platform and is read-only"
      // from "only the creator can add files", which the generic sentence cannot.
      deps.logger.info('@datalake add refused by the lake write gate', { lakeSlug, message: err.message });
      return {
        ok: false,
        reason: 'not_authorized',
        message: `Cannot add to \`${lakeSlug}\`: ${err.message}`,
      };
    }

    // Anything else is a failure, not a refusal. Rethrow so the orchestrator's catch logs at
    // error and replies "something went wrong" rather than blaming the user's permissions.
    throw err;
  }

  // Same rule as the web upload doors: only a draft (first batch) or active lake takes new files,
  // so an archived/deleting one cannot be topped up through Slack either.
  if (lake.status !== 'draft' && lake.status !== 'active') {
    return {
      ok: false,
      reason: 'lake_not_writable',
      message: `*${lake.name}* is ${lake.status} and cannot take new files.`,
    };
  }

  const datalakeTag = lake.datalakeTag;

  // Defense in depth: the gate above authorized the lake, this one authorizes the meta-tag we are
  // about to apply. They agree today; keeping both means a future change to either cannot silently
  // open a write path (this is the check the web create/update doors also run).
  //
  // Mapped like the gate above rather than left to throw: this is a permission decision, and an
  // escaped throw would reach the orchestrator's catch and tell the user "something went wrong".
  // It is reachable even though `datalakeTag` is globally unique: the gate lowercases the tag
  // before an exact-match lookup (see the same caveat on `assertMetaTagsMatchLake`), so a
  // mixed-case stored tag resolves to no lake. `createDataLake` now lowercases the slug at the mint
  // point, so no NEW lake can land in that state - the residual exposure is lakes persisted before
  // that change. A lake soft-deleted between this gate and the one above lands here too.
  try {
    await dataLakeService.assertCanWriteDataLakeTags({ userId: ctx.userId, isAdmin: ctx.isAdmin }, [datalakeTag], {
      db: { dataLakes: deps.dataLakes },
    });
  } catch (err) {
    // Same class-based split as the gate above: only a refusal is reported as one, and anything
    // that is not a refusal is rethrown rather than blamed on the user's permissions.
    if (!(err instanceof NotFoundError) && !(err instanceof BadRequestError)) throw err;

    deps.logger.info('@datalake add refused by the meta-tag write gate', {
      lakeSlug,
      datalakeTag,
      message: err.message,
    });
    return {
      ok: false,
      reason: 'not_authorized',
      message: `You can only add files to a data lake you created. Ask an admin, or the creator of \`${lakeSlug}\`.`,
    };
  }

  return { ok: true, lake, datalakeTag, ctx };
}

/**
 * Stamp the lake meta-tag plus the content-prefix fallback tag. A meta-tag alone leaves the file
 * outside the lake's content prefix, where tag counts and the Explorer tree cannot see it.
 */
export async function resolveLakeTags(
  datalakeTag: string,
  deps: Pick<LakeAuthzDeps, 'dataLakes' | 'logger'>
): Promise<Array<{ name: string; strength: number }>> {
  return dataLakeService.reconcileDataLakeFallbackTags([{ name: datalakeTag, strength: 1 }], {
    db: { dataLakes: deps.dataLakes },
    logger: deps.logger,
  });
}
