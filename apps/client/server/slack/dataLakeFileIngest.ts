import { createHash } from 'node:crypto';
import { FabFileSourceType, KnowledgeType, type IFabFileDocument } from '@bike4mind/common';
import { validateSlackFileForIngest, type SlackAttachment } from '@bike4mind/slack';
import {
  authorizeLakeForWrite,
  refuseMockActor,
  resolveLakeTags,
  type LakeAuthzDeps,
  type LakeWriteRefusalReason,
  type SlackIngestActor,
} from './dataLakeIngestAuthz';

/**
 * FILE ingest bridge for `@datalake add` (M2).
 *
 * The authorize-first prologue - mock-actor refusal, server-built AccessContext, lake resolution,
 * the write gate, the status check and the meta-tag gate - lives in `dataLakeIngestAuthz.ts` and is
 * shared with LINK ingest. The alternative shape for this path - reuse the plain Slack attachment
 * intake (`CommandHandler.processSlackFiles`) and stamp the lake tag onto what it already created -
 * was rejected because that path creates the FabFile first, so every authorization failure would
 * leave behind a file the actor was never allowed to create.
 *
 * KNOWN GAP - per-lake dedup has a short blind window. `createFabFile` leaves `status` at its
 * `pending` default and `findByContentHashesInDataLake` filters `status: { $ne: 'pending' }`, so
 * the same bytes re-added in a SECOND message before the S3 ObjectCreated event completes the
 * first copy will land twice. In-message dedup (`seenHashes`) is unaffected. Skip-not-replace
 * semantics mean the worst case is a duplicate row, not data loss; nothing enforces uniqueness at
 * the index level either, so a genuinely concurrent pair can race the same way.
 */

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
  // No organizationId: FabFileSchema does not declare it (nor does the spread
  // ShareableDocumentSchema), so strict mode drops it on save - the same silent-drop this PR fixes
  // for sourceType. It could not reach the storage check either, since this path supplies no
  // db.organizations adapter and checkStorageLimitForFile then falls back to the user limit.
  // The web data-lake batch door does not set it either. Declaring the field is a repo-wide call.
  provenance: { sourceType: FabFileSourceType; sourceMetadata: Record<string, unknown> };
  /**
   * The orgs the actor administers, forwarded to `createFabFile`'s OWN tag gate - a THIRD manage
   * check after this path's two, running inside the file create. It cannot derive the value from the
   * user document (`create.ts:132-137` spells this out), so an omitted field silently zeroes the org
   * rungs and refuses "a write the route's own manage gate just authorized" - which is exactly what
   * happened here: `add` passed both prologue gates and then failed with "You do not have permission
   * to change this data lake's files".
   *
   * REQUIRED, not optional: this path admits content into someone else's lake, so it is precisely the
   * door that must pass it. Taken from the AUTHORIZED context rather than re-resolved, so the value
   * that granted the write is the value the create re-checks against.
   */
  administeredOrgIds: string[];
}

export interface SlackLakeIngestDeps extends LakeAuthzDeps {
  fabFiles: {
    findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  };
  /** Bound to the app's storage + db adapters by the caller so this module stays wiring-free. */
  createLakeFile(userId: string, params: CreateLakeFileParams): Promise<IFabFileDocument>;
  downloadFile(url: string, fileName: string): Promise<Buffer>;
  /**
   * The `MaxFileSize` admin setting in bytes, so an over-limit file is refused BEFORE it is
   * downloaded. Optional: omitted, the Slack ceiling alone applies and createFabFile still
   * enforces the real limit after transfer.
   */
  resolveMaxFileSizeBytes?: () => Promise<number | undefined>;
}

export interface SlackLakeIngestParams {
  actor: SlackIngestActor;
  lakeSlug: string;
  files: SlackAttachment[];
  /** Slack origin recorded on every created file so a lake editor can audit where it came from. */
  channel: string;
  messageTs: string;
}

export type SlackLakeIngestRefusal = LakeWriteRefusalReason | 'no_files';

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

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export async function ingestSlackFilesIntoLake(
  params: SlackLakeIngestParams,
  deps: SlackLakeIngestDeps
): Promise<SlackLakeIngestOutcome> {
  const { actor, lakeSlug, files, channel, messageTs } = params;

  const mockRefusal = refuseMockActor(actor, lakeSlug, deps);
  if (mockRefusal) return mockRefusal;

  // Before authorization on purpose, and unchanged from M2: nothing to authorize against yet, and
  // this ordering is pinned by tests asserting no download or create happens on any refusal.
  if (files.length === 0) {
    return {
      ok: false,
      reason: 'no_files',
      message: 'Attach a file to your message to add it to a data lake.',
    };
  }

  // Authorization first: resolve + write-gate the lake before any download or create.
  const authorized = await authorizeLakeForWrite(actor, lakeSlug, deps);
  if (!authorized.ok) return authorized;
  const { lake, datalakeTag, ctx } = authorized;

  const rejected: string[] = [];
  // No `size` here on purpose - the authoritative length is the downloaded buffer's, below.
  const accepted: Array<{ fileName: string; mimeType: string; url: string }> = [];

  // The Slack validator's 50MB ceiling is not the binding one: createFabFile enforces the
  // `MaxFileSize` admin setting AFTER the download, so without this an over-limit file is
  // transferred in full and then refused. That setting's schema default is 30MB (create.ts's
  // DEFAULT_MAX_FILE_SIZE of 20 applies only when the settings map has no entry at all).
  // Checked against Slack's claimed size, which is all we have pre-download; createFabFile still
  // re-checks the real buffer, so this only saves the wasted transfer.
  const maxFileSizeBytes = await deps.resolveMaxFileSizeBytes?.();

  for (const file of files) {
    const validation = validateSlackFileForIngest(file);
    if (!validation.ok) {
      // Unlike the plain attachment path, an incomplete file is surfaced here too: silence after
      // an explicit "add this to the lake" would read as success.
      rejected.push(validation.message);
      continue;
    }
    // `>=`, matching create.ts:120 exactly. With `>`, a file of precisely maxFileSizeBytes passed
    // here and was then refused after a full download - the one case the pre-check exists for.
    // Compared against undefined rather than truthiness so an admin-set 0 (refuse everything,
    // which is what create.ts does with it) is not read as "no limit".
    if (maxFileSizeBytes !== undefined && validation.file.size >= maxFileSizeBytes) {
      const limitMB = (maxFileSizeBytes / (1024 * 1024)).toFixed(0);
      const sizeMB = (validation.file.size / (1024 * 1024)).toFixed(1);
      rejected.push(`File "${validation.file.name}" (${sizeMB}MB) exceeds ${limitMB}MB limit.`);
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

  const tags = await resolveLakeTags(datalakeTag, deps);

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
        provenance: {
          sourceType: FabFileSourceType.SLACK,
          sourceMetadata: { channel, messageTs },
        },
        administeredOrgIds: ctx.administeredOrgIds ?? [],
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
