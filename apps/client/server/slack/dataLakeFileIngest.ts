import { createHash } from 'node:crypto';
import {
  FabFileSourceType,
  KnowledgeType,
  type AccessContext,
  type IDataLakeDocument,
  type IDataLakeRepository,
  type IFabFileDocument,
} from '@bike4mind/common';
import { SLACK_MOCK_USER_ID, validateSlackFileForIngest, type SlackAttachment } from '@bike4mind/slack';
import { dataLakeService } from '@bike4mind/services';

/**
 * FILE ingest bridge for `@datalake add` (M2).
 *
 * Ordering is the security property: the actor is authorized BEFORE a single byte is downloaded
 * or a FabFile row is created. The alternative shape - reuse the plain Slack attachment intake
 * (`CommandHandler.processSlackFiles`) and stamp the lake tag onto what it already created - was
 * rejected because that path creates the FabFile first, so every authorization failure would
 * leave behind a file the actor was never allowed to create.
 *
 * The lake write gate is the SAME one the web doors use (`assertLakeWriteAccess` ->
 * `canManageLake` = admin-or-creator, plus `assertCanWriteDataLakeTags` as defense in depth).
 * Slack gets no bypass: reading a lake in the web app does not let you write to it, and reaching
 * it from Slack must not change that.
 */

/** The resolved B4M user behind the Slack message. Never built from the Slack event body. */
export interface SlackIngestActor {
  id: string;
  isAdmin?: boolean;
  tags?: string[] | null;
  organizationId?: string;
  email?: string | null;
  emailVerified?: boolean | null;
}

/** Parameters for `fabFilesService.createFabFile`, narrowed to what this path supplies. */
export interface CreateLakeFileParams {
  fileName: string;
  mimeType: string;
  fileSize: number;
  type: KnowledgeType;
  content: Buffer;
  contentType: string;
  contentHash: string;
  tags: Array<{ name: string; strength: number }>;
  organizationId?: string;
  provenance: { sourceType: FabFileSourceType; sourceMetadata: Record<string, unknown> };
}

export interface SlackLakeIngestDeps {
  // `find` is required by the fallback tagger, the others by the write gate.
  dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug' | 'findByDatalakeTag' | 'find'>;
  fabFiles: {
    findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  };
  /** Bound to the app's storage + db adapters by the caller so this module stays wiring-free. */
  createLakeFile(userId: string, params: CreateLakeFileParams): Promise<IFabFileDocument>;
  /** Entitlement keys for the actor; admins skip resolution, mirroring `toAccessContext`. */
  resolveEntitlementKeys(actor: SlackIngestActor): Promise<string[]>;
  downloadFile(url: string, fileName: string): Promise<Buffer>;
  logger: {
    info: (message: string, meta?: unknown) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, meta?: unknown) => void;
  };
}

export interface SlackLakeIngestParams {
  actor: SlackIngestActor;
  lakeSlug: string;
  files: SlackAttachment[];
  /** Slack origin recorded on every created file so a lake editor can audit where it came from. */
  channel: string;
  messageTs: string;
}

export type SlackLakeIngestRefusal =
  'unlinked_actor' | 'lake_not_found' | 'not_authorized' | 'lake_not_writable' | 'no_files';

export type SlackLakeIngestOutcome =
  | {
      ok: true;
      lakeName: string;
      /** File names newly created in the lake. */
      added: string[];
      /** File names already present in the lake (skip-not-replace, per the agreed spec). */
      duplicates: string[];
      /** User-facing reasons individual attachments were not ingested. */
      rejected: string[];
    }
  | { ok: false; reason: SlackLakeIngestRefusal; message: string };

/**
 * Build the management `AccessContext` server-side from the resolved user, mirroring
 * `server/dataLakes/toAccessContext.ts`. Identity and permissions come from the B4M user record,
 * never from the Slack payload, which is attacker-controlled for anyone who can post in a channel.
 */
export async function buildSlackAccessContext(
  actor: SlackIngestActor,
  deps: Pick<SlackLakeIngestDeps, 'resolveEntitlementKeys'>
): Promise<AccessContext> {
  const isAdmin = !!actor.isAdmin;
  return {
    userId: actor.id,
    isAdmin,
    userTags: actor.tags ?? [],
    organizationId: actor.organizationId,
    entitlementKeys: isAdmin ? [] : await deps.resolveEntitlementKeys(actor),
  };
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export async function ingestSlackFilesIntoLake(
  params: SlackLakeIngestParams,
  deps: SlackLakeIngestDeps
): Promise<SlackLakeIngestOutcome> {
  const { actor, lakeSlug, files, channel, messageTs } = params;

  // The SLACK_BYPASS_USER_LOOKUP stand-in corresponds to no real account, so no permission
  // decision about it is meaningful. Refused by identity rather than by reading the env var, so
  // a workspace that has the bypass switched on cannot write into anyone's lake.
  if (actor.id === SLACK_MOCK_USER_ID) {
    deps.logger.error('Refusing @datalake add for the SLACK_BYPASS_USER_LOOKUP mock user', { lakeSlug });
    return {
      ok: false,
      reason: 'unlinked_actor',
      message: 'This Slack workspace is running with user lookup bypassed, so files cannot be added to a data lake.',
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      reason: 'no_files',
      message: 'Attach a file to your message to add it to a data lake.',
    };
  }

  const ctx = await buildSlackAccessContext(actor, deps);

  // Authorization first: resolve + write-gate the lake before any download or create.
  let lake: IDataLakeDocument;
  try {
    lake = await dataLakeService.assertLakeWriteAccess(lakeSlug, ctx, { db: { dataLakes: deps.dataLakes } });
  } catch (err) {
    // assertLakeWriteAccess throws not-found when the lake is unreadable (deliberately no
    // existence leak) and a manage-denied error when it is readable but not the actor's to write.
    // Both are expected refusals, not failures, so they are mapped rather than rethrown.
    const message = err instanceof Error ? err.message : 'Data lake not found';
    const notFound = /not found/i.test(message);
    deps.logger.info('@datalake add refused by the lake write gate', { lakeSlug, message });
    return notFound
      ? {
          ok: false,
          reason: 'lake_not_found',
          message: `No Data Lake \`${lakeSlug}\` found. Use \`@datalake list\` to see the lakes you can add to.`,
        }
      : {
          ok: false,
          reason: 'not_authorized',
          message: `You can only add files to a data lake you created. Ask an admin, or the creator of \`${lakeSlug}\`.`,
        };
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
  // before an exact-match lookup, and nothing enforces that stored tags are lowercase (see the
  // same caveat on `assertMetaTagsMatchLake`), so a mixed-case tag resolves to no lake. A lake
  // soft-deleted between this gate and the one above lands here too.
  try {
    await dataLakeService.assertCanWriteDataLakeTags({ userId: ctx.userId, isAdmin: ctx.isAdmin }, [datalakeTag], {
      db: { dataLakes: deps.dataLakes },
    });
  } catch (err) {
    deps.logger.info('@datalake add refused by the meta-tag write gate', {
      lakeSlug,
      datalakeTag,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'not_authorized',
      message: `You can only add files to a data lake you created. Ask an admin, or the creator of \`${lakeSlug}\`.`,
    };
  }

  const rejected: string[] = [];
  // No `size` here on purpose - the authoritative length is the downloaded buffer's, below.
  const accepted: Array<{ fileName: string; mimeType: string; url: string }> = [];

  for (const file of files) {
    const validation = validateSlackFileForIngest(file);
    if (!validation.ok) {
      // Unlike the plain attachment path, an incomplete file is surfaced here too: silence after
      // an explicit "add this to the lake" would read as success.
      rejected.push(validation.message);
      continue;
    }
    accepted.push({
      fileName: validation.file.name,
      mimeType: validation.file.mimetype,
      url: validation.file.url_private_download,
    });
  }

  if (accepted.length === 0) {
    return {
      ok: true,
      lakeName: lake.name,
      added: [],
      duplicates: [],
      rejected,
    };
  }

  // A lake meta-tag alone leaves the file outside the lake's content prefix, where tag counts and
  // the Explorer tree cannot see it; the fallback tagger stamps the `<prefix>uncategorized` tag.
  const tags = await dataLakeService.reconcileDataLakeFallbackTags([{ name: datalakeTag, strength: 1 }], {
    db: { dataLakes: deps.dataLakes },
    logger: deps.logger,
  });

  const added: string[] = [];
  const duplicates: string[] = [];
  // Hashes ingested from THIS message, so the same file attached twice is caught without a query.
  const seenHashes = new Set<string>();

  // One attachment start-to-finish per iteration: download, hash, dedup, create, then let the
  // buffer go. Collecting every download first would put the sum of all attachments (up to
  // SLACK_MAX_FILE_SIZE_BYTES each) in memory at once, which is what the plain attachment intake
  // avoids by processing serially - worth one dedup query per file to keep that property.
  for (const file of accepted) {
    let buffer: Buffer;
    try {
      buffer = await deps.downloadFile(file.url, file.fileName);
    } catch (err) {
      deps.logger.error('Failed to download a Slack attachment for data lake ingest', {
        fileName: file.fileName,
        error: err instanceof Error ? err.message : String(err),
      });
      rejected.push(`Could not download "${file.fileName}" from Slack.`);
      continue;
    }

    const hash = sha256(buffer);

    if (seenHashes.has(hash)) {
      duplicates.push(file.fileName);
      continue;
    }

    // Per-LAKE dedup (not the per-user check-duplicates path): the same bytes may legitimately
    // live in another lake, or in the actor's own files, without being a duplicate here.
    const existing = await deps.fabFiles.findByContentHashesInDataLake([hash], datalakeTag);
    if (existing.length > 0) {
      duplicates.push(file.fileName);
      continue;
    }

    try {
      await deps.createLakeFile(actor.id, {
        fileName: file.fileName,
        mimeType: file.mimeType,
        // The bytes in hand, not Slack's claimed `size`: this value becomes the S3 Content-Length
        // and the storage-limit charge, so a disagreeing metadata field must not win.
        fileSize: buffer.length,
        type: KnowledgeType.FILE,
        content: buffer,
        contentType: file.mimeType,
        contentHash: hash,
        tags,
        organizationId: actor.organizationId,
        provenance: {
          sourceType: FabFileSourceType.SLACK,
          sourceMetadata: { channel, messageTs },
        },
      });
      added.push(file.fileName);
      // Marked seen only on success: a failed create must not make an identical second attachment
      // report "already in the lake" when neither copy landed.
      seenHashes.add(hash);
    } catch (err) {
      // One bad file must not lose the others: report it and keep going.
      const message = err instanceof Error ? err.message : 'Unknown error';
      deps.logger.error('Failed to create a data lake FabFile from a Slack attachment', {
        fileName: file.fileName,
        lakeSlug,
        error: message,
      });
      rejected.push(`Could not add "${file.fileName}": ${message}`);
    }
  }

  return { ok: true, lakeName: lake.name, added, duplicates, rejected };
}
