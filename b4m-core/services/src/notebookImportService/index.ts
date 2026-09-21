/* eslint @typescript-eslint/no-explicit-any: "error" */
import {
  NotebookExportFormat,
  ExportedNotebook,
  ExportedChatMessage,
  ExportedKnowledgeFile,
  ExportedArtifact,
  ExportedTool,
  ExportedAgent,
  NotebookImportOptions,
  ImportResult,
  NotebookImportError,
  SUPPORTED_IMPORT_VERSIONS,
} from '../notebookExportService/types';
import {
  ArtifactTypeSchema,
  DefaultLLMParams,
  isValidEnumValue,
  KnowledgeType,
  remintArtifactId,
} from '@bike4mind/common';
import type { ArtifactType } from '@bike4mind/common';
import { MAX_FILE_SIZE_DEFAULT_MB } from '../fabFileService/create';
import { checkStorageLimit, getSettingsMap, getSettingsValue, normalizeId } from '@bike4mind/utils';
import type { IAdminSettingsRepository, IChatHistoryItem, IUserDocument } from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';

/** A notebook the import can address: found by name, or just created. */
interface NotebookRef {
  id: string;
  userId: string;
}

/**
 * The created document is the only source of truth for the id: these entities have no `id` schema
 * path, so one passed in is dropped on insert. `data` excludes `id` to keep it that way - passing
 * one is a compile error rather than a session full of references that resolve to nothing.
 *
 * `Record<string, unknown>` for the rest of the payload, not the entity shape: the payloads still
 * do not match the schemas behind them, and narrowing that is a separate behaviour change.
 *
 * The return type is what an implementation *should* hand back; `takeStoreId` covers what one
 * might actually hand back, since an adapter returning `toObject()` output carries no `id` virtual.
 */
interface AttachmentRepository {
  create: (data: Record<string, unknown> & { id?: never }) => Promise<{ id: unknown }>;
}

export interface NotebookImportAdapters {
  // Property syntax throughout, not method shorthand: methods are compared bivariantly, so an
  // implementation demanding a narrower argument than the service passes would still compile.
  sessionRepository: {
    /**
     * `id` is excluded deliberately: it is not a SessionSchema path, only Mongoose's getter-only
     * `_id` virtual, so `BaseRepository.create`'s `Omit<T, 'id' | ...>` was always right and a
     * passed id was always dropped. Excluding it here makes re-adding one a compile error.
     */
    create: (data: Record<string, unknown> & { id?: never }) => Promise<NotebookRef>;
    find: (query: { userId: string; name: string }) => Promise<NotebookRef[]>;
    /**
     * `null` CLEARS the stored field; `undefined` leaves it untouched. The distinction is not
     * stylistic: `BaseRepository.update` issues `$set`, and mongoose deletes every `undefined`
     * value from that payload - so an explicit `null` is the only way this port can express
     * "clear it". Every field the overwrite branch writes relies on this.
     */
    updateById: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  };
  /** Typed because the caller's implementation of these two carries the insert-never-upsert rule. */
  chatHistoryRepository: {
    bulkCreate: (items: IChatHistoryItem[]) => Promise<unknown>;
    deleteMany: (filter: { sessionId: string }) => Promise<unknown>;
  };
  knowledgeRepository: AttachmentRepository;
  /**
   * Whether ANY row already occupies this id - the artifact itself or one of the two documents
   * created alongside it, each of which has its own unique key. Only consulted for `preserveIds`,
   * where the id comes from the export rather than being minted, so it can already be taken.
   *
   * Deliberately not named `artifactExists`, which is what the same question is called in
   * apps/client/server/utils/persistAgentArtifacts.ts - there it means "an artifacts row exists"
   * and MUST stay that narrow, because that module tells a real collision apart from a repairable
   * orphan by exactly that difference. Two ports, one name, opposite safety properties.
   */
  artifactIdTaken: (id: string) => Promise<boolean>;
  /**
   * Not a bare repository, unlike the others: an artifact is three documents (body, version, then
   * the artifact pointing at both), and the required `contentId`/`contentHash`/`contentSize` can
   * only be derived while writing the body - so the caller wires the app's own creation path, which
   * also keeps those three writes inside the import's transaction.
   *
   * Returns the created row, not its id: `takeStoreId` takes the id from it, the same seam the
   * three sibling attachment kinds go through. Artifacts resolve by their own `id` rather than by
   * `_id`, and the caller cannot assume the id it passed was the one stored.
   */
  createArtifact: (params: {
    userId: string;
    /**
     * Always set by this service: either the preserved source id, or one minted by
     * `createArtifactId` that carries the source identifier segment across. Optional only because
     * the creation path behind this port mints its own when a caller omits it.
     */
    id?: string;
    /**
     * The notebook the artifact belongs to. Recorded on the artifact itself because that is what
     * the viewer reads back (`GET /api/artifacts?sessionId=`); `session.artifactIds` is a
     * denormalised copy that no display path consults. Omitting it imported artifacts that
     * existed but were unreachable, so the notebook opened empty.
     */
    sessionId: string;
    type: ArtifactType;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: unknown }>;
  toolRepository: AttachmentRepository;
  agentRepository: AttachmentRepository;
  fileStorageService: {
    uploadFile: (path: string, content: Buffer) => Promise<unknown>;
  };
  /**
   * Resolved once per import: existence is checked up front, and that same document then feeds the
   * per-user storage quota on every knowledge file (`storageLimit`/`currentStorageSize` only).
   * Deliberately still `unknown` - narrowing happens at that one point of use, so this port does
   * not have to promise the app's own User document matches `IUserDocument` structurally.
   */
  userRepository: {
    findById: (id: string) => Promise<unknown>;
  };
  /**
   * Read once per import to resolve `MaxFileSize`. Required, not optional: this is the same admin
   * setting the upload door (fabFileService/create.ts) gates on, and a caller that could omit it
   * would silently admit files that door refuses.
   */
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
  logger: ILogger;
  generateId: () => string;
}

/** Unknown or absent types degrade to FILE: the store enum-validates this, so a value it does not
 * know would otherwise fail the write and lose the file. */
function toKnowledgeType(raw: string | undefined): KnowledgeType {
  return raw && isValidEnumValue(raw, KnowledgeType) ? raw : KnowledgeType.FILE;
}

/** Refused rather than degraded, unlike knowledge above: the type picks the mime type and the
 * renderer, so there is no value that stands in for an unknown one. */
function toArtifactType(raw: string): ArtifactType {
  const parsed = ArtifactTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`unrecognised artifact type "${raw}"`);
  }
  return parsed.data;
}

// Declared here rather than imported: `types.ts` is re-exported wholesale from the package entry
// point, so exporting it there would put a one-word generic name in this package's public API.
type Expect<T extends true> = T;

/**
 * Fails typecheck if a whole slot is re-loosened to `any` - every one of them used to be. Lives in
 * src, not a test: tsconfig excludes *.test.ts, so only `turbo:typecheck` enforces it. Sibling
 * guard: notebookExportService's NotebookExportTypesStayNarrowed.
 *
 * It only sees the slot type, so a nested `any` (say a method parameter) slips past it. The
 * file-level `no-explicit-any: error` at the top covers that case; the rule is repo-wide `warn`,
 * and `lint:check` runs `--quiet`, so warnings alone would print nothing.
 */
export type NotebookImportAdaptersStayNarrowed = Expect<
  0 extends 1 & NotebookImportAdapters[keyof NotebookImportAdapters] ? false : true
>;

/**
 * Fails typecheck if `adminSettings` is made optional again. Both tsconfigs exclude *.test.ts and
 * every test construction casts its adapters, so without this the required-ness is enforced by the
 * single typechecked construction in apps/client/server/s3/notebookImportComplete.ts - and a caller
 * that omits it falls back to MAX_FILE_SIZE_DEFAULT_MB, silently admitting what the upload door
 * refuses.
 */
export type NotebookImportAdminSettingsStayRequired = Expect<
  undefined extends NotebookImportAdapters['adminSettings'] ? false : true
>;

/**
 * One instance per import. The admission state below is per-import instance state, and
 * `importNotebooks` resets it on entry, so sharing one instance across concurrent imports would let
 * one run zero another run's accumulator. The live caller builds a fresh service per S3 event
 * (apps/client/server/s3/notebookImportComplete.ts).
 */
export class NotebookImportService {
  constructor(private adapters: NotebookImportAdapters) {}

  /**
   * Attachment failures. Deliberately not `errors`: the handler rolls the whole import back on a
   * non-empty `errors`, so one unreadable file would discard every notebook that imported cleanly.
   */
  private attachmentWarnings: string[] = [];

  /** Attachments actually persisted, as opposed to the count the export file claims. */
  private attachmentsWritten = 0;

  /** S3 keys of imported knowledge files, surfaced so the caller can scan them post-commit. */
  private importedKnowledgeFilePaths: string[] = [];

  /** Bytes. Resolved once per import: nothing here reacts to a setting changed mid-import, so
   * re-reading it per file would buy nothing. */
  private maxFileSize = MAX_FILE_SIZE_DEFAULT_MB * 1024 * 1024;

  /** The importing user, reused by the per-file storage-quota gate. */
  private importingUser: IUserDocument | null = null;

  /** Bytes admitted so far in THIS import. `currentStorageSize` on the user document is a snapshot
   * read once - uploaded bytes are only debited later, by the S3 objectCreated event - so several
   * files that each pass against that stale value can overshoot the quota together. Same reason as
   * the accumulator in b4m-core/slack/src/CommandHandler.ts. */
  private admittedBytes = 0;

  /**
   * The store assigns the id; anything else records a reference that resolves to nothing.
   * `normalizeId` rather than `String()`: these adapters may hand back a populated document,
   * which `String()` would turn into "[object Object]".
   */
  private takeStoreId(created: unknown, kind: string): string {
    const id = normalizeId((created as { id?: unknown } | null)?.id);
    if (!id) {
      throw new Error(`${kind} store returned no id`);
    }
    return id;
  }

  async importNotebooks(
    targetUserId: string,
    importData: NotebookExportFormat | string,
    options: NotebookImportOptions
  ): Promise<ImportResult> {
    try {
      this.adapters.logger.info('Starting notebook import', { targetUserId, options });

      // Parse import data if it's a string
      const parsedData = typeof importData === 'string' ? JSON.parse(importData) : importData;

      // Validate format
      this.validateImportData(parsedData);

      // Verify target user exists
      const targetUser = await this.adapters.userRepository.findById(targetUserId);
      if (!targetUser) {
        throw new NotebookImportError('Target user not found', 'USER_NOT_FOUND');
      }

      const result: ImportResult = {
        success: true,
        importedNotebooks: 0,
        importedMessages: 0,
        importedAttachments: 0,
        skippedNotebooks: 0,
        errors: [],
        warnings: [],
        newNotebookIds: [],
      };

      this.attachmentWarnings = [];
      this.attachmentsWritten = 0;
      this.importedKnowledgeFilePaths = [];
      // Unchecked cast: `checkStorageLimit` defaults storageLimit/currentStorageSize with `??`, so
      // a document missing them is admitted against 1000MB/0 rather than misread - fail-open, not
      // safety. Both are required on IUser, so only a lean projection or an old document gets there.
      this.importingUser = targetUser as IUserDocument;
      this.admittedBytes = 0;
      this.maxFileSize =
        getSettingsValue(
          'MaxFileSize',
          await getSettingsMap({ adminSettings: this.adapters.adminSettings }),
          MAX_FILE_SIZE_DEFAULT_MB
        ) *
        1024 *
        1024;

      // Process each notebook
      for (const notebook of parsedData.notebooks) {
        try {
          const importedNotebookId = await this.importNotebook(notebook, targetUserId, options);

          if (importedNotebookId) {
            result.importedNotebooks++;
            result.importedMessages += notebook.chatHistory.length;
            result.newNotebookIds!.push(importedNotebookId);
          } else {
            result.skippedNotebooks++;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors!.push(`Failed to import notebook "${notebook.name}": ${errorMessage}`);
          this.adapters.logger.error('Notebook import failed', {
            notebookName: notebook.name,
            error,
          });
        }
      }

      result.importedAttachments = this.attachmentsWritten;
      result.warnings!.push(...this.attachmentWarnings);
      result.importedKnowledgeFilePaths = this.importedKnowledgeFilePaths;

      // Determine overall success
      result.success = result.errors!.length === 0 || result.importedNotebooks > 0;

      this.adapters.logger.info('Notebook import completed', result);
      return result;
    } catch (error) {
      this.adapters.logger.error('Notebook import failed', { targetUserId, error });

      if (error instanceof NotebookImportError) {
        throw error;
      }

      throw new NotebookImportError('Import failed due to unexpected error', 'IMPORT_FAILED', error);
    }
  }

  private validateImportData(data: NotebookExportFormat): void {
    if (!data.exportVersion) {
      throw new NotebookImportError('Missing export version', 'INVALID_FORMAT');
    }

    if (!SUPPORTED_IMPORT_VERSIONS.includes(data.exportVersion)) {
      throw new NotebookImportError(`Unsupported export version: ${data.exportVersion}`, 'UNSUPPORTED_VERSION');
    }

    if (!data.notebooks || !Array.isArray(data.notebooks)) {
      throw new NotebookImportError('Invalid notebooks data', 'INVALID_FORMAT');
    }

    if (data.notebooks.length === 0) {
      throw new NotebookImportError('No notebooks to import', 'NO_NOTEBOOKS');
    }
  }

  private async importNotebook(
    notebook: ExportedNotebook,
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string | null> {
    // Check for existing notebook
    const existingSession = await this.findExistingSession(notebook, targetUserId, options);

    if (existingSession) {
      return this.handleExistingSession(existingSession, notebook, options);
    }

    const attachmentIds = {
      knowledgeIds: [] as string[],
      artifactIds: [] as string[],
      toolIds: [] as string[],
      agentIds: [] as string[],
    };

    const sessionData = {
      userId: targetUserId,
      name: this.generateSessionName(notebook.name, options),
      firstCreated: new Date(notebook.firstCreated),
      lastUpdated: new Date(notebook.lastUpdated),
      language: notebook.language,
      summary: notebook.summary,
      summaryAt: notebook.summaryAt ? new Date(notebook.summaryAt) : undefined,
      tags: notebook.tags || [],
      // `undefined` here and not `null`: on an insert there is nothing to clear, and a `null` would
      // claim a stamp state a never-tagged notebook never had.
      taggedAt: notebook.taggedAt ? new Date(notebook.taggedAt) : undefined,
      isAutoNamed: notebook.isAutoNamed,
      lastUsedModel: notebook.lastUsedModel,
      ...attachmentIds,
    };

    // The notebook is created BEFORE its attachments, and the id arrays are written back below.
    // An artifact records the notebook it belongs to on itself, and that `sessionId` is what the
    // viewer lists a notebook's artifacts by - `session.artifactIds` is a denormalised copy no
    // display path reads. Creating the notebook last meant there was no id to record while the
    // artifacts were being written, so every imported artifact landed unreachable and the notebook
    // opened empty on an import that reported success. Ordering is the fix; a second write is the
    // price, and both sit inside the caller's transaction.
    const createdSession = await this.adapters.sessionRepository.create(sessionData);

    if (options.importKnowledge && notebook.knowledge.length > 0) {
      attachmentIds.knowledgeIds = await this.importKnowledgeFiles(notebook.knowledge, targetUserId);
    }

    if (options.importArtifacts && notebook.artifacts.length > 0) {
      attachmentIds.artifactIds = await this.importArtifacts(
        notebook.artifacts,
        targetUserId,
        createdSession.id,
        options
      );
    }

    if (options.importTools && notebook.tools.length > 0) {
      attachmentIds.toolIds = await this.importTools(notebook.tools, targetUserId);
    }

    if (options.importAgents && notebook.agents.length > 0) {
      attachmentIds.agentIds = await this.importAgents(notebook.agents, targetUserId);
    }

    this.attachmentsWritten +=
      attachmentIds.knowledgeIds.length +
      attachmentIds.artifactIds.length +
      attachmentIds.toolIds.length +
      attachmentIds.agentIds.length;

    await this.adapters.sessionRepository.updateById(createdSession.id, attachmentIds);

    // Import chat history
    if (notebook.chatHistory.length > 0) {
      await this.importChatHistory(notebook.chatHistory, createdSession.id, targetUserId, options);
    }

    return createdSession.id;
  }

  private async findExistingSession(
    notebook: ExportedNotebook,
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<NotebookRef | null> {
    // Try to find by exact name match
    const existingSessions = await this.adapters.sessionRepository.find({
      userId: targetUserId,
      name: notebook.name,
    });

    return existingSessions.length > 0 ? existingSessions[0] : null;
  }

  private async handleExistingSession(
    existingSession: NotebookRef,
    notebook: ExportedNotebook,
    options: NotebookImportOptions
  ): Promise<string | null> {
    switch (options.conflictResolution) {
      case 'skip':
        return null;

      case 'overwrite':
        // Delete existing chat history and replace
        await this.adapters.chatHistoryRepository.deleteMany({ sessionId: existingSession.id });
        await this.importChatHistory(notebook.chatHistory, existingSession.id, existingSession.userId, options);

        // Update session metadata. The file owns this notebook's metadata, so a value it does not
        // carry is written as an explicit `null` rather than left out - mongoose deletes every
        // `undefined` from the `$set`, so an omitted field silently keeps the target's old value.
        //
        // The stamped pair is what makes that load-bearing: `spider.ts` re-tags only when
        // `!session.taggedAt`, so writing `tags: []` while leaving the target's `taggedAt` behind
        // strands the notebook - tagless, and never tagged again.
        await this.adapters.sessionRepository.updateById(existingSession.id, {
          lastUpdated: new Date(notebook.lastUpdated),
          summary: notebook.summary ?? null,
          summaryAt: notebook.summaryAt ? new Date(notebook.summaryAt) : null,
          tags: notebook.tags || [],
          taggedAt: notebook.taggedAt ? new Date(notebook.taggedAt) : null,
          // Cleared for the same reason, one gate along: the import replaces the content tagging
          // reads, so a backoff earned by the target's old content must not hold off the re-tag.
          // Not carried from the file - it is this deployment's billing state, not the notebook's.
          tagLastAttemptAt: null,
          // Not `?? null` like the pairs above: no gate keys off this field, so clearing a target's
          // last-used model because an older file omits it loses information for no gain. Omitting
          // the key means "leave it", which is what the dropped-`undefined` behaviour did anyway.
          ...(notebook.lastUsedModel !== undefined && { lastUsedModel: notebook.lastUsedModel }),
        });

        return existingSession.id;

      case 'rename': {
        // Create with renamed title
        const renamedNotebook = { ...notebook };
        renamedNotebook.name = await this.generateUniqueName(notebook.name, existingSession.userId);
        return await this.importNotebook(renamedNotebook, existingSession.userId, {
          ...options,
          conflictResolution: 'skip', // Prevent infinite recursion
        });
      }

      case 'merge':
        // Append chat history to existing session
        await this.importChatHistory(notebook.chatHistory, existingSession.id, existingSession.userId, options);

        // Update last updated time
        await this.adapters.sessionRepository.updateById(existingSession.id, {
          lastUpdated: new Date(),
        });

        return existingSession.id;

      default:
        throw new NotebookImportError(`Unknown conflict resolution: ${options.conflictResolution}`, 'INVALID_OPTION');
    }
  }

  private async importChatHistory(
    chatHistory: ExportedChatMessage[],
    sessionId: string,
    ownerUserId: string,
    options: NotebookImportOptions
  ): Promise<void> {
    const chatItems: IChatHistoryItem[] = chatHistory.map(message => ({
      // A generated id is not a valid key for the message store; omit the field so it assigns one.
      ...(options.preserveIds && message.id && { id: message.id }),
      sessionId,
      timestamp: new Date(message.timestamp),
      type: message.type,
      prompt: message.prompt,
      reply: message.reply,
      replies: message.replies,
      questMasterReply: message.questMasterReply,
      images: message.images || [],
      fabFileIds: message.attachedFiles || [],
      // The store requires the owning session on promptMeta. The export carries metrics only,
      // and an imported message belongs to the new notebook, so this is rebuilt rather than
      // carried over.
      //
      // Deliberately NOT rebindPromptMetaSession (@bike4mind/common), which fork/snip/clone use:
      // that spreads the source session block, and an import can land in a different tenant than
      // it was exported from, so organizationId/projectId must be dropped here rather than carried
      // into another org's analytics rollups. Must stay in sync with that helper's doc comment.
      promptMeta: message.promptMeta && {
        ...message.promptMeta,
        session: { id: sessionId, userId: ownerUserId },
      },
      status: message.status,
      creditsUsed: message.creditsUsed,
      pinned: message.pinned,
      agentIds: message.agentIds || [],
      questMasterPlanId: message.questMasterPlanId,
    }));

    await this.adapters.chatHistoryRepository.bulkCreate(chatItems);
  }

  private async importKnowledgeFiles(knowledgeFiles: ExportedKnowledgeFile[], targetUserId: string): Promise<string[]> {
    const importedIds: string[] = [];

    for (const file of knowledgeFiles) {
      try {
        // Not branched on `preserveIds`: reusing the source id would imply this is the same document.
        const storageKeySuffix = this.adapters.generateId();

        // The export emits a listing-only entry (real size, no content, no URL) for a held or
        // blocked image, and "neither" must be refused as that, not as oversized.
        // A URL reference is refused for what it is, above both gates. Nothing is stored on this
        // path, and the only size available for it is the client-declared `file.size`, so gating on
        // it would blame the size or quota limit for what is really an unimplemented import.
        if (!file.content && file.contentUrl) {
          // Never returns - see copyFileFromUrl. Whoever implements it has to gate and store there
          // and then continue past this block, not fall into the "no content" throw below.
          await this.copyFileFromUrl(file.contentUrl, targetUserId, storageKeySuffix);
        }
        if (!file.content) {
          throw new Error('No content or URL provided for file');
        }

        // Derived from string length alone, so nothing is allocated for a file the gates refuse -
        // decoding first would allocate the buffer for exactly the payloads this gate exists to
        // reject. The cost is that it counts characters that decode to nothing: line-wrapped base64
        // (valid MIME, though our own exporter emits it unwrapped) measures ~2.6% over its decoded
        // size and is refused that much early. Over-counting is the safe direction to refuse on but
        // not to bill, hence the separate storedSize below.
        const gatedSize = Buffer.byteLength(file.content, 'base64');

        // `>=` and the MB-to-bytes conversion match fabFileService/create.ts. The measurement does
        // not: that door gates on a caller-declared fileSize, this one on bytes it holds.
        if (gatedSize >= this.maxFileSize) {
          // Floor, not round: MaxFileSize has no `int: true`, so a 30.5MB limit would otherwise be
          // reported as 31MB - a size this gate refuses.
          throw new Error(`exceeds the ${Math.floor(this.maxFileSize / (1024 * 1024))}MB maximum file size`);
        }

        // Per-user quota, not checkStorageLimitForFile: no organizationId is plumbed through this
        // path, and the org branch would be wrong anyway - organization.currentStorageSize is never
        // incremented on upload, so uploaded bytes are debited to the user.
        if (!this.importingUser) {
          throw new Error('no importing user resolved, refusing to skip the storage quota check');
        }
        await checkStorageLimit(this.importingUser, this.admittedBytes + gatedSize);

        // Decoded once, here, and reused for the write, the accounting and the row. Booking anything
        // but the stored length breaks that: the credit reads the real object size
        // (server/s3/objectCreated.ts) while every refund reads this row's fileSize, so an
        // import-then-delete cycle would deduct bytes that were never stored.
        const bytes = Buffer.from(file.content, 'base64');
        const storedSize = bytes.byteLength;

        // The first write of any kind for this file, and deliberately below both gates: an object
        // written for a file that is then refused would sit at knowledge/<userId>/<uuid> forever -
        // no FabFile row points at it, so nothing counts it against the quota, nothing moderates
        // it, and the bucket lifecycle rules (infra/buckets.ts) do not cover this prefix.
        const filePath = `knowledge/${targetUserId}/${storageKeySuffix}`;
        await this.adapters.fileStorageService.uploadFile(filePath, bytes);

        // Charged once the upload returns, so a file that fails to store cannot spend another file's
        // headroom. Deliberately above the row write rather than below it: the bytes are in the
        // bucket either way, so a file whose row write fails has still consumed storage and must
        // still count against the files behind it.
        this.admittedBytes += storedSize;

        // No `id`: FabFile has no such path, so the store assigns one.
        const knowledgeData = {
          userId: targetUserId,
          fileName: file.name,
          mimeType: file.mimeType,
          // The stored length, not the client-declared file.size and not gatedSize - see above.
          fileSize: storedSize,
          filePath,
          type: toKnowledgeType(file.type),
          // Leave moderationStatus at the schema default ('pending'). The bytes are attacker-supplied
          // (this content came straight off an uploaded import payload, not a trusted export), so they
          // must be scanned before serving. The upload-time S3 scan cannot see this row - it is
          // written inside the import transaction and gives up ~7.5s before a real import commits - so
          // the caller re-scans every imported file out of band once this transaction commits, keyed
          // by the filePath recorded below. See server/s3/moderateImportedKnowledgeFiles.ts.
        };
        // No `uploadedAt`/`metadata`: not paths on FabFileSchema, so strict mode drops them silently.

        importedIds.push(this.takeStoreId(await this.adapters.knowledgeRepository.create(knowledgeData), 'knowledge'));
        this.importedKnowledgeFilePaths.push(filePath);

        // After the write, not before: the file has to have landed for "imported as FILE" to be
        // true, and a file that then failed would otherwise be reported twice. Absent is expected
        // of older exports; present-but-unknown is format drift worth saying.
        if (file.type && !isValidEnumValue(file.type, KnowledgeType)) {
          this.attachmentWarnings.push(`Imported "${file.name}" as FILE: unrecognised knowledge type "${file.type}"`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.attachmentWarnings.push(`Failed to import knowledge file "${file.name}": ${message}`);
        this.adapters.logger.warn('Failed to import knowledge file', {
          fileName: file.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private async importArtifacts(
    artifacts: ExportedArtifact[],
    targetUserId: string,
    sessionId: string,
    options: NotebookImportOptions
  ): Promise<string[]> {
    const importedIds: string[] = [];

    for (const artifact of artifacts) {
      try {
        // Refused rather than written as a shell: the artifact schema requires contentId, contentHash
        // and contentSize, all derived from the body, so an artifact without one could only be stored
        // as a row pointing at content that does not exist. An export taken before the export side
        // joined the body lands here.
        if (!artifact.content) {
          throw new Error('the export carries no body for this artifact');
        }

        // Truthiness, not just the flag: an export can carry an empty id, and `??` below would
        // keep it as the id to store - skipping the collision check and losing the remint, with
        // only `providedId || ...` inside the creation path to stop an empty id being written.
        const preservedId = options.preserveIds && artifact.id ? artifact.id : undefined;

        // A reminted id keeps the SOURCE identifier rather than a slug of the title, because the
        // imported reply still carries the original `<artifact identifier=...>` attribute and that
        // attribute - not the title - is what `findExistingArtifactId` compares segment 2 against.
        // The two agree only by luck (`identifier="todo-app"` for title "Todo List App" is the
        // parser's own example), and when they disagree the rendered card cannot find this row and
        // mints an id of its own, losing the version history the round trip just restored.
        const artifactType = toArtifactType(artifact.type);
        const storedId = preservedId ?? remintArtifactId(artifact.id, artifactType, artifact.name);

        // Checked before the write, not left to the catch below: re-importing an export into the
        // account it came from duplicates a unique key, and a server-side error aborts the whole
        // transaction - so the catch would log one warning while every later write failed with
        // NoSuchTransaction. Only reachable with `preserveIds`, since a minted id cannot collide.
        if (preservedId && (await this.adapters.artifactIdTaken(preservedId))) {
          throw new Error(`an artifact with id "${preservedId}" already exists`);
        }

        // The export's createdAt/updatedAt are deliberately not carried, so an imported artifact is
        // stamped at import time - unlike tools and agents below. Mongoose would honour them, but
        // artifactService.create takes no timestamps, and widening it would let any caller of the
        // artifacts API backdate a row.
        const created = await this.adapters.createArtifact({
          userId: targetUserId,
          id: storedId,
          sessionId,
          type: artifactType,
          // The export calls it `name`; the schema calls it `title`.
          title: artifact.name,
          content: artifact.content,
          metadata: artifact.metadata,
        });
        importedIds.push(this.takeStoreId(created, 'artifact'));
      } catch (error) {
        this.attachmentWarnings.push(
          `Failed to import artifact "${artifact.name}": ${error instanceof Error ? error.message : String(error)}`
        );
        this.adapters.logger.warn('Failed to import artifact', {
          artifactName: artifact.name,
          // Names are not unique within an export; the id is what ties this back to the source.
          artifactId: artifact.id,
          // The message as its own string: the logger JSON.stringifies its metadata and an Error
          // serialises to {}, so `error` alone reaches the logs empty and every refusal reads the
          // same. This is the only place the reason survives.
          reason: error instanceof Error ? error.message : String(error),
          error,
        });
      }
    }

    return importedIds;
  }

  private async importTools(tools: ExportedTool[], targetUserId: string): Promise<string[]> {
    const importedIds: string[] = [];

    for (const tool of tools) {
      try {
        // No `workBenchFiles`: it holds whole knowledge-file documents, which would need remapping
        // onto the files this import creates under new ids. Mongoose defaults it to [].
        // `description`/`configuration`/`metadata` are not ToolSchema paths and are dropped.
        const toolData = {
          userId: targetUserId,
          name: tool.name,
          description: tool.description,
          configuration: tool.configuration,
          createdAt: new Date(tool.createdAt),
          metadata: tool.metadata,
          // ToolSchema requires llmParams and no export carries one, so an imported tool takes the
          // app's declared defaults. Not `{}`: that would apply the schema's own defaults, which
          // still name gpt-3.5-turbo.
          llmParams: { ...DefaultLLMParams },
        };

        importedIds.push(this.takeStoreId(await this.adapters.toolRepository.create(toolData), 'tool'));
      } catch (error) {
        this.attachmentWarnings.push(
          `Failed to import tool "${tool.name}": ${error instanceof Error ? error.message : String(error)}`
        );
        this.adapters.logger.warn('Failed to import tool', {
          toolName: tool.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private async importAgents(agents: ExportedAgent[], targetUserId: string): Promise<string[]> {
    const importedIds: string[] = [];

    for (const agent of agents) {
      try {
        const agentData = {
          userId: targetUserId,
          name: agent.name,
          description: agent.description,
          configuration: agent.configuration,
          createdAt: new Date(agent.createdAt),
          metadata: agent.metadata,
        };

        importedIds.push(this.takeStoreId(await this.adapters.agentRepository.create(agentData), 'agent'));
      } catch (error) {
        this.attachmentWarnings.push(
          `Failed to import agent "${agent.name}": ${error instanceof Error ? error.message : String(error)}`
        );
        this.adapters.logger.warn('Failed to import agent', {
          agentName: agent.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private generateSessionName(originalName: string, options: NotebookImportOptions): string {
    if (options.namePrefix) {
      return `${options.namePrefix}${originalName}`;
    }
    return originalName;
  }

  private async generateUniqueName(baseName: string, userId: string): Promise<string> {
    let counter = 1;
    let candidateName = `${baseName} (${counter})`;

    while (true) {
      const existing = await this.adapters.sessionRepository.find({
        userId,
        name: candidateName,
      });

      if (existing.length === 0) {
        return candidateName;
      }

      counter++;
      candidateName = `${baseName} (${counter})`;
    }
  }

  private async copyFileFromUrl(_sourceUrl: string, _targetUserId: string, _newFileId: string): Promise<never> {
    // Throws rather than returning the source URL: handing back the exporter's own storage key
    // records a file the importing user has no copy of, and counts it as imported. The caller
    // turns this into a per-file warning, so the notebook still imports.
    // Whoever implements this: measure the fetched bytes and run both admission gates on them here,
    // before storing anything. The caller refuses this branch before its own gates precisely because
    // the only size it has is the client-declared one.
    throw new Error('importing a knowledge file by URL reference is not implemented');
  }
}

// Re-export types for external consumption
export * from '../notebookExportService/types';
